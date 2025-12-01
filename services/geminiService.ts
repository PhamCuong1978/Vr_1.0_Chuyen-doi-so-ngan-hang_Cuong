import { GoogleGenAI, Type } from "@google/genai";
import type { GeminiResponse, AIChatResponse, ChatMessage, Transaction } from '../types';

// --- HELPER: Safe Env Getter ---
const getEnvVar = (key: string): string | undefined => {
    if (typeof window !== 'undefined' && (window as any).process?.env?.[key]) {
        return (window as any).process.env[key];
    }
    try {
        if (typeof process !== 'undefined' && process.env?.[key]) {
            return process.env[key];
        }
    } catch (e) {}
    try {
        const metaEnv = (import.meta as any).env;
        if (metaEnv) {
            return metaEnv[key] || metaEnv[`VITE_${key}`];
        }
    } catch (e) {}
    return undefined;
};

// --- CONFIGURATION ---
const getGeminiAI = () => {
    const apiKey = getEnvVar('API_KEY');
    if (!apiKey || apiKey.trim() === "" || apiKey.includes("VITE_API_KEY")) {
        throw new Error("Lỗi API Key: Không tìm thấy 'VITE_API_KEY'.");
    }
    return new GoogleGenAI({ apiKey: apiKey });
};

const getDeepSeekKey = () => {
    const key = getEnvVar('DEEPSEEK_API_KEY');
    if (!key || key.trim() === "") {
        return null;
    }
    return key;
};

// --- HELPER: JSON CLEANER & PARSER (ROBUST v2) ---
const cleanAndParseJSON = <T>(text: string | undefined | null): T => {
    if (!text || typeof text !== 'string' || text.trim() === '') {
        throw new Error("AI trả về dữ liệu rỗng (Empty Response).");
    }

    const repairSyntax = (str: string): string => {
        let fixed = str;
        fixed = fixed.replace(/```json/g, "").replace(/```/g, "");
        fixed = fixed.replace(/\/\/.*$/gm, "");
        fixed = fixed.replace(/}\s*{/g, "},{");
        fixed = fixed.replace(/]\s*\[/g, "],[");
        fixed = fixed.replace(/("\s*|\d+\s*|true\s*|false\s*|null\s*)\s+"([a-zA-Z0-9_]+":)/g, '$1,$2');
        fixed = fixed.replace(/:\s*"?(\d{1,3}(\.\d{3})+)"?\s*(?=[,}])/g, (match, p1) => ":" + p1.replace(/\./g, ''));
        fixed = fixed.replace(/,\s*([}\]])/g, "$1");
        fixed = fixed.replace(/[\u0000-\u0019]+/g, "");
        return fixed.trim();
    };

    const balanceBraces = (str: string): string => {
        let openBraces = 0;
        let openBrackets = 0;
        let inString = false;
        let escaped = false;

        for (let i = 0; i < str.length; i++) {
            const char = str[i];
            if (char === '\\' && !escaped) { escaped = true; continue; }
            if (char === '"' && !escaped) { inString = !inString; }
            escaped = false;
            if (!inString) {
                if (char === '{') openBraces++;
                if (char === '}') openBraces--;
                if (char === '[') openBrackets++;
                if (char === ']') openBrackets--;
            }
        }
        if (inString) str += '"';
        while (openBraces > 0) { str += "}"; openBraces--; }
        while (openBrackets > 0) { str += "]"; openBrackets--; }
        return str;
    };

    const attemptParse = (raw: string): T => {
        let currentStr = repairSyntax(raw);
        try {
            return JSON.parse(currentStr) as T;
        } catch (e1) {
            const firstOpen = currentStr.indexOf('{');
            const lastClose = currentStr.lastIndexOf('}');
            if (firstOpen !== -1 && lastClose > firstOpen) {
                try {
                    return JSON.parse(currentStr.substring(firstOpen, lastClose + 1)) as T;
                } catch(e2) {}
            }
            if (firstOpen !== -1) {
                try {
                    let subStr = currentStr.substring(firstOpen);
                    let balanced = balanceBraces(subStr);
                    return JSON.parse(balanced) as T;
                } catch (e3) {}
            }
            throw e1;
        }
    };

    try {
        return attemptParse(text);
    } catch (e) {
        const err = e as Error;
        console.error("Final JSON Parse Error:", err.message);
        throw new Error(`Lỗi đọc dữ liệu AI: ${err.message}.`);
    }
};

