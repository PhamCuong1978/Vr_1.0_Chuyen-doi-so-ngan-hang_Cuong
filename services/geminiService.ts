import { GoogleGenAI } from "@google/genai";
import type { GeminiResponse, AIChatResponse, ChatMessage, Transaction } from '../types';

// --- CONFIGURATION ---
const PRO_MODEL = 'gemini-3-pro-preview';
const FLASH_MODEL = 'gemini-2.5-flash';

// --- HELPER: Safe Env Getter & Key Parser ---
const getAPIKeys = (): string[] => {
    let keyString: string | undefined = undefined;

    // 1. Ưu tiên lấy từ window.process (Polyfill)
    if (typeof window !== 'undefined' && (window as any).process?.env?.API_KEY) {
        keyString = (window as any).process.env.API_KEY;
    }
    
    // 2. Fallback: Import meta
    if (!keyString) {
        try {
            keyString = import.meta.env.VITE_API_KEY || import.meta.env.API_KEY;
        } catch (e) {}
    }

    if (!keyString) return [];

    // Tách chuỗi bằng dấu phẩy và loại bỏ khoảng trắng thừa
    return keyString.split(',').map(k => k.trim()).filter(k => k.length > 0);
};

// --- HELPER: UTIL FUNCTIONS ---
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// --- HELPER: JSON REPAIR & PARSER ---
const robustJSONRepair = (jsonStr: string): string => {
    let repaired = jsonStr.trim();
    repaired = repaired.replace(/[\u201C\u201D]/g, '"');

    try {
        let segments: string[] = [];
        let currentSegment = '';
        let inString = false;
        let i = 0;
        
        while (i < repaired.length) {
            const char = repaired[i];
            if (char === '"') {
                let backslashCount = 0;
                let j = i - 1;
                while (j >= 0 && repaired[j] === '\\') { backslashCount++; j--; }
                const isEscaped = backslashCount % 2 !== 0;
                
                if (!isEscaped) {
                    if (!inString) {
                        segments.push(currentSegment);
                        currentSegment = '"';
                        inString = true;
                    } else {
                        currentSegment += '"';
                        segments.push(currentSegment);
                        currentSegment = '';
                        inString = false;
                    }
                } else {
                    currentSegment += char;
                }
            } else {
                currentSegment += char;
            }
            i++;
        }
        segments.push(currentSegment);

        repaired = segments.map((seg) => {
            const isStringSegment = seg.trim().startsWith('"') && seg.trim().endsWith('"');
            if (!isStringSegment) {
                let fixed = seg;
                fixed = fixed.replace(/([{,]\s*)([a-zA-Z0-9_]+)\s*:/g, '$1"$2":');
                fixed = fixed.replace(/,(\s*[}\]])/g, '$1');
                return fixed;
            }
            return seg;
        }).join('');
    } catch (e) {
        repaired = repaired.replace(/([{,]\s*)([a-zA-Z0-9_]+)\s*:/g, '$1"$2":');
    }

    const hasClosingRoot = repaired.endsWith('}');
    const transactionsIndex = repaired.indexOf('"transactions"');
    if (!hasClosingRoot && transactionsIndex !== -1) {
        const lastItemEnd = repaired.lastIndexOf('},');
        if (lastItemEnd > transactionsIndex) {
            repaired = repaired.substring(0, lastItemEnd + 1) + ']}';
        } else {
             const lastBrace = repaired.lastIndexOf('}');
             if (lastBrace > transactionsIndex) {
                 repaired = repaired.substring(0, lastBrace + 1) + ']}';
             }
        }
    }
    repaired = repaired.replace(/,(\s*[}\]])/g, '$1');
    return repaired;
};

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

    let cleaned = repairSyntax(text);

    try {
        return JSON.parse(cleaned) as T;
    } catch (e1) {
        const firstOpen = cleaned.indexOf('{');
        if (firstOpen !== -1) {
            const candidate = cleaned.substring(firstOpen);
            try {
                return JSON.parse(candidate) as T;
            } catch (e2) {
                console.warn("JSON Parse Failed. Attempting repair...");
                const repaired = robustJSONRepair(candidate);
                try {
                    return JSON.parse(repaired) as T;
                } catch (e3) {
                    throw new Error(`Lỗi cấu trúc JSON: ${(e1 as Error).message}`);
                }
            }
        }
        throw new Error(`Không tìm thấy cấu trúc JSON hợp lệ.`);
    }
};

