import { GoogleGenAI, Type } from "@google/genai";
import type { GeminiResponse, AIChatResponse, ChatMessage } from '../types';

// --- CONFIGURATION ---
// 1. Gemini Key (Dùng cho OCR hình ảnh & Fallback Logic)
const getGeminiAI = () => {
    // API key must be obtained exclusively from process.env.API_KEY
    return new GoogleGenAI({ apiKey: process.env.API_KEY });
};

// 2. DeepSeek Key (Dùng cho Logic Kế toán & Chat)
const getDeepSeekKey = () => {
    const key = process.env.DEEPSEEK_API_KEY;
    if (!key || key === "") {
        return null;
    }
    return key;
};

// --- HELPER: Call DeepSeek API ---
const callDeepSeek = async (messages: any[], jsonMode: boolean = true) => {
    const apiKey = getDeepSeekKey();
    
    if (!apiKey) {
        throw new Error("NO_DEEPSEEK_KEY");
    }

    try {
        const response = await fetch("https://api.deepseek.com/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: "deepseek-chat", // DeepSeek V3
                messages: messages,
                temperature: 0.1, // Low temp for logic
                response_format: jsonMode ? { type: "json_object" } : { type: "text" },
                stream: false
            })
        });

        if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            throw new Error(`DeepSeek API Error: ${errData.error?.message || response.statusText}`);
        }

        const data = await response.json();
        return data.choices[0].message.content;
    } catch (error) {
        console.warn("DeepSeek Call Failed, switching to Fallback...", error);
        throw error;
    }
};

/**
 * Step 1: Extracts raw text from images using GEMINI FLASH (Best for OCR/Vision).
 */
export const extractTextFromContent = async (content: { images: { mimeType: string; data: string }[] }): Promise<string> => {
    if (content.images.length === 0) return '';
    
    const prompt = `Bạn là công cụ OCR tài chính. Nhiệm vụ: Trích xuất toàn bộ văn bản từ sao kê ngân hàng.
    QUY TẮC:
    1. Giữ nguyên định dạng số (dấu chấm/phẩy).
    2. Tuyệt đối không bỏ sót số 0 (Ví dụ: 3,000,000 là ba triệu, không phải ba trăm).
    3. Chỉ trả về văn bản thô, không thêm lời dẫn.`;

    try {
        const ai = getGeminiAI();
        const imageParts = content.images.map(img => ({
            inlineData: {
                mimeType: img.mimeType,
                data: img.data,
            }
        }));

        const modelRequest = {
            model: "gemini-2.5-flash", // Flash cực nhanh và rẻ cho OCR
            contents: { parts: [{ text: prompt }, ...imageParts] },
            config: { temperature: 0 }
        };

        const response = await ai.models.generateContent(modelRequest);
        return (response.text || '').trim();
    } catch (error) {
        console.error("OCR Failed:", error);
        throw error;
    }
}

// --- GEMINI FALLBACK LOGIC ---
const responseSchema = {
  type: Type.OBJECT,
  properties: {
    openingBalance: { type: Type.NUMBER },
    endingBalance: { type: Type.NUMBER },
    accountInfo: {
      type: Type.OBJECT,
      properties: {
        accountName: { type: Type.STRING },
        accountNumber: { type: Type.STRING },
        bankName: { type: Type.STRING },
        branch: { type: Type.STRING },
      },
      required: ["accountName", "accountNumber", "bankName", "branch"],
    },
    transactions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          transactionCode: { type: Type.STRING },
          date: { type: Type.STRING },
          description: { type: Type.STRING },
          debit: { type: Type.NUMBER },
          credit: { type: Type.NUMBER },
          fee: { type: Type.NUMBER },
          vat: { type: Type.NUMBER },
        },
        required: ["date", "description", "debit", "credit"],
      },
    },
  },
  required: ["accountInfo", "transactions", "openingBalance", "endingBalance"],
};

const processStatementWithGemini = async (text: string): Promise<GeminiResponse> => {
    console.log("Using Gemini Fallback for Processing...");
    const ai = getGeminiAI();
    const prompt = `Bạn là chuyên gia kế toán. Xử lý sao kê sau thành JSON:
    1. Tách phí/thuế ra khỏi giao dịch gốc.
    2. Giao dịch Ngân hàng ghi Nợ -> Sổ cái ghi Có (credit).
    3. Giao dịch Ngân hàng ghi Có -> Sổ cái ghi Nợ (debit).
    4. Trích xuất số dư đầu/cuối kỳ.
    Nội dung: ${text}`;

    const modelRequest = {
      model: "gemini-3-pro-preview", // Use Pro for Logic fallback
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: responseSchema,
        temperature: 0,
      },
    };

    const response = await ai.models.generateContent(modelRequest);
    return JSON.parse(response.text || '{}') as GeminiResponse;
};

/**
 * Step 2: Processes the extracted text using DEEPSEEK V3 (with Gemini Fallback).
 */
