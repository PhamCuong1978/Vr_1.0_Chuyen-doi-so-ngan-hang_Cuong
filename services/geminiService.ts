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
        // Nếu không có Key, trả về null thay vì throw ngay để logic fallback xử lý sau (trừ OCR bắt buộc)
        return null; 
    }
    return new GoogleGenAI({ apiKey: apiKey });
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
            console.warn(`⚠️ API Busy. Retrying in ${delayMs/1000}s... (${retries} left)`);
            await delay(delayMs);
            return callWithRetry(fn, retries - 1, delayMs * 2); 
        }
        throw error;
    }
};

// --- HELPER: JSON REPAIR & PARSER ---

/**
 * Hàm sửa lỗi JSON mạnh mẽ: Xử lý cắt cụt, thừa dấu phẩy, thiếu ngoặc kép cho key...
 */
const robustJSONRepair = (jsonStr: string): string => {
    let repaired = jsonStr.trim();

    // 0. Fix smart quotes (dấu ngoặc kép cong) thành dấu ngoặc kép thẳng chuẩn JSON
    repaired = repaired.replace(/[\u201C\u201D]/g, '"');

    // 1. Nếu kết thúc bằng dấu phẩy, xóa nó
    if (repaired.endsWith(',')) {
        repaired = repaired.slice(0, -1);
    }

    // 2. Xử lý Truncated JSON (Bị cắt cụt)
    // Giả sử cấu trúc: { ..., "transactions": [ {..}, {..} <BỊ CẮT>
    if (!repaired.endsWith('}')) {
        // Tìm transaction hoàn chỉnh cuối cùng (kết thúc bằng "},")
        const lastValidObjIndex = repaired.lastIndexOf('},');
        if (lastValidObjIndex !== -1) {
            // Cắt bỏ phần thừa sau dấu phẩy cuối cùng
            repaired = repaired.substring(0, lastValidObjIndex + 1);
            // Đóng mảng và đóng object cha
            repaired += ']}';
        } else {
            // Trường hợp khác: Cắt tại dấu đóng ngoặc nhọn cuối cùng tìm thấy
            const lastCurly = repaired.lastIndexOf('}');
            if (lastCurly !== -1) {
                repaired = repaired.substring(0, lastCurly + 1);
                // Kiểm tra xem cần đóng gì thêm không (đếm ngoặc)
                const openBraces = (repaired.match(/\{/g) || []).length;
                const closeBraces = (repaired.match(/\}/g) || []).length;
                const openBrackets = (repaired.match(/\[/g) || []).length;
                const closeBrackets = (repaired.match(/\]/g) || []).length;

                if (openBrackets > closeBrackets) repaired += ']';
                if (openBraces > closeBraces) repaired += '}';
            }
        }
    }

    // 3. Fix trailing commas (dấu phẩy thừa trước dấu đóng ngoặc)
    // VD: { "a": 1, } -> { "a": 1 }
    // VD: [ 1, 2, ] -> [ 1, 2 ]
    repaired = repaired.replace(/,(\s*[}\]])/g, '$1');

    // 4. Fix unquoted keys (key không có ngoặc kép) - Common issue with some LLMs
    // Regex: Tìm các từ (word characters) đứng trước dấu hai chấm, mà chưa được bao bởi ngoặc kép
    // Lưu ý: Regex này đơn giản, có thể match sai nếu key chứa ký tự đặc biệt, nhưng đủ cho key thông thường (camelCase/snake_case)
    // Loại trừ trường hợp đã có ngoặc kép: "(.*?)":
    repaired = repaired.replace(/([{,]\s*)([a-zA-Z0-9_]+?)\s*:/g, '$1"$2":');

    return repaired;
};

