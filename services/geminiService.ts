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
    // OCR vẫn cần Gemini Flash vì DeepSeek không đọc được ảnh
    if (!apiKey || apiKey.trim() === "" || apiKey.includes("VITE_API_KEY")) {
        throw new Error("Cần API Key của Google để đọc nội dung hình ảnh (DeepSeek chưa hỗ trợ Vision).");
    }
    return new GoogleGenAI({ apiKey: apiKey });
};

const getDeepSeekKey = () => {
    const key = getEnvVar('DEEPSEEK_API_KEY');
    if (!key || key.trim() === "") {
        throw new Error("Chưa cấu hình DEEPSEEK_API_KEY. Vui lòng thêm key vào biến môi trường.");
    }
    return key;
};

// --- HELPER: UTIL FUNCTIONS ---
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Hàm bọc Retry
const callWithRetry = async <T>(fn: () => Promise<T>, retries = 3, delayMs = 2000): Promise<T> => {
    try {
        return await fn();
    } catch (error: any) {
        const errorMessage = typeof error === 'object' ? JSON.stringify(error) : String(error);
        const isServerBusy = errorMessage.includes('503') || errorMessage.includes('429') || errorMessage.includes('Overloaded');
        
        if (retries > 0 && isServerBusy) {
            console.warn(`⚠️ DeepSeek/API Busy. Retrying in ${delayMs/1000}s... (${retries} left)`);
            await delay(delayMs);
            return callWithRetry(fn, retries - 1, delayMs * 2); 
        }
        throw error;
    }
};

// --- HELPER: JSON CLEANER & PARSER ---
const cleanAndParseJSON = <T>(text: string | undefined | null): T => {
    if (!text || typeof text !== 'string' || text.trim() === '') {
        throw new Error("AI trả về dữ liệu rỗng.");
    }

    const repairSyntax = (str: string): string => {
        let fixed = str;
        fixed = fixed.replace(/```json/g, "").replace(/```/g, "");
        fixed = fixed.replace(/\/\/.*$/gm, "");
        return fixed.trim();
    };

    try {
        // DeepSeek thường trả về JSON rất chuẩn, nhưng vẫn cần đề phòng
        const cleaned = repairSyntax(text);
        // Tìm block JSON {} hoặc [] đầu tiên và cuối cùng
        const firstOpen = cleaned.indexOf('{');
        const lastClose = cleaned.lastIndexOf('}');
        if (firstOpen !== -1 && lastClose > firstOpen) {
            return JSON.parse(cleaned.substring(firstOpen, lastClose + 1)) as T;
        }
        return JSON.parse(cleaned) as T;
    } catch (e) {
        console.error("JSON Parse Error:", text);
        throw new Error(`Lỗi đọc dữ liệu từ DeepSeek: ${(e as Error).message}`);
    }
};

// --- HELPER: Call DeepSeek API ---
const callDeepSeek = async (messages: any[], jsonMode: boolean = true) => {
    const apiKey = getDeepSeekKey();

    return callWithRetry(async () => {
        const response = await fetch("https://api.deepseek.com/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: "deepseek-chat", // DeepSeek V3
                messages: messages,
                temperature: 0.1, // Nhiệt độ thấp để đảm bảo tính chính xác cho kế toán
                response_format: jsonMode ? { type: "json_object" } : { type: "text" },
                stream: false,
                max_tokens: 8000
            })
        });

        if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            if (response.status === 402) throw new Error("DeepSeek: Hết tín dụng (Insufficient Balance).");
            if (response.status === 429) throw new Error("DeepSeek: Quá tải (Rate Limit).");
            throw new Error(`DeepSeek Error: ${errData.error?.message || response.statusText}`);
        }

        const data = await response.json();
        return data.choices[0].message.content;
    });
};

/**
 * OCR: Vẫn phải dùng Gemini Flash vì DeepSeek không đọc được ảnh.
 * Đây là "Đôi mắt", còn DeepSeek là "Bộ não".
 */
export const extractTextFromContent = async (content: { images: { mimeType: string; data: string }[] }): Promise<string> => {
    if (content.images.length === 0) return '';
    const prompt = `Bạn là công cụ OCR. Đọc toàn bộ văn bản trong ảnh. Chỉ trả về text, không thêm lời dẫn. Giữ nguyên định dạng bảng.`;
    
    return callWithRetry(async () => {
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
        } catch (e: any) {
            console.warn("Lỗi OCR Gemini:", e);
            throw new Error("Không thể đọc ảnh. Vui lòng kiểm tra Google API Key (DeepSeek cần Google để đọc ảnh).");
        }
    }, 3, 2000); 
}

/**
 * Xử lý chính: Sử dụng 100% DeepSeek
 */