// --- CORE: WATERFALL & KEY ROTATION STRATEGY ---

interface AIRequestConfig {
    messages: Array<{role: string, content: string}>;
    jsonMode: boolean;
}

const callGoogleAI = async (apiKey: string, model: string, config: AIRequestConfig): Promise<string> => {
    const ai = new GoogleGenAI({ apiKey: apiKey });

    // 1. Tách System Instruction
    const systemMsg = config.messages.find(m => m.role === 'system');
    const systemInstruction = systemMsg ? systemMsg.content : undefined;

    // 2. Format Messages cho Gemini (User/Model turns)
    const chatTurns = config.messages.filter(m => m.role !== 'system');
    const geminiContents: { role: 'user' | 'model', parts: { text: string }[] }[] = [];

    for (const msg of chatTurns) {
        const role = msg.role === 'assistant' ? 'model' : 'user';
        const last = geminiContents[geminiContents.length - 1];
        if (last && last.role === role) {
            last.parts[0].text += "\n\n" + msg.content;
        } else {
            geminiContents.push({ role: role, parts: [{ text: msg.content }] });
        }
    }

    if (geminiContents.length === 0) {
        geminiContents.push({ role: 'user', parts: [{ text: "Start processing." }] });
    }

    // 3. Call API
    const result = await ai.models.generateContent({
        model: model,
        contents: geminiContents,
        config: {
            systemInstruction: systemInstruction,
            responseMimeType: config.jsonMode ? "application/json" : "text/plain",
            temperature: 0.1,
        }
    });

    return result.text || "";
};

const callAIUnified = async (messages: Array<{role: string, content: string}>, jsonMode: boolean = true): Promise<string> => {
    const keys = getAPIKeys();
    
    if (keys.length === 0) {
        throw new Error("Chưa cấu hình API Key. Vui lòng thêm VITE_API_KEY vào biến môi trường trên Vercel (Hỗ trợ nhiều key cách nhau dấu phẩy).");
    }

    let lastError: any = null;

    // CHIẾN LƯỢC MỚI: Priority Models -> Priority Keys
    // Quy trình:
    // 1. Thử Model PRO với Key 1, Key 2, Key 3...
    // 2. Nếu tất cả Key đều fail với PRO (do hết Quota), chuyển sang FLASH.
    // 3. Thử Model FLASH với Key 1, Key 2, Key 3...
    
    const modelsToTry = [PRO_MODEL, FLASH_MODEL];

    for (const model of modelsToTry) {
        let modelFailedAllKeys = true;

        for (let i = 0; i < keys.length; i++) {
            const currentKey = keys[i];
            try {
                // console.log(`Attempting Model [${model}] with Key index [${i}]`);
                return await callGoogleAI(currentKey, model, { messages, jsonMode });
            } catch (err: any) {
                const errorMessage = String(err).toLowerCase();
                const isQuotaError = errorMessage.includes('429') || 
                                     errorMessage.includes('resource exhausted') || 
                                     errorMessage.includes('too many requests') ||
                                     errorMessage.includes('503') ||
                                     errorMessage.includes('overloaded');
                
                lastError = err;

                if (isQuotaError) {
                    console.warn(`⚠️ Model [${model}] Key [${i}] bị hết Quota/Overloaded. Thử Key tiếp theo...`);
                    // Tiếp tục vòng lặp keys
                    continue; 
                } else {
                    // Nếu lỗi khác (ví dụ 400 Bad Request, Parse Error), throw ngay lập tức vì đổi key cũng không sửa được
                    console.error(`Lỗi không phải Quota (${model}):`, err);
                    throw err; 
                }
            }
            // Nếu thành công, return sẽ thoát khỏi hàm, không chạy xuống đây.
        }
        
        console.warn(`⚠️ Đã thử tất cả Key với Model [${model}] nhưng thất bại (Quota). Đang chuyển sang Model tiếp theo (nếu có)...`);
    }

    throw new Error(`Tất cả các Key & Model đều thất bại. Vui lòng thử lại sau giây lát. Lỗi cuối cùng: ${lastError?.message}`);
};