export const processStatement = async (content: { text: string; }): Promise<GeminiResponse> => {
    const systemPrompt = `Bạn là Chuyên gia Kế toán Cao cấp (ACCAR). Nhiệm vụ: Chuyển đổi văn bản sao kê ngân hàng thô thành JSON cấu trúc sổ cái.

    CẤU TRÚC JSON BẮT BUỘC (RESPONSE SCHEMA):
    {
        "openingBalance": number, // Số dư đầu kỳ (tìm kỹ, mặc định 0)
        "endingBalance": number, // Số dư cuối kỳ (tìm kỹ, mặc định 0)
        "accountInfo": {
            "accountName": string,
            "accountNumber": string,
            "bankName": string,
            "branch": string
        },
        "transactions": [
            {
                "transactionCode": string,
                "date": string, // DD/MM/YYYY
                "description": string,
                "debit": number, // Tiền vào (Ngân hàng ghi Có -> Sổ cái ghi Nợ)
                "credit": number, // Tiền ra GỐC (Ngân hàng ghi Nợ -> Sổ cái ghi Có). KHÔNG bao gồm phí/thuế.
                "fee": number, // Phí giao dịch tách riêng
                "vat": number // Thuế tách riêng
            }
        ]
    }

    QUY TẮC NGHIỆP VỤ (QUAN TRỌNG):
    1. **Tách Phí & Thuế**: Nếu dòng giao dịch có phí/VAT, hãy tách riêng ra khỏi số tiền gốc (\`credit\`).
    2. **Định dạng Số**: Xử lý dấu phân cách ngàn (,) và thập phân (.) theo chuẩn Việt Nam.
    3. **Đảo Nợ/Có**: 
       - Sao kê ghi "C" (Credit/Tiền vào) -> JSON \`debit\` (Tăng tiền).
       - Sao kê ghi "D" (Debit/Tiền ra) -> JSON \`credit\` (Giảm tiền).
    4. **Chính xác tuyệt đối**: Không làm tròn số, không bỏ sót số 0.`;

    const userPrompt = `Phân tích nội dung sao kê sau và trả về JSON:\n\n${content.text}`;

    try {
        // Ưu tiên dùng DeepSeek
        const jsonString = await callDeepSeek([
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt }
        ]);

        if (!jsonString) throw new Error("DeepSeek trả về rỗng.");
        const cleanJson = jsonString.replace(/```json/g, '').replace(/```/g, '').trim();
        return JSON.parse(cleanJson) as GeminiResponse;

    } catch (error: any) {
        // Fallback sang Gemini nếu DeepSeek lỗi hoặc không có key
        if (error.message === "NO_DEEPSEEK_KEY" || error.message.includes("DeepSeek")) {
            return await processStatementWithGemini(content.text);
        }
        throw error;
    }
};

// --- GEMINI CHAT FALLBACK ---
const chatResponseSchema = {
    type: Type.OBJECT,
    properties: {
        responseText: { type: Type.STRING },
        action: { type: Type.STRING },
        update: {
            type: Type.OBJECT,
            nullable: true,
            properties: { index: { type: Type.NUMBER }, field: { type: Type.STRING }, newValue: { type: Type.NUMBER } },
        },
        add: {
            type: Type.OBJECT,
            nullable: true,
            properties: {
                transactionCode: { type: Type.STRING }, date: { type: Type.STRING }, description: { type: Type.STRING },
                debit: { type: Type.NUMBER }, credit: { type: Type.NUMBER }, fee: { type: Type.NUMBER }, vat: { type: Type.NUMBER },
            },
        },
        confirmationRequired: { type: Type.BOOLEAN, nullable: true },
    },
    required: ["responseText", "action"],
};

const chatWithGemini = async (promptParts: any[]): Promise<AIChatResponse> => {
    console.log("Using Gemini Fallback for Chat...");
    const ai = getGeminiAI();
    const modelRequest = {
        model: "gemini-3-pro-preview",
        contents: { parts: promptParts },
        config: {
            responseMimeType: "application/json",
            responseSchema: chatResponseSchema,
            temperature: 0.1,
        },
    };
    const response = await ai.models.generateContent(modelRequest);
    return JSON.parse(response.text || '{}') as AIChatResponse;
}

/**
 * Chat Assistant using DEEPSEEK V3 (with Gemini Fallback).
 */
export const chatWithAI = async (
    message: string,
    currentReport: GeminiResponse,
    chatHistory: ChatMessage[],
    rawStatementContent: string,
    image: { mimeType: string; data: string } | null
): Promise<AIChatResponse> => {

    const systemPrompt = `Bạn là "Trợ lý Kế toán của Anh Cường".
    1. Luôn xưng "Em", gọi "Anh Cường".
    2. Trả về JSON theo schema sau:
    {
        "responseText": string,
        "action": "update" | "undo" | "add" | "query",
        "update": { "index": number, "field": string, "newValue": number } | null,
        "add": { ...Transaction object... } | null,
        "confirmationRequired": boolean
    }
    3. Nếu sửa/thêm -> confirmationRequired=true.
    Dữ liệu hiện tại: ${JSON.stringify(currentReport)}`;

    try {
        // DeepSeek Chat Attempt
        // Lưu ý: DeepSeek không nhận ảnh, nếu có ảnh -> Fallback ngay sang Gemini
        if (image) {
            throw new Error("IMAGE_DETECTED");
        }

        const formattedHistory = chatHistory.map(msg => ({
            role: msg.role === 'model' ? 'assistant' : 'user',
            content: msg.content
        }));

        const jsonString = await callDeepSeek([
            { role: "system", content: systemPrompt },
            ...formattedHistory,
            { role: "user", content: message }
        ], true);

        const cleanJson = jsonString.replace(/```json/g, '').replace(/```/g, '').trim();
        return JSON.parse(cleanJson) as AIChatResponse;

    } catch (error: any) {
        // Fallback Logic
        const geminiPromptParts: any[] = [{ text: systemPrompt + `\nLịch sử chat: ${JSON.stringify(chatHistory)}\nYêu cầu: ${message}` }];
        if (image) {
            geminiPromptParts.push({ text: "Hình ảnh đính kèm:" });
            geminiPromptParts.push({ inlineData: { mimeType: image.mimeType, data: image.data } });
        }
        return await chatWithGemini(geminiPromptParts);
    }
};