const cleanAndParseJSON = <T>(text: string | undefined | null): T => {
    if (!text || typeof text !== 'string' || text.trim() === '') {
        throw new Error("AI trả về dữ liệu rỗng.");
    }

    const repairSyntax = (str: string): string => {
        let fixed = str;
        fixed = fixed.replace(/```json/g, "").replace(/```/g, "");
        fixed = fixed.replace(/\/\/.*$/gm, ""); // Remove comments
        return fixed.trim();
    };

    let cleaned = repairSyntax(text);

    // Cách 1: Parse trực tiếp
    try {
        return JSON.parse(cleaned) as T;
    } catch (e1) {
        // Cách 2: Tìm JSON object đầu tiên và cuối cùng
        const firstOpen = cleaned.indexOf('{');
        const lastClose = cleaned.lastIndexOf('}');
        
        if (firstOpen !== -1 && lastClose > firstOpen) {
            const candidate = cleaned.substring(firstOpen, lastClose + 1);
            try {
                return JSON.parse(candidate) as T;
            } catch (e2) {
                // Cách 3: Thử sửa lỗi (Repair)
                console.warn("JSON Parse Failed. Attempting repair...");
                const repaired = robustJSONRepair(candidate);
                try {
                    return JSON.parse(repaired) as T;
                } catch (e3) {
                    console.error("Repair Failed. Original:", candidate);
                    console.error("Repaired:", repaired);
                    throw new Error(`Lỗi cấu trúc JSON (Dữ liệu quá lớn hoặc bị lỗi). Original Error: ${(e1 as Error).message}`);
                }
            }
        }
        
        // Nếu không tìm thấy cặp ngoặc {} rõ ràng, thử sửa toàn bộ chuỗi
        try {
             const repairedAll = robustJSONRepair(cleaned);
             return JSON.parse(repairedAll) as T;
        } catch (e4) {
             throw new Error(`Không thể đọc dữ liệu từ AI: ${(e1 as Error).message}`);
        }
    }
};