// --- HELPER: Call DeepSeek API ---
const callDeepSeek = async (messages: any[], jsonMode: boolean = true) => {
    const apiKey = getDeepSeekKey();
    if (!apiKey) throw new Error("NO_DEEPSEEK_KEY");

    try {
        const response = await fetch("https://api.deepseek.com/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: "deepseek-chat",
                messages: messages,
                temperature: 0.1,
                response_format: jsonMode ? { type: "json_object" } : { type: "text" },
                stream: false,
                max_tokens: 8000
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

export const extractTextFromContent = async (content: { images: { mimeType: string; data: string }[] }): Promise<string> => {
    if (content.images.length === 0) return '';
    const prompt = `Bạn là công cụ OCR. Đọc toàn bộ văn bản trong ảnh. Giữ nguyên số liệu.`;
    try {
        const ai = getGeminiAI();
        const imageParts = content.images.map(img => ({ inlineData: { mimeType: img.mimeType, data: img.data } }));
        const modelRequest = {
            model: "gemini-2.5-flash", 
            contents: { parts: [{ text: prompt }, ...imageParts] },
            config: { temperature: 0 }
        };
        const response = await ai.models.generateContent(modelRequest);
        return (response.text || '').trim();
    } catch (error) {
        throw error;
    }
}

// --- CORE: GEMINI FALLBACK LOGIC ---
const responseSchema = {
  type: Type.OBJECT,
  properties: {
    openingBalance: { type: Type.NUMBER },
    endingBalance: { type: Type.NUMBER },
    accountInfo: {
      type: Type.OBJECT,
      properties: { accountName: { type: Type.STRING }, accountNumber: { type: Type.STRING }, bankName: { type: Type.STRING }, branch: { type: Type.STRING } },
      required: ["accountName", "accountNumber", "bankName", "branch"],
    },
    transactions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: { transactionCode: { type: Type.STRING }, date: { type: Type.STRING }, description: { type: Type.STRING }, debit: { type: Type.NUMBER }, credit: { type: Type.NUMBER }, fee: { type: Type.NUMBER }, vat: { type: Type.NUMBER } },
        required: ["date", "description", "debit", "credit"],
      },
    },
  },
  required: ["accountInfo", "transactions"],
};

const processStatementWithGemini = async (text: string, isPartial: boolean = false): Promise<GeminiResponse> => {
    const ai = getGeminiAI();
    const prompt = `Bạn là chuyên gia kế toán. Xử lý phần văn bản sao kê này thành JSON.
    ${isPartial ? 'LƯU Ý: Đây chỉ là một phần của sao kê dài. Hãy tập trung trích xuất Giao dịch. Nếu không thấy thông tin tài khoản hoặc số dư đầu kỳ/cuối kỳ ở phần này, hãy trả về 0 hoặc chuỗi rỗng.' : ''}
    
    QUY TẮC ĐẢO NGƯỢC NỢ/CÓ:
    - Sao kê ghi "Có" (Credit/Tiền vào) -> JSON 'debit'.
    - Sao kê ghi "Nợ" (Debit/Tiền ra) -> JSON 'credit'.
    
    ĐỊNH DẠNG SỐ: Number chuẩn (1000000), KHÔNG dùng dấu chấm/phẩy phân cách.
    
    Nội dung: ${text}`;

    try {
        const response = await ai.models.generateContent({
            model: "gemini-3-pro-preview", 
            contents: prompt,
            config: { responseMimeType: "application/json", responseSchema: responseSchema, temperature: 0 },
        });
        return cleanAndParseJSON<GeminiResponse>(response.text);
    } catch (error) {
        const responseFallback = await ai.models.generateContent({
            model: "gemini-2.5-flash", 
            contents: prompt,
            config: { responseMimeType: "application/json", responseSchema: responseSchema, temperature: 0 },
        });
        return cleanAndParseJSON<GeminiResponse>(responseFallback.text);
    }
};

/**
 * Xử lý một phần (chunk) dữ liệu.
 */
export const processStatement = async (content: { text: string; }, isPartial: boolean = false): Promise<GeminiResponse> => {
    const systemPrompt = `Bạn là Chuyên gia Kế toán (ACCAR). Chuyển đổi sao kê thành JSON.
    ${isPartial ? 'LƯU Ý: Đây là một phần dữ liệu được cắt nhỏ. Hãy trích xuất tối đa giao dịch tìm thấy. Nếu thiếu Header (Tên TK) hoặc Footer (Số dư), hãy để trống.' : ''}

    SCHEMA JSON:
    {
        "openingBalance": number, // Default 0
        "endingBalance": number, // Default 0
        "accountInfo": { "accountName": "", "accountNumber": "", "bankName": "", "branch": "" },
        "transactions": [
            { "transactionCode": "...", "date": "DD/MM/YYYY", "description": "No newline", "debit": 0, "credit": 0, "fee": 0, "vat": 0 }
        ]
    }

    QUY TẮC VÀNG:
    1. 1000000 (Không chấm phẩy).
    2. Ngân hàng Credit -> Sổ cái debit. Ngân hàng Debit -> Sổ cái credit.
    3. Không bỏ sót giao dịch nào trong đoạn văn bản này.`;

    const userPrompt = `Dữ liệu sao kê (Phần ${isPartial ? 'cắt nhỏ' : 'đầy đủ'}):\n\n${content.text}`;

    try {
        const jsonString = await callDeepSeek([
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt }
        ]);
        return cleanAndParseJSON<GeminiResponse>(jsonString);
    } catch (error: any) {
        return await processStatementWithGemini(content.text, isPartial);
    }
};

