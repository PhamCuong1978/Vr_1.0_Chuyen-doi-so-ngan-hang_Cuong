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

// --- HELPER: UTIL FUNCTIONS ---
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Hàm bọc Retry: Tự động thử lại nếu API báo bận (429) hoặc lỗi mạng
const callWithRetry = async <T>(fn: () => Promise<T>, retries = 3, delayMs = 4000): Promise<T> => {
    try {
        return await fn();
    } catch (error: any) {
        // Kiểm tra kỹ các dạng lỗi Rate Limit của Google
        const errorMessage = typeof error === 'object' ? JSON.stringify(error) : String(error);
        const isRateLimit = errorMessage.includes('429') || 
                            errorMessage.includes('RESOURCE_EXHAUSTED') || 
                            errorMessage.includes('quota') ||
                            (error.status === 429);
        
        const isOverloaded = errorMessage.includes('503') || 
                             errorMessage.includes('Overloaded') ||
                             (error.status === 503);
        
        if (retries > 0 && (isRateLimit || isOverloaded)) {
            console.warn(`⚠️ API Busy/Limit (429/503). Retrying in ${delayMs/1000}s... (${retries} left)`);
            await delay(delayMs);
            // Tăng thời gian chờ theo cấp số nhân (Exponential Backoff) để tránh spam
            return callWithRetry(fn, retries - 1, delayMs * 2); 
        }
        throw error;
    }
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

    return callWithRetry(async () => {
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
            // Nếu 429 hoặc 5xx, ném lỗi để hàm retry bắt được
            if (response.status === 429 || response.status >= 500) {
                 throw new Error(`DeepSeek Server Error: ${response.status}`);
            }
            throw new Error(`DeepSeek API Error: ${errData.error?.message || response.statusText}`);
        }

        const data = await response.json();
        return data.choices[0].message.content;
    });
};

export const extractTextFromContent = async (content: { images: { mimeType: string; data: string }[] }): Promise<string> => {
    if (content.images.length === 0) return '';
    const prompt = `Bạn là công cụ OCR. Đọc toàn bộ văn bản trong ảnh. Giữ nguyên số liệu.`;
    
    return callWithRetry(async () => {
        const ai = getGeminiAI();
        const imageParts = content.images.map(img => ({ inlineData: { mimeType: img.mimeType, data: img.data } }));
        const modelRequest = {
            model: "gemini-2.5-flash", // Flash xử lý ảnh tốt và nhanh
            contents: { parts: [{ text: prompt }, ...imageParts] },
            config: { temperature: 0 }
        };
        const response = await ai.models.generateContent(modelRequest);
        return (response.text || '').trim();
    }, 3, 5000); // OCR tốn tài nguyên, retry chậm hơn
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

    // CHIẾN LƯỢC MỚI: Ưu tiên Gemini Flash trước (Nhanh, Limit cao hơn).
    // Chỉ fallback sang Pro nếu cần thiết.
    try {
        return await callWithRetry(async () => {
            const response = await ai.models.generateContent({
                model: "gemini-2.5-flash", 
                contents: prompt,
                config: { responseMimeType: "application/json", responseSchema: responseSchema, temperature: 0 },
            });
            return cleanAndParseJSON<GeminiResponse>(response.text);
        }, 3, 4000); // Retry 3 lần, bắt đầu delay 4s
    } catch (error) {
        console.warn("Gemini Flash Failed/Limited, switching to Pro...", error);
        // Fallback sang Gemini Pro (Thông minh hơn nhưng chậm/đắt hơn)
        return await callWithRetry(async () => {
            const responseFallback = await ai.models.generateContent({
                model: "gemini-3-pro-preview", 
                contents: prompt,
                config: { responseMimeType: "application/json", responseSchema: responseSchema, temperature: 0 },
            });
            return cleanAndParseJSON<GeminiResponse>(responseFallback.text);
        }, 2, 6000); // Delay lâu hơn cho Pro
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

    // Rate Limit Config
    // Tăng thời gian chờ mặc định lên 4000ms (4 giây) để đảm bảo an toàn cho quota RPM (15 RPM).
    const BASE_DELAY = 4000; 

    for (let i = 0; i < chunks.length; i++) {
        onProgress(i + 1, chunks.length); // Cập nhật tiến trình
        
        // --- RATE LIMIT PROTECTION ---
        if (i > 0) {
            await delay(BASE_DELAY);
        }

        const chunk = chunks[i];
        let result: GeminiResponse | null = null;

        try {
            if (chunk.type === 'text') {
                result = await processStatement({ text: chunk.data }, true);
            } else {
                // Nếu là ảnh, OCR trước rồi mới process
                const text = await extractTextFromContent({ images: [{ mimeType: 'image/jpeg', data: chunk.data }] });
                result = await processStatement({ text: text }, true);
            }
        } catch (err: any) {
            console.error(`Lỗi xử lý phần ${i + 1}:`, err);
            
            // Nếu lỗi là 429 (Too Many Requests), hãy nghỉ ngơi lâu hơn trước khi tiếp tục các phần sau (nếu có)
            const errorMessage = JSON.stringify(err);
            if (errorMessage.includes('429') || errorMessage.includes('RESOURCE_EXHAUSTED')) {
                console.warn("Phát hiện Rate Limit, tạm dừng 10s để hồi phục...");
                await delay(10000); 
            }
            // Không throw lỗi chết chương trình, tiếp tục vòng lặp để cứu dữ liệu các phần khác
        }

        if (result) {
            // --- MERGING LOGIC (GỘP DỮ LIỆU) ---
            if (result.transactions && Array.isArray(result.transactions)) {
                combinedTransactions = [...combinedTransactions, ...result.transactions];
            }

            if (!foundAccountInfo && result.accountInfo && result.accountInfo.accountNumber) {
                finalAccountInfo = result.accountInfo;
                foundAccountInfo = true;
            }

            if (!foundOpening && result.openingBalance !== undefined && result.openingBalance !== 0) {
                finalOpeningBalance = result.openingBalance;
                foundOpening = true;
            }

            if (result.endingBalance !== undefined && result.endingBalance !== 0) {
                finalEndingBalance = result.endingBalance;
            }
        }
    }

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

// --- CHAT ---
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
    return callWithRetry(async () => {
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
    });
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