// --- HELPER: UNIFIED AI CALLER (DeepSeek with Gemini Fallback) ---
const callAI = async (messages: Array<{role: string, content: string}>, jsonMode: boolean = true): Promise<string> => {
    const deepSeekKey = getEnvVar('DEEPSEEK_API_KEY');
    
    // 1. Ưu tiên DeepSeek
    if (deepSeekKey && deepSeekKey.trim() !== "" && !deepSeekKey.includes("VITE_DEEPSEEK_API_KEY")) {
        return callWithRetry(async () => {
            const response = await fetch("https://api.deepseek.com/chat/completions", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${deepSeekKey}`
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
                if (response.status === 402) throw new Error("DeepSeek: Hết tín dụng (Insufficient Balance).");
                if (response.status === 429) throw new Error("DeepSeek: Quá tải (Rate Limit).");
                throw new Error(`DeepSeek Error: ${errData.error?.message || response.statusText}`);
            }

            const data = await response.json();
            return data.choices[0].message.content;
        });
    }

    // 2. Fallback sang Gemini
    const googleKey = getEnvVar('API_KEY');
    if (googleKey && googleKey.trim() !== "" && !googleKey.includes("VITE_API_KEY")) {
        console.warn("⚠️ DeepSeek Key không tìm thấy hoặc chưa cấu hình. Đang chuyển sang dùng Gemini Flash.");
        
        return callWithRetry(async () => {
            const ai = new GoogleGenAI({ apiKey: googleKey });
            
            // Chuyển đổi format messages từ OpenAI -> Gemini
            // Tách System Prompt
            const systemMsg = messages.find(m => m.role === 'system');
            const systemInstruction = systemMsg ? systemMsg.content : undefined;
            
            // Gộp các message liên tiếp cùng role (Gemini yêu cầu luân phiên User/Model)
            const chatTurns = messages.filter(m => m.role !== 'system');
            const geminiContents: { role: 'user' | 'model', parts: { text: string }[] }[] = [];
            
            for (const msg of chatTurns) {
                const role = msg.role === 'assistant' ? 'model' : 'user';
                const last = geminiContents[geminiContents.length - 1];
                if (last && last.role === role) {
                    last.parts[0].text += "\n\n" + msg.content;
                } else {
                    geminiContents.push({
                        role: role,
                        parts: [{ text: msg.content }]
                    });
                }
            }

            // Nếu không có content nào (VD chỉ có system prompt), thêm dummy user message
            if (geminiContents.length === 0) {
                 geminiContents.push({ role: 'user', parts: [{ text: "Start processing." }] });
            }

            const result = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: geminiContents,
                config: {
                    systemInstruction: systemInstruction,
                    responseMimeType: jsonMode ? "application/json" : "text/plain",
                    temperature: 0.1
                }
            });

            return result.text || "";
        });
    }

    throw new Error("Chưa cấu hình API Key. Vui lòng thêm DEEPSEEK_API_KEY (ưu tiên) hoặc API_KEY (Google) vào biến môi trường.");
};

/**
 * OCR: Sử dụng Gemini Flash
 */
export const extractTextFromContent = async (content: { images: { mimeType: string; data: string }[] }): Promise<string> => {
    if (content.images.length === 0) return '';
    const prompt = `Bạn là công cụ OCR. Đọc toàn bộ văn bản trong ảnh. Chỉ trả về text, không thêm lời dẫn. Giữ nguyên định dạng bảng.`;
    
    return callWithRetry(async () => {
        try {
            const ai = getGeminiAI();
            if (!ai) throw new Error("Cần API Key của Google để đọc nội dung hình ảnh.");
            
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
 * Xử lý chính: Hỗ trợ cả DeepSeek và Gemini
 */
export const processStatement = async (content: { text: string; }, isPartial: boolean = false): Promise<GeminiResponse> => {
    const systemPrompt = `Bạn là Chuyên gia Xử lý Dữ liệu Kế toán (AI Engine).
    Nhiệm vụ: Chuyển đổi văn bản sao kê ngân hàng thành JSON chuẩn.

    HƯỚNG DẪN XỬ LÝ QUAN TRỌNG (ACCOUNTING MAPPING):
    1.  **Nguyên tắc Bất Di Bất Dịch:** Sổ phụ Ngân hàng luôn NGƯỢC với Sổ Kế toán Doanh nghiệp (TK 112).
    
    2.  **Mapping Nợ/Có (CỰC KỲ QUAN TRỌNG):**
        -   Nếu Sao kê ghi: "Ghi Có", "Credit", "Tiền vào", "CR", "Số tiền nhận" -> Đây là tiền VÀO doanh nghiệp -> Gán vào field **'debit'** (Sổ cái ghi Nợ 112).
        -   Nếu Sao kê ghi: "Ghi Nợ", "Debit", "Tiền ra", "DR", "Số tiền chi" -> Đây là tiền RA khỏi doanh nghiệp -> Gán vào field **'credit'** (Sổ cái ghi Có 112).
    
    3.  **Xử lý cột số tiền:**
        -   Nếu chỉ có 1 cột số tiền: Dựa vào dấu (+) hoặc loại GD "Nhận/Nộp" -> Gán 'debit'. Dựa vào dấu (-) hoặc loại GD "Chi/Rút/Phí" -> Gán 'credit'.
        -   Tuyệt đối không nhầm lẫn. 'debit' trong JSON output nghĩa là 'Accounting Debit' (Tiền tăng).

    4.  **Nhận diện bảng & Gộp dòng:**
        -   Quét từ trên xuống. Bắt đầu lấy dữ liệu khi thấy dòng có Ngày tháng hoặc Số tiền.
        -   Gộp các dòng mô tả không có ngày tháng vào giao dịch trước đó.

    SCHEMA JSON OUTPUT (BẮT BUỘC):
    {
        "openingBalance": number, // 0 nếu không thấy
        "endingBalance": number, // 0 nếu không thấy
        "accountInfo": { "accountName": "", "accountNumber": "", "bankName": "", "branch": "" },
        "transactions": [
            { 
                "transactionCode": "string", 
                "date": "DD/MM/YYYY", 
                "description": "string", 
                "debit": number (Tiền vào/Kế toán ghi Nợ - luôn dương), 
                "credit": number (Tiền ra/Kế toán ghi Có - luôn dương), 
                "fee": number, 
                "vat": number 
            }
        ]
    }
    
    LƯU Ý CUỐI: Trả về JSON Minified.`;

    const userPrompt = `Dữ liệu sao kê cần xử lý:\n\n${content.text}`;

    // Gọi Unified AI Caller
    const jsonString = await callAI([
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
    ]);
    return cleanAndParseJSON<GeminiResponse>(jsonString);
};

/**
 * Xử lý Batch
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

    const BASE_DELAY = 500; 

    for (let i = 0; i < chunks.length; i++) {
        onProgress(i + 1, chunks.length);
        if (i > 0) await delay(BASE_DELAY);

        const chunk = chunks[i];
        let result: GeminiResponse | null = null;

        try {
            if (chunk.type === 'text') {
                // Text/Excel -> AI xử lý
                result = await processStatement({ text: chunk.data }, true);
            } else {
                // Ảnh/PDF -> OCR -> AI xử lý
                const text = await extractTextFromContent({ images: [{ mimeType: 'image/jpeg', data: chunk.data }] });
                result = await processStatement({ text: text }, true);
            }
        } catch (err: any) {
            console.error(`Lỗi xử lý phần ${i + 1}:`, err);
            // Nếu lỗi quá tải, thử đợi lâu hơn chút rồi tiếp tục (với batch processing, fail 1 chunk chấp nhận được hơn là fail all)
            if (String(err).includes('429')) await delay(5000);
        }

        if (result) {
            if (result.transactions && Array.isArray(result.transactions)) {
                // Filter out transactions that might be actually header rows disguised (simple heuristic)
                const validTransactions = result.transactions.filter(tx => 
                    !tx.description.toLowerCase().includes("số dư đầu kỳ") &&
                    !tx.description.toLowerCase().includes("cộng phát sinh") &&
                    (tx.debit > 0 || tx.credit > 0 || tx.description.length > 0)
                );
                combinedTransactions = [...combinedTransactions, ...validTransactions];
            }
            if (!foundAccountInfo && result.accountInfo && (result.accountInfo.accountNumber || result.accountInfo.accountName)) {
                finalAccountInfo = result.accountInfo;
                foundAccountInfo = true;
            }
            if (!foundOpening && result.openingBalance > 0) {
                finalOpeningBalance = result.openingBalance;
                foundOpening = true;
            }
            // Update ending balance from the last chunk that has it
            if (result.endingBalance > 0) {
                finalEndingBalance = result.endingBalance;
            }
        }
    }

    // Sắp xếp: Ưu tiên theo ngày tháng, sau đó giữ nguyên thứ tự xuất hiện
    combinedTransactions.sort((a, b) => {
        const parseDate = (dateStr: string) => {
            if (!dateStr) return 0;
            const parts = dateStr.split('/');
            if (parts.length === 3) return new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0])).getTime();
            return 0;
        };
        const dateA = parseDate(a.date);
        const dateB = parseDate(b.date);
        return dateA - dateB;
    });

    return {
        accountInfo: finalAccountInfo,
        transactions: combinedTransactions,
        openingBalance: finalOpeningBalance,
        endingBalance: finalEndingBalance
    };
};

// --- CHAT ---
export const chatWithAI = async (message: string, currentReport: GeminiResponse, chatHistory: ChatMessage[], rawStatementContent: string, image: { mimeType: string; data: string } | null): Promise<AIChatResponse> => {
    
    if (image) {
        return {
            responseText: "Xin lỗi anh, tính năng đọc ảnh trong Chat tạm thời chưa hỗ trợ khi dùng Fallback/DeepSeek. Vui lòng nhập văn bản.",
            action: undefined
        };
    }

    const systemPrompt = `Bạn là Trợ lý Kế toán chuyên nghiệp.
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
    
    const jsonString = await callAI([
        { role: "system", content: systemPrompt },
        { role: "user", content: `Context (Raw Text Partial): ${rawStatementContent.substring(0, 2000)}...` },
        ...formattedHistory,
        { role: "user", content: message }
    ], true);

    return cleanAndParseJSON<AIChatResponse>(jsonString);
};