/**
 * OCR: Sử dụng Gemini Flash (Luôn dùng Flash cho nhanh và rẻ vì OCR cần xử lý ảnh)
 * Cũng áp dụng Key Rotation cho OCR
 */
export const extractTextFromContent = async (content: { images: { mimeType: string; data: string }[] }): Promise<string> => {
    if (content.images.length === 0) return '';
    const prompt = `Bạn là công cụ OCR. Đọc toàn bộ văn bản trong ảnh. Chỉ trả về text, không thêm lời dẫn. Giữ nguyên định dạng bảng.`;
    
    const keys = getAPIKeys();
    if (keys.length === 0) throw new Error("Chưa có API Key cho OCR.");

    // Simple Rotation for OCR (Just try keys one by one with Flash)
    for (const key of keys) {
        try {
            const ai = new GoogleGenAI({ apiKey: key });
            const imageParts = content.images.map(img => ({ inlineData: { mimeType: img.mimeType, data: img.data } }));
            
            const response = await ai.models.generateContent({
                model: FLASH_MODEL,
                contents: { parts: [{ text: prompt }, ...imageParts] },
                config: { temperature: 0 }
            });
            return (response.text || '').trim();
        } catch (e: any) {
             if (String(e).includes('429') || String(e).includes('503')) {
                 continue; // Try next key
             }
             throw e; // Real error
        }
    }
    throw new Error("Không thể đọc ảnh (OCR) do tất cả Key đều bận.");
}

/**
 * Xử lý chính
 */
export const processStatement = async (content: { text: string; }, isPartial: boolean = false): Promise<GeminiResponse> => {
    const systemPrompt = `Bạn là Chuyên gia Xử lý Dữ liệu Kế toán (Google Gemini AI).
    Nhiệm vụ: Chuyển đổi văn bản sao kê ngân hàng thành JSON chuẩn RFC 8259.

    ### 1. QUY TẮC AN TOÀN JSON (QUAN TRỌNG):
    - **Description Cleaning**: Trong trường "description", NẾU có dấu ngoặc kép (") bên trong nội dung, HÃY THAY THẾ bằng dấu nháy đơn (') hoặc xóa bỏ.
    - Không output Markdown (\`\`\`json). Chỉ trả về Raw JSON.

    ### 2. MAPPING KẾ TOÁN (NGUYÊN TẮC ĐẢO):
    - **Sổ Ngân Hàng** luôn ngược với **Sổ Kế Toán Doanh Nghiệp (TK 112)**.
    - **Ghi Nợ (Debit)** trên sao kê = **TIỀN RA** (Doanh nghiệp giảm) -> Gán vào JSON **'credit'**.
    - **Ghi Có (Credit)** trên sao kê = **TIỀN VÀO** (Doanh nghiệp tăng) -> Gán vào JSON **'debit'**.
    - Số âm (-): Tiền ra -> JSON 'credit'.
    - Số dương (+): Tiền vào -> JSON 'debit'.

    ### 3. XỬ LÝ PHÍ (QUAN TRỌNG - TRÁNH DUPLICATE):
    - Nếu dòng giao dịch là **PHÍ** (Ví dụ: Nội dung chứa "Thu phí dịch vụ", "Phí SMS", "Phí quản lý", v.v.):
       - Số tiền phải được điền vào **'credit'** (Tiền ra).
       - Trường **'fee' phải bằng 0** (Trừ khi trên sao kê CÓ CỘT PHÍ RIÊNG BIỆT tách khỏi cột số tiền giao dịch).
       - **KHÔNG ĐƯỢC** điền số tiền vừa vào 'credit' vừa vào 'fee'.
       - Ví dụ đúng: { "description": "THU PHI SMS", "credit": 22000, "fee": 0 }
       - Ví dụ SAI: { "description": "THU PHI SMS", "credit": 22000, "fee": 22000 } (Vì điều này sẽ làm tổng tiền ra bị tính thành 44000).

    ### 4. CẤU TRÚC JSON OUTPUT:
    {
        "openingBalance": number, 
        "endingBalance": number,
        "accountInfo": { "accountName": "string", "accountNumber": "string", "bankName": "string", "branch": "string" },
        "transactions": [
            { 
                "transactionCode": "string", 
                "date": "DD/MM/YYYY", 
                "description": "string (Đã sanitize)", 
                "debit": number (Tiền vào/Tăng), 
                "credit": number (Tiền ra/Giảm - Bao gồm cả phí nếu đó là dòng phí), 
                "fee": number (Chỉ điền nếu là cột riêng biệt, còn không thì để 0), 
                "vat": number 
            }
        ]
    }`;

    const userPrompt = `Dữ liệu sao kê (Raw Text):\n\n${content.text}`;

    // Gọi Unified AI Caller (Tự động Pro -> Flash, Tự động đổi Key)
    const jsonString = await callAIUnified([
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

    const BASE_DELAY = 1000; // Tăng delay nhẹ để tránh spam quá nhanh

    for (let i = 0; i < chunks.length; i++) {
        onProgress(i + 1, chunks.length);
        if (i > 0) await delay(BASE_DELAY);

        const chunk = chunks[i];
        let result: GeminiResponse | null = null;

        try {
            if (chunk.type === 'text') {
                result = await processStatement({ text: chunk.data }, true);
            } else {
                const text = await extractTextFromContent({ images: [{ mimeType: 'image/jpeg', data: chunk.data }] });
                result = await processStatement({ text: text }, true);
            }
        } catch (err: any) {
            console.error(`Lỗi xử lý phần ${i + 1}:`, err);
            // Nếu lỗi nặng ở 1 phần, ta thử đợi và retry 1 lần nữa ở tầng batch
            await delay(3000);
            try {
                 if (chunk.type === 'text') {
                    result = await processStatement({ text: chunk.data }, true);
                } 
            } catch (retryErr) {
                console.error("Retry failed for chunk " + i);
            }
        }

        if (result) {
            if (result.transactions && Array.isArray(result.transactions)) {
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
            if (result.endingBalance > 0) {
                finalEndingBalance = result.endingBalance;
            }
        }
    }

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
    
    // Gemini Pro hỗ trợ Multimodal (Text + Image) tốt
    // Nếu có ảnh, ta sẽ append vào message cuối cùng của user
    
    const systemPrompt = `Bạn là Trợ lý Kế toán chuyên nghiệp (Google Gemini).
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
    `;

    const formattedHistory = chatHistory.map(msg => ({ role: msg.role === 'model' ? 'assistant' : 'user', content: msg.content }));
    
    // Nếu có ảnh, ta thêm mô tả vào content user (Lưu ý: hàm callAIUnified hiện tại chỉ support text messages để đơn giản hóa rotation logic
    // Để support image tốt nhất trong rotation, ta cần sửa callAIUnified để nhận "parts" thay vì string content.
    // Tuy nhiên, ở mức độ simple, ta sẽ báo user nếu dùng ảnh mà model không hỗ trợ, hoặc OCR trước).
    // Nhưng Gemini Pro/Flash đều hỗ trợ ảnh.
    // Tạm thời: Nếu có ảnh, ta OCR ảnh đó trước rồi gửi text vào chat context, để đảm bảo tính nhất quán.
    
    let userContent = message;
    if (image) {
        const ocrText = await extractTextFromContent({ images: [image] });
        userContent += `\n[Nội dung trong ảnh đính kèm]: ${ocrText}`;
    }

    const jsonString = await callAIUnified([
        { role: "system", content: systemPrompt },
        { role: "user", content: `Context (Raw Text Partial): ${rawStatementContent.substring(0, 2000)}...` },
        ...formattedHistory,
        { role: "user", content: userContent }
    ], true);

    return cleanAndParseJSON<AIChatResponse>(jsonString);
};