export const processStatement = async (content: { text: string; }, isPartial: boolean = false): Promise<GeminiResponse> => {
    const systemPrompt = `Bạn là Chuyên gia Kế toán (DeepSeek Engine). Nhiệm vụ: Chuyển đổi văn bản sao kê ngân hàng thành JSON chuẩn xác.

    SCHEMA JSON BẮT BUỘC:
    {
        "openingBalance": number, // Mặc định 0 nếu không thấy.
        "endingBalance": number, // Mặc định 0 nếu không thấy.
        "accountInfo": { "accountName": "...", "accountNumber": "...", "bankName": "...", "branch": "..." },
        "transactions": [
            { 
                "transactionCode": "string", 
                "date": "DD/MM/YYYY", 
                "description": "string", 
                "debit": number, // Số tiền ghi nợ (Tiền ra)
                "credit": number, // Số tiền ghi có (Tiền vào)
                "fee": number, 
                "vat": number 
            }
        ]
    }

    QUY TẮC NGHIỆP VỤ:
    1. Số tiền: Loại bỏ dấu phân cách (1.000.000 -> 1000000). Không được nhầm lẫn giữa Debit và Credit.
       - Ngân hàng ghi "Nợ" (Debit) -> Tiền đi (Sổ cái bên Có).
       - Ngân hàng ghi "Có" (Credit) -> Tiền đến (Sổ cái bên Nợ).
       - TUY NHIÊN: Trong JSON output, hãy giữ đúng ngữ nghĩa: "debit" là Tiền Nợ (Rút/Chuyển đi), "credit" là Tiền Có (Nhận được).
    2. Ngày tháng: Định dạng DD/MM/YYYY.
    3. Nếu là dữ liệu cắt nhỏ (Partial): Hãy cố gắng trích xuất giao dịch tối đa, bỏ qua header/footer nếu không rõ ràng.`;

    const userPrompt = `Dữ liệu sao kê thô:\n\n${content.text}`;

    // Gọi trực tiếp DeepSeek, không Fallback
    const jsonString = await callDeepSeek([
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
    ]);
    return cleanAndParseJSON<GeminiResponse>(jsonString);
};

/**
 * Xử lý Batch: Quản lý hàng đợi gửi lên DeepSeek
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

    // DeepSeek API khá nhanh, nhưng vẫn nên delay nhẹ để tránh Rate Limit (nếu dùng free tier)
    const BASE_DELAY = 1000; 

    for (let i = 0; i < chunks.length; i++) {
        onProgress(i + 1, chunks.length);
        if (i > 0) await delay(BASE_DELAY);

        const chunk = chunks[i];
        let result: GeminiResponse | null = null;

        try {
            if (chunk.type === 'text') {
                // Text/Excel -> DeepSeek xử lý trực tiếp
                result = await processStatement({ text: chunk.data }, true);
            } else {
                // Ảnh/PDF -> Gemini OCR -> DeepSeek xử lý
                const text = await extractTextFromContent({ images: [{ mimeType: 'image/jpeg', data: chunk.data }] });
                result = await processStatement({ text: text }, true);
            }
        } catch (err: any) {
            console.error(`Lỗi xử lý phần ${i + 1}:`, err);
            // Nếu lỗi DeepSeek, thử chờ và tiếp tục
            if (String(err).includes('429')) await delay(5000);
        }

        if (result) {
            if (result.transactions && Array.isArray(result.transactions)) {
                combinedTransactions = [...combinedTransactions, ...result.transactions];
            }
            if (!foundAccountInfo && result.accountInfo && result.accountInfo.accountNumber) {
                finalAccountInfo = result.accountInfo;
                foundAccountInfo = true;
            }
            if (!foundOpening && result.openingBalance) {
                finalOpeningBalance = result.openingBalance;
                foundOpening = true;
            }
            if (result.endingBalance) {
                finalEndingBalance = result.endingBalance;
            }
        }
    }

    // Sắp xếp lại theo thời gian
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

// --- CHAT WITH DEEPSEEK ---
const chatResponseSchema = {
    type: "json_object",
    // DeepSeek ko cần định nghĩa schema chi tiết trong API call như Gemini, chỉ cần System Prompt tốt.
};

export const chatWithAI = async (message: string, currentReport: GeminiResponse, chatHistory: ChatMessage[], rawStatementContent: string, image: { mimeType: string; data: string } | null): Promise<AIChatResponse> => {
    
    if (image) {
        // DeepSeek V3 chưa hỗ trợ ảnh
        return {
            responseText: "Xin lỗi anh, hiện tại DeepSeek Engine chưa hỗ trợ xem hình ảnh trực tiếp trong khung chat. Anh vui lòng nhập văn bản hoặc trích xuất lại file nhé.",
            action: undefined
        };
    }

    const systemPrompt = `Bạn là Trợ lý Kế toán chuyên nghiệp (DeepSeek).
    Bạn đang làm việc trên dữ liệu JSON sau: ${JSON.stringify(currentReport)}
    
    Nhiệm vụ: Trả lời câu hỏi người dùng hoặc thực hiện lệnh sửa đổi dưới dạng JSON.
    
    OUTPUT JSON FORMAT:
    {
        "responseText": "Câu trả lời của bạn...",
        "action": "update" | "undo" | "add" | "query",
        "update": { "index": number, "field": "debit/credit/fee/vat/description", "newValue": mixed } | null,
        "add": { ...TransactionObject } | null,
        "confirmationRequired": boolean
    }
    
    Lưu ý: Nếu người dùng yêu cầu sửa, hãy trả về action tương ứng.`;

    const formattedHistory = chatHistory.map(msg => ({ role: msg.role === 'model' ? 'assistant' : 'user', content: msg.content }));
    
    // Gọi DeepSeek
    const jsonString = await callDeepSeek([
        { role: "system", content: systemPrompt },
        { role: "user", content: `Context (Raw Text Partial): ${rawStatementContent.substring(0, 2000)}...` },
        ...formattedHistory,
        { role: "user", content: message }
    ], true);

    return cleanAndParseJSON<AIChatResponse>(jsonString);
};