/**
 * MỚI: Hàm Quản lý Xử lý Hàng loạt (Batch Processing Manager)
 * Nhận vào danh sách các chunks (Text hoặc Image Base64) và xử lý tuần tự.
 */
export const processBatchData = async (
    chunks: { type: 'text' | 'image', data: string }[],
    onProgress: (current: number, total: number) => void
): Promise<GeminiResponse> => {
    
    let combinedTransactions: Transaction[] = [];
    let finalAccountInfo = { accountName: '', accountNumber: '', bankName: '', branch: '' };
    let finalOpeningBalance = 0;
    let finalEndingBalance = 0;
    let foundAccountInfo = false;
    let foundOpening = false;

    for (let i = 0; i < chunks.length; i++) {
        onProgress(i + 1, chunks.length); // Cập nhật tiến trình
        const chunk = chunks[i];
        let result: GeminiResponse;

        try {
            if (chunk.type === 'text') {
                result = await processStatement({ text: chunk.data }, true);
            } else {
                // Nếu là ảnh, OCR trước rồi mới process, hoặc gửi ảnh trực tiếp cho Gemini Vision (tối ưu hơn)
                // Ở đây ta dùng cách an toàn: OCR text -> Process Text để thống nhất logic
                const text = await extractTextFromContent({ images: [{ mimeType: 'image/jpeg', data: chunk.data }] });
                result = await processStatement({ text: text }, true);
            }

            // --- MERGING LOGIC (GỘP DỮ LIỆU) ---
            
            // 1. Gộp giao dịch
            if (result.transactions && Array.isArray(result.transactions)) {
                combinedTransactions = [...combinedTransactions, ...result.transactions];
            }

            // 2. Lấy thông tin tài khoản (Ưu tiên chunk đầu tiên hoặc chunk nào có dữ liệu đầy đủ)
            if (!foundAccountInfo && result.accountInfo && result.accountInfo.accountNumber) {
                finalAccountInfo = result.accountInfo;
                foundAccountInfo = true;
            }

            // 3. Lấy số dư đầu kỳ (Thường ở chunk đầu)
            if (!foundOpening && result.openingBalance !== undefined && result.openingBalance !== 0) {
                finalOpeningBalance = result.openingBalance;
                foundOpening = true;
            }

            // 4. Lấy số dư cuối kỳ (Cập nhật liên tục, lấy giá trị của chunk cuối cùng tìm thấy)
            if (result.endingBalance !== undefined && result.endingBalance !== 0) {
                finalEndingBalance = result.endingBalance;
            }

        } catch (err) {
            console.error(`Lỗi xử lý phần ${i + 1}:`, err);
            // Không throw lỗi chết chương trình, chỉ log và tiếp tục các phần khác
        }
    }

    // Sort lại toàn bộ giao dịch sau khi gộp
    combinedTransactions.sort((a, b) => {
        const parseDate = (dateStr: string) => {
            if (!dateStr) return 0;
            const parts = dateStr.split('/');
            return parts.length === 3 ? new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0])).getTime() : 0;
        };
        return parseDate(a.date) - parseDate(b.date);
    });

    return {
        accountInfo: finalAccountInfo,
        transactions: combinedTransactions,
        openingBalance: finalOpeningBalance,
        endingBalance: finalEndingBalance
    };
};

