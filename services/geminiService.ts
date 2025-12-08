import { GoogleGenAI } from "@google/genai";
import type { GeminiResponse, AIChatResponse, ChatMessage, Transaction } from '../types';

// --- CONFIGURATION ---
// Thứ tự ưu tiên Model: Luôn thử Pro trước, nếu thất bại toàn bộ các key mới sang Flash
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
    // 1. Pre-process: Replace smart quotes with standard quotes
    let repaired = jsonStr.trim().replace(/[\u201C\u201D]/g, '"');

    try {
        let segments: string[] = [];
        let currentSegment = '';
        let inString = false;
        let i = 0;
        
        // 2. Phân tách chuỗi thành các segment: String Literal vs Syntax
        while (i < repaired.length) {
            const char = repaired[i];
            if (char === '"') {
                // Check if the quote is escaped (lookup backwards)
                let backslashCount = 0;
                let j = i - 1;
                while (j >= 0 && repaired[j] === '\\') { backslashCount++; j--; }
                const isEscaped = backslashCount % 2 !== 0;
                
                if (!isEscaped) {
                    if (!inString) {
                        // START of a string
                        segments.push(currentSegment); // Push previous syntax
                        currentSegment = '"'; // Start new segment with quote
                        inString = true;
                    } else {
                        // END of a string
                        currentSegment += '"'; // Append closing quote
                        segments.push(currentSegment); // Push string segment
                        currentSegment = ''; // Reset for next syntax
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
        segments.push(currentSegment); // Push remaining part

        // 3. Process each segment
        repaired = segments.map((seg) => {
            // A segment is a String Literal if it starts with "
            if (seg.startsWith('"')) {
                // --- STRING SEGMENT HANDLING ---
                // Escape valid control characters, remove invalid ones
                return seg.replace(/[\u0000-\u001F]/g, (char) => {
                    switch (char) {
                        case '\b': return '\\b';
                        case '\f': return '\\f';
                        case '\n': return '\\n';
                        case '\r': return '\\r';
                        case '\t': return '\\t';
                        default: return ''; // Strip illegal controls (0x00, 0x01, etc.)
                    }
                });
            } else {
                // --- SYNTAX SEGMENT HANDLING ---
                let fixed = seg;
                
                // Safe comment removal: Remove // comments ONLY in syntax segments
                // Regex: // followed by anything until end of line
                fixed = fixed.replace(/\/\/.*$/gm, '');

                // Remove all control characters EXCEPT whitespace (Newline, Tab, CR)
                // 0x00-0x08 (Null to Backspace), 0x0B (Vertical Tab), 0x0C (Form Feed), 0x0E-0x1F (Shift out, etc.)
                fixed = fixed.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
                
                // Fix missing quotes for keys: { key: ... } -> { "key": ... }
                fixed = fixed.replace(/([{,]\s*)([a-zA-Z0-9_]+)\s*:/g, '$1"$2":');
                // Remove trailing commas: , } -> }
                fixed = fixed.replace(/,(\s*[}\]])/g, '$1');
                return fixed;
            }
        }).join('');

    } catch (e) {
        // Fallback for catastrophic regex failure
        repaired = repaired.replace(/([{,]\s*)([a-zA-Z0-9_]+)\s*:/g, '$1"$2":');
    }

    // 4. Fix truncated JSON (missing closing braces)
    const hasClosingRoot = repaired.endsWith('}');
    const transactionsIndex = repaired.indexOf('"transactions"');
    if (!hasClosingRoot && transactionsIndex !== -1) {
        // Try to close nicely
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
    // Final cleanup of trailing commas
    repaired = repaired.replace(/,(\s*[}\]])/g, '$1');
    
    return repaired;
};

const cleanAndParseJSON = <T>(text: string | undefined | null): T => {
    if (!text || typeof text !== 'string' || text.trim() === '') {
        throw new Error("AI trả về dữ liệu rỗng. (Có thể do bộ lọc an toàn hoặc lỗi mạng)");
    }

    const repairSyntax = (str: string): string => {
        let fixed = str;
        fixed = fixed.replace(/```json/g, "").replace(/```/g, "");
        return fixed.trim();
    };

    let cleaned = repairSyntax(text);

    try {
        return JSON.parse(cleaned) as T;
    } catch (e1) {
        // Try finding the first '{' if there is garbage prefix
        const firstOpen = cleaned.indexOf('{');
        if (firstOpen !== -1) {
            const candidate = cleaned.substring(firstOpen);
            try {
                // Try parsing the candidate directly first
                return JSON.parse(candidate) as T;
            } catch (e2) {
                console.warn("JSON Parse Failed. Running robust repair...");
                const repaired = robustJSONRepair(candidate);
                try {
                    return JSON.parse(repaired) as T;
                } catch (e3) {
                    // Report the ACTUAL error from the repair attempt, and also the original error
                    throw new Error(`Lỗi cấu trúc JSON (Sửa thất bại): ${(e3 as Error).message}. (Lỗi gốc: ${(e1 as Error).message})`);
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
    onStatusUpdate?: (model: string, keyIndex: number) => void;
}

// Cấu hình Safety để tránh bị chặn khi đọc sao kê tài chính
const SAFETY_SETTINGS_BLOCK_NONE = [
    { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
    { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
    { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
    { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
];

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
            temperature: 0, // QUAN TRỌNG: Set về 0 để kết quả nhất quán nhất có thể (Deterministic)
            safetySettings: SAFETY_SETTINGS_BLOCK_NONE, // Quan trọng: Tắt bộ lọc an toàn
        }
    });

    return result.text || "";
};

const callAIUnified = async (
    messages: Array<{role: string, content: string}>, 
    jsonMode: boolean = true,
    onStatusUpdate?: (model: string, keyIndex: number) => void
): Promise<string> => {
    const keys = getAPIKeys();
    
    if (keys.length === 0) {
        throw new Error("Chưa cấu hình API Key. Vui lòng thêm VITE_API_KEY vào biến môi trường trên Vercel (Hỗ trợ nhiều key cách nhau dấu phẩy).");
    }

    let lastError: any = null;

    // CHIẾN LƯỢC QUAN TRỌNG: Priority Models -> Priority Keys
    const modelsToTry = [PRO_MODEL, FLASH_MODEL];

    for (const model of modelsToTry) {
        // Vòng lặp qua từng Key cho Model hiện tại
        for (let i = 0; i < keys.length; i++) {
            const currentKey = keys[i];
            
            if (onStatusUpdate) {
                onStatusUpdate(model, i + 1);
            }

            try {
                return await callGoogleAI(currentKey, model, { messages, jsonMode });
            } catch (err: any) {
                // XỬ LÝ LỖI MẠNH MẼ HƠN (Update v1.6.0)
                // Chuyển đổi lỗi thành chuỗi để kiểm tra, bao gồm cả trường hợp lỗi là Object JSON
                let errorMessage = "";
                try {
                     errorMessage = String(err).toLowerCase();
                     if (errorMessage === "[object object]") {
                         errorMessage = JSON.stringify(err).toLowerCase();
                     }
                } catch(e) {
                    errorMessage = "unknown error";
                }

                // Danh sách lỗi "Được phép thử lại" (Retryable)
                const isRetryableError = 
                     errorMessage.includes('429') || 
                     errorMessage.includes('resource exhausted') || 
                     errorMessage.includes('too many requests') ||
                     errorMessage.includes('503') ||
                     errorMessage.includes('500') || 
                     errorMessage.includes('internal') ||
                     errorMessage.includes('overloaded') ||
                     errorMessage.includes('quota') ||
                     errorMessage.includes('xhr error') || // Lỗi mạng client
                     errorMessage.includes('rpc failed') || // Lỗi gRPC
                     errorMessage.includes('fetch failed'); // Lỗi fetch
                
                lastError = err;

                if (isRetryableError) {
                    console.warn(`⚠️ Model [${model}] Key [${i + 1}] gặp lỗi Retryable (Quota/Network). Đang thử Key tiếp theo sau 2s... Lỗi: ${errorMessage.substring(0, 100)}...`);
                    // Thêm delay để mạng ổn định lại trước khi thử key mới
                    await delay(2000);
                    continue; 
                } else {
                    console.error(`Lỗi Critical (${model}):`, err);
                    // Nếu lỗi nghiêm trọng (400, 401...), dừng ngay lập tức
                    throw err; 
                }
            }
        }
        
        console.warn(`⚠️ Đã thử TẤT CẢ Key với Model [${model}] nhưng đều thất bại. Đang chuyển sang Model dự phòng (nếu còn)...`);
    }

    throw new Error(`Tất cả các Key & Model đều thất bại. Vui lòng thử lại sau giây lát. Lỗi cuối cùng: ${lastError?.message || JSON.stringify(lastError)}`);
};

/**
 * OCR: Sử dụng Gemini Flash
 */
export const extractTextFromContent = async (content: { images: { mimeType: string; data: string }[] }): Promise<string> => {
    if (content.images.length === 0) return '';
    const prompt = `Bạn là công cụ OCR. Đọc toàn bộ văn bản trong ảnh. Chỉ trả về text, không thêm lời dẫn. Giữ nguyên định dạng bảng.`;
    
    const keys = getAPIKeys();
    if (keys.length === 0) throw new Error("Chưa có API Key cho OCR.");

    for (const key of keys) {
        try {
            const ai = new GoogleGenAI({ apiKey: key });
            const imageParts = content.images.map(img => ({ inlineData: { mimeType: img.mimeType, data: img.data } }));
            
            const response = await ai.models.generateContent({
                model: FLASH_MODEL,
                contents: { parts: [{ text: prompt }, ...imageParts] },
                config: { 
                    temperature: 0,
                    safetySettings: SAFETY_SETTINGS_BLOCK_NONE // Quan trọng: Tắt bộ lọc an toàn cho OCR
                }
            });
            return (response.text || '').trim();
        } catch (e: any) {
             // Retry cho OCR đơn giản hơn
             if (String(e).includes('429') || String(e).includes('503')) {
                 await delay(1000);
                 continue;
             }
             throw e;
        }
    }
    throw new Error("Không thể đọc ảnh (OCR) do tất cả Key đều bận.");
}

/**
 * Xử lý chính
 */
export const processStatement = async (
    content: { text: string; }, 
    isPartial: boolean = false,
    onStatusUpdate?: (model: string, keyIndex: number) => void
): Promise<GeminiResponse> => {
    // --- UPDATED SYSTEM PROMPT (v1.6.9 - Strict Consistency Rule) ---
    const systemPrompt = `Bạn là Chuyên gia Xử lý Dữ liệu Kế toán Ngân hàng (Google Gemini AI).
    Nhiệm vụ: Chuyển đổi văn bản sao kê ngân hàng thành JSON chuẩn.

    ### 1. QUY TẮC BẤT DI BẤT DỊCH VỀ SỐ LƯỢNG DÒNG (CHỐNG ẢO GIÁC & TRÙNG LẶP):
    - **CẢNH BÁO QUAN TRỌNG:** Nếu văn bản có phần "HEADER CONTEXT", đó chỉ là thông tin tiêu đề để tham khảo. **TUYỆT ĐỐI KHÔNG** trích xuất lại các giao dịch nằm trong phần HEADER CONTEXT vào kết quả JSON, vì chúng đã được xử lý ở phần trước rồi. Chỉ trích xuất dữ liệu trong phần BODY.
    - **KHÔNG TÁCH DÒNG:** Tuyệt đối KHÔNG tách 1 dòng giao dịch sao kê thành nhiều dòng JSON.
    - **GỘP DÒNG:** Nếu một dòng chỉ chứa Chữ (Diễn giải) mà KHÔNG có Số tiền và Ngày tháng -> Đó là phần mô tả bị xuống dòng của giao dịch phía trên. Hãy gộp nó vào "description" của giao dịch trước đó.
    - **LOẠI BỎ RÁC:** Các dòng tiêu đề lặp lại (Ngày, Số dư, Debit, Credit...), dòng tổng cộng trang, dòng số dư chuyển sang trang sau -> **BỎ QUA, KHÔNG XUẤT RA JSON**.

    ### 2. QUY TẮC ĐỊNH KHOẢN (NGƯỢC CHIỀU NGÂN HÀNG):
    - **Cột "Ghi Nợ" (Debit) / "Rút" / "Chi"** => JSON: **'credit'** (Tiền RA).
    - **Cột "Ghi Có" (Credit) / "Nộp" / "Thu"** => JSON: **'debit'** (Tiền VÀO).

    ### 3. QUY TẮC TÁCH PHÍ & VAT (QUAN TRỌNG NHẤT - STRICT):
    - Mục tiêu: Thống nhất số liệu. Tổng tiền giao dịch = (credit/debit) + fee + vat.
    - **NẾU** bạn tìm thấy Phí (fee) hoặc VAT trong nội dung giao dịch:
      => **BẮT BUỘC PHẢI TRỪ ĐI** số tiền phí/VAT đó khỏi số tiền gốc (debit/credit).
      => Ví dụ: Giao dịch ghi "Tổng nợ: 110.000 (đã bao gồm 10.000 phí)".
         -> JSON OUTPUT: { "credit": 100000, "fee": 10000, "vat": 0 }
         -> TUYỆT ĐỐI KHÔNG ĐƯỢC ĐỂ: { "credit": 110000, "fee": 10000 } (Vì như vậy khi cộng lại sẽ thành 120.000 -> Sai).
    - **NẾU** không tách được: Để fee=0, vat=0 và điền toàn bộ số tiền vào debit/credit.

    ### 4. CẤU TRÚC JSON OUTPUT:
    {
        "openingBalance": number, 
        "endingBalance": number,
        "accountInfo": { "accountName": "string", "accountNumber": "string", "bankName": "string", "branch": "string" },
        "transactions": [
            { 
                "transactionCode": "string", 
                "date": "DD/MM/YYYY", 
                "description": "string (Đã gộp dòng text lẻ)", 
                "debit": number (Tiền VÀO TK. Chỉ điền phần GỐC nếu có tách phí), 
                "credit": number (Tiền RA TK. Chỉ điền phần GỐC nếu có tách phí), 
                "fee": number, 
                "vat": number 
            }
        ]
    }`;

    const userPrompt = `Dữ liệu sao kê (Raw Text):\n\n${content.text}`;

    // Gọi Unified AI Caller (Tự động Pro -> Flash, Tự động đổi Key)
    const jsonString = await callAIUnified(
        [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt }
        ], 
        true,
        onStatusUpdate // Truyền callback xuống
    );
    return cleanAndParseJSON<GeminiResponse>(jsonString);
};

/**
 * Xử lý Batch
 */
export const processBatchData = async (
    chunks: { type: 'text' | 'image', data: string }[],
    onProgress: (current: number, total: number, modelName?: string, keyIndex?: number) => void
): Promise<GeminiResponse> => {
    
    let combinedTransactions: Transaction[] = [];
    let finalAccountInfo = { accountName: '', accountNumber: '', bankName: '', branch: '' };
    let finalOpeningBalance = 0;
    let finalEndingBalance = 0;
    let foundAccountInfo = false;
    let foundOpening = false;

    const BASE_DELAY = 1000; // Tăng delay nhẹ để tránh spam quá nhanh

    // Callback wrapper để nhận thông tin từ tầng dưới
    let currentModelName = "";
    let currentKeyIndex = 0;

    const statusCallback = (model: string, keyIdx: number) => {
        currentModelName = model;
        currentKeyIndex = keyIdx;
    };

    for (let i = 0; i < chunks.length; i++) {
        // Gọi progress ban đầu
        onProgress(i + 1, chunks.length, currentModelName, currentKeyIndex);
        
        if (i > 0) await delay(BASE_DELAY);

        const chunk = chunks[i];
        let result: GeminiResponse | null = null;

        try {
            if (chunk.type === 'text') {
                result = await processStatement({ text: chunk.data }, true, statusCallback);
            } else {
                const text = await extractTextFromContent({ images: [{ mimeType: 'image/jpeg', data: chunk.data }] });
                result = await processStatement({ text: text }, true, statusCallback);
            }
        } catch (err: any) {
            console.error(`Lỗi xử lý phần ${i + 1}:`, err);
            // Nếu lỗi nặng ở 1 phần, ta thử đợi và retry 1 lần nữa ở tầng batch
            await delay(3000);
            try {
                 if (chunk.type === 'text') {
                    result = await processStatement({ text: chunk.data }, true, statusCallback);
                } 
            } catch (retryErr) {
                console.error("Retry failed for chunk " + i);
            }
        }
        
        // Cập nhật lại UI với model/key đã dùng thành công
        onProgress(i + 1, chunks.length, currentModelName, currentKeyIndex);

        if (result) {
            if (result.transactions && Array.isArray(result.transactions)) {
                // --- BỘ LỌC DỮ LIỆU RÁC (POST-PROCESSING) ---
                const validTransactions = result.transactions.filter(tx => 
                    !tx.description.toLowerCase().includes("số dư đầu kỳ") &&
                    !tx.description.toLowerCase().includes("cộng phát sinh") &&
                    !tx.description.toLowerCase().includes("chuyển sang trang") && // Lọc dòng phân trang
                    !tx.description.toLowerCase().includes("mang sang trang") &&
                    !tx.description.toLowerCase().includes("số dư cuối") &&
                    // STRICT FILTER: Phải có tiền > 0 mới là giao dịch. 
                    // Nếu cả Debit và Credit đều = 0 -> Rác
                    (tx.debit > 0 || tx.credit > 0)
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
            // Logic lấy số dư cuối cùng: Lấy của phần mới nhất (nếu có)
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
