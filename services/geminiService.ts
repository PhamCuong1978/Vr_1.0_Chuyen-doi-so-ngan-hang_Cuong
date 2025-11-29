import { GoogleGenAI, Type } from "@google/genai";
import type { GeminiResponse, AIChatResponse, ChatMessage } from '../types';

// --- HELPER: Safe Env Getter ---
const getEnvVar = (key: string): string | undefined => {
    // 1. Thử lấy từ window.process (do index.tsx polyfill)
    if (typeof window !== 'undefined' && (window as any).process?.env?.[key]) {
        return (window as any).process.env[key];
    }
    // 2. Thử lấy trực tiếp từ process (nếu môi trường hỗ trợ Node global)
    try {
        if (typeof process !== 'undefined' && process.env?.[key]) {
            return process.env[key];
        }
    } catch (e) {}

    // 3. Thử lấy từ import.meta.env (Vite native) - fallback cuối
    try {
        const metaEnv = (import.meta as any).env;
        if (metaEnv) {
            return metaEnv[key] || metaEnv[`VITE_${key}`];
        }
    } catch (e) {}

    return undefined;
};

// --- CONFIGURATION ---
// 1. Gemini Key (Dùng cho OCR hình ảnh & Fallback Logic)
const getGeminiAI = () => {
    const apiKey = getEnvVar('API_KEY');
    
    // Kiểm tra kỹ hơn để tránh lỗi undefined hoặc key rỗng
    if (!apiKey || apiKey.trim() === "" || apiKey.includes("VITE_API_KEY")) {
        throw new Error("Lỗi API Key: Không tìm thấy 'VITE_API_KEY'. Hãy kiểm tra Settings > Environment Variables trên Vercel.");
    }

    return new GoogleGenAI({ apiKey: apiKey });
};

// 2. DeepSeek Key (Dùng cho Logic Kế toán & Chat)
const getDeepSeekKey = () => {
    const key = getEnvVar('DEEPSEEK_API_KEY');
    if (!key || key.trim() === "") {
        return null;
    }
    return key;
};

// --- HELPER: JSON CLEANER & PARSER (CRITICAL FIX) ---
/**
 * Hàm này chịu trách nhiệm trích xuất chuỗi JSON hợp lệ từ phản hồi hỗn loạn của AI.
 * Nó tìm dấu { đầu tiên và dấu } cuối cùng để loại bỏ lời dẫn chuyện.
 * UPDATE: Xử lý cả trường hợp Markdown block ```json
 */
const cleanAndParseJSON = <T>(text: string | undefined | null): T => {
    if (!text || typeof text !== 'string' || text.trim() === '') {
        throw new Error("AI trả về dữ liệu rỗng (Empty Response).");
    }

    // 1. Loại bỏ Markdown code blocks (```json ... ```)
    let cleanedText = text.replace(/```json\s*/g, "").replace(/```\s*/g, "");

    try {
        // 2. Thử parse trực tiếp
        return JSON.parse(cleanedText) as T;
    } catch (e) {
        // 3. Nếu lỗi, thử trích xuất phần nằm giữa { ... } hoặc [ ... ]
        // Tìm dấu mở { đầu tiên
        const firstOpen = cleanedText.indexOf('{');
        // Tìm dấu đóng } cuối cùng
        const lastClose = cleanedText.lastIndexOf('}');

        if (firstOpen !== -1 && lastClose !== -1 && lastClose > firstOpen) {
            const jsonSubstring = cleanedText.substring(firstOpen, lastClose + 1);
            try {
                return JSON.parse(jsonSubstring) as T;
            } catch (e2) {
                console.error("JSON Parse Error (Substring):", e2);
                // 4. Cố gắng dọn dẹp thêm các ký tự điều khiển vô hình
                const veryClean = jsonSubstring.replace(/[\u0000-\u001F\u007F-\u009F]/g, "");
                try {
                     return JSON.parse(veryClean) as T;
                } catch(e3) {
                     throw new Error(`Không thể đọc cấu trúc JSON. Phản hồi AI bị lỗi cú pháp.`);
                }
            }
        }
        
        console.error("Raw AI Text:", text);
        throw new Error("Không tìm thấy cấu trúc JSON hợp lệ trong phản hồi của AI.");
    }
};

// --- HELPER: Call DeepSeek API with Timeout ---
const callDeepSeek = async (messages: any[], jsonMode: boolean = true) => {
    const apiKey = getDeepSeekKey();
    
    if (!apiKey) {
        throw new Error("NO_DEEPSEEK_KEY");
    }

    // Tạo Controller để ngắt kết nối nếu quá lâu (60s)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);

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
            }),
            signal: controller.signal
        });

        if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            throw new Error(`DeepSeek API Error: ${errData.error?.message || response.statusText}`);
        }

        const data = await response.json();
        return data.choices[0].message.content;
    } catch (error: any) {
        if (error.name === 'AbortError') {
             console.warn("DeepSeek request timed out.");
             throw new Error("DEEPSEEK_TIMEOUT");
        }
        console.warn("DeepSeek Call Failed, switching to Fallback...", error);
        throw error;
    } finally {
        clearTimeout(timeoutId);
    }
};

/**
 * Step 1: Extracts raw text from images using GEMINI FLASH (Best for OCR/Vision).
 */
export const extractTextFromContent = async (content: { images: { mimeType: string; data: string }[] }): Promise<string> => {
    if (content.images.length === 0) return '';
    
    const prompt = `Bạn là công cụ OCR (Nhận dạng quang học) chính xác cao.
    
    NHIỆM VỤ:
    Đọc và chép lại toàn bộ văn bản, con số xuất hiện trong các hình ảnh sao kê ngân hàng này.

    QUY TẮC BẮT BUỘC (TUÂN THỦ NGHIÊM NGẶT):
    1. **RAW TEXT ONLY (CHỈ VĂN BẢN THÔ)**: Xuất ra kết quả dưới dạng từng dòng văn bản.
    2. **KHÔNG KẺ BẢNG**: Tuyệt đối KHÔNG sử dụng Markdown Table (không dùng ký tự | hay --- để vẽ khung).
    3. **KHÔNG TÓM TẮT**: Đọc thấy gì viết nấy. Nếu có 10 giao dịch, phải viết đủ 10 dòng.
    4. **GIỮ NGUYÊN SỐ LIỆU**: Không làm tròn số, giữ nguyên dấu chấm/phẩy của số tiền.
    5. Thứ tự đọc: Từ trái sang phải, từ trên xuống dưới.

    Ví dụ output mong muốn:
    01/01/2023 MBVC - Tra luong thang 1 10.000.000 VND
    02/01/2023 123456 Rut tien mat 500.000
    ...`;

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
    const prompt = `Bạn là chuyên gia kế toán. Xử lý văn bản sao kê thô sau thành JSON.
    QUY TẮC AN TOÀN (CHỐNG MẤT DỮ LIỆU):
    1. Rà soát từng dòng văn bản. Nếu dòng đó có chứa NGÀY THÁNG (DD/MM/YYYY) và SỐ TIỀN -> Đó là một giao dịch. BẮT BUỘC PHẢI LẤY.
    2. Không được gộp các giao dịch giống nhau.
    3. Tách phí/thuế ra khỏi giao dịch gốc.
    4. Giao dịch Ngân hàng ghi Nợ -> Sổ cái ghi Có (credit).
    5. Giao dịch Ngân hàng ghi Có -> Sổ cái ghi Nợ (debit).
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
    // FIX: Sử dụng hàm parse an toàn
    return cleanAndParseJSON<GeminiResponse>(response.text);
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

    QUY TẮC NGHIỆP VỤ & CHỐNG MẤT DỮ LIỆU (QUAN TRỌNG):
    1. **QUÉT TOÀN BỘ**: Đọc kỹ từng dòng văn bản. Nếu thấy định dạng ngày tháng (như 04/01/2023, 05/01/2023...) đi kèm số tiền, đó CHẮC CHẮN là giao dịch. KHÔNG ĐƯỢC BỎ QUA.
    2. **Tách Phí & Thuế**: Nếu dòng giao dịch có phí/VAT, hãy tách riêng ra khỏi số tiền gốc (\`credit\`).
    3. **Đảo Nợ/Có**: 
       - Sao kê ghi "C" (Credit/Tiền vào) -> JSON \`debit\` (Tăng tiền).
       - Sao kê ghi "D" (Debit/Tiền ra) -> JSON \`credit\` (Giảm tiền).
    4. **Chính xác tuyệt đối**: Không làm tròn số, không bỏ sót số 0.`;

    const userPrompt = `Phân tích nội dung sao kê sau và trả về JSON. Chú ý kỹ các giao dịch ngày 04/01/2023 hoặc các ngày nằm giữa:\n\n${content.text}`;

    let result: GeminiResponse;

    try {
        // Ưu tiên dùng DeepSeek
        const jsonString = await callDeepSeek([
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt }
        ]);

        result = cleanAndParseJSON<GeminiResponse>(jsonString);

    } catch (error: any) {
        console.warn("DeepSeek Error/Timeout, falling back to Gemini:", error);
        // Fallback sang Gemini nếu DeepSeek lỗi, timeout hoặc không có key
        if (error.message === "NO_DEEPSEEK_KEY" || error.message === "DEEPSEEK_TIMEOUT" || error.message.includes("DeepSeek") || error.message.includes("JSON")) {
            result = await processStatementWithGemini(content.text);
        } else {
             throw error;
        }
    }

    // --- SORTING LOGIC: Sort transactions by date ascending ---
    if (result && result.transactions && Array.isArray(result.transactions)) {
        result.transactions.sort((a, b) => {
            const parseDate = (dateStr: string) => {
                if (!dateStr) return 0;
                // Try DD/MM/YYYY
                const parts = dateStr.split('/');
                if (parts.length === 3) {
                    return new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0])).getTime();
                }
                return 0; 
            };
            return parseDate(a.date) - parseDate(b.date);
        });
    }

    return result;
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
    // FIX: Sử dụng hàm parse an toàn
    return cleanAndParseJSON<AIChatResponse>(response.text);
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

    // --- INJECT RAW CONTENT INTO SYSTEM PROMPT ---
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
    4. Nhiệm vụ quan trọng: Giúp đối chiếu dữ liệu lệch. Hãy so sánh Dữ liệu JSON hiện tại với Dữ liệu gốc (OCR Text) bên dưới để tìm nguyên nhân sai lệch.

    Dữ liệu JSON hiện tại (đã xử lý): ${JSON.stringify(currentReport)}
    
    Dữ liệu gốc (OCR Text) từ sao kê:
    -----------------------------------
    ${rawStatementContent}
    -----------------------------------
    `;

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

        // FIX: Sử dụng hàm parse an toàn
        return cleanAndParseJSON<AIChatResponse>(jsonString);

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