// --- CHAT (Giữ nguyên) ---
const chatResponseSchema = {
    type: Type.OBJECT,
    properties: {
        responseText: { type: Type.STRING },
        action: { type: Type.STRING },
        update: { type: Type.OBJECT, nullable: true, properties: { index: { type: Type.NUMBER }, field: { type: Type.STRING }, newValue: { type: Type.NUMBER } } },
        add: { type: Type.OBJECT, nullable: true, properties: { transactionCode: { type: Type.STRING }, date: { type: Type.STRING }, description: { type: Type.STRING }, debit: { type: Type.NUMBER }, credit: { type: Type.NUMBER }, fee: { type: Type.NUMBER }, vat: { type: Type.NUMBER } } },
        confirmationRequired: { type: Type.BOOLEAN, nullable: true },
    },
    required: ["responseText", "action"],
};

const chatWithGemini = async (promptParts: any[]): Promise<AIChatResponse> => {
    const ai = getGeminiAI();
    try {
        const response = await ai.models.generateContent({
            model: "gemini-3-pro-preview", contents: { parts: promptParts },
            config: { responseMimeType: "application/json", responseSchema: chatResponseSchema, temperature: 0.1 },
        });
        return cleanAndParseJSON<AIChatResponse>(response.text);
    } catch (error) {
        const response = await ai.models.generateContent({
            model: "gemini-2.5-flash", contents: { parts: promptParts },
            config: { responseMimeType: "application/json", responseSchema: chatResponseSchema, temperature: 0.1 },
        });
        return cleanAndParseJSON<AIChatResponse>(response.text);
    }
}

export const chatWithAI = async (message: string, currentReport: GeminiResponse, chatHistory: ChatMessage[], rawStatementContent: string, image: { mimeType: string; data: string } | null): Promise<AIChatResponse> => {
    const systemPrompt = `Bạn là Trợ lý Kế toán. Trả về JSON. Dữ liệu: ${JSON.stringify(currentReport)}`;
    try {
        if (image) throw new Error("IMAGE_DETECTED");
        const formattedHistory = chatHistory.map(msg => ({ role: msg.role === 'model' ? 'assistant' : 'user', content: msg.content }));
        const jsonString = await callDeepSeek([{ role: "system", content: systemPrompt }, ...formattedHistory, { role: "user", content: message }], true);
        return cleanAndParseJSON<AIChatResponse>(jsonString);
    } catch (error: any) {
        const geminiPromptParts: any[] = [{ text: systemPrompt + `\nChat: ${JSON.stringify(chatHistory)}\nUser: ${message}` }];
        if (image) geminiPromptParts.push({ inlineData: { mimeType: image.mimeType, data: image.data } });
        return await chatWithGemini(geminiPromptParts);
    }
};