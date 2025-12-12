import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { processStatement, extractTextFromContent } from './services/geminiService';
import type { Transaction, GeminiResponse, ProcessedChunk } from './types';
import { UploadIcon, ProcessIcon, DownloadIcon, CopyIcon } from './components/Icons';
import ChatAssistant from './components/ChatAssistant';
import ResultTable from './components/ResultTable';
import { extractFromFile } from './utils/fileHelper';
import { formatCurrency } from './utils/formatters';
import { CURRENT_VERSION } from './utils/version';

type LoadingState = 'idle' | 'extracting' | 'processing';
type UploadState = 'idle' | 'uploading' | 'completed';
// Cập nhật các mức chia nhỏ theo yêu cầu: 30, 50, 100, 200, ALL
type ChunkStrategy = 'ALL' | '200' | '100' | '50' | '30';

export default function App() {
    const [openingBalance, setOpeningBalance] = useState('');
    const [chunks, setChunks] = useState<ProcessedChunk[]>([]);
    
    // Config chia nhỏ - Mặc định là 30 dòng cho chi tiết nhất (Thay đổi theo yêu cầu v1.0.2)
    const [chunkStrategy, setChunkStrategy] = useState<ChunkStrategy>('30');
    const [recommendedStrategy, setRecommendedStrategy] = useState<ChunkStrategy>('30');

    const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
    const [uploadState, setUploadState] = useState<UploadState>('idle');
    const [uploadProgress, setUploadProgress] = useState(0);

    const [loadingState, setLoadingState] = useState<LoadingState>('idle');
    const [globalProgress, setGlobalProgress] = useState(0);
    const [processingStatus, setProcessingStatus] = useState<string>('');
    const [activeKeyInfo, setActiveKeyInfo] = useState<string>(''); 

    const [error, setError] = useState<string | null>(null);
    const [isMergedView, setIsMergedView] = useState(false);
    const [mergedResult, setMergedResult] = useState<GeminiResponse | null>(null);
    const [balanceMismatchWarning, setBalanceMismatchWarning] = useState<string | null>(null);
    
    const uploadInterval = useRef<number | null>(null);
    const isLoading = loadingState !== 'idle';
    
    useEffect(() => {
        console.log(`App Version ${CURRENT_VERSION} Loaded - Batch Download Edition`);
        return () => {
            if (uploadInterval.current) clearInterval(uploadInterval.current);
        };
    }, []);
    
    // --- UPLOAD HANDLERS ---
    const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        const files = event.target.files;
        if (files && files.length > 0) {
            const newFiles = Array.from(files);
            resetState();
            setSelectedFiles(prev => [...prev, ...newFiles]);
            event.target.value = '';
            simulateUploadProcess();
        }
    };

    const handleRemoveFile = (indexToRemove: number) => {
        setSelectedFiles(prev => {
            const newFiles = prev.filter((_, index) => index !== indexToRemove);
            if (newFiles.length === 0) {
                resetState();
                setUploadState('idle');
                setUploadProgress(0);
            }
            return newFiles;
        });
    };

    const resetState = () => {
        setChunks([]);
        setMergedResult(null);
        setBalanceMismatchWarning(null);
        setError(null);
        setLoadingState('idle');
        setIsMergedView(false);
    };

    const simulateUploadProcess = () => {
        setUploadState('uploading');
        setUploadProgress(0);
        if (uploadInterval.current) clearInterval(uploadInterval.current);

        uploadInterval.current = window.setInterval(() => {
            setUploadProgress(prev => {
                if (prev >= 100) {
                    if (uploadInterval.current) clearInterval(uploadInterval.current);
                    setUploadState('completed');
                    return 100;
                }
                return prev + 15; 
            });
        }, 80); 
    };

    const handleResetUpload = () => {
        setSelectedFiles([]);
        setUploadState('idle');
        setUploadProgress(0);
        resetState();
        setOpeningBalance('');
    };

    // --- BATCH DOWNLOAD & COPY HANDLERS ---
    const handleBatchDownload = () => {
        const completedChunks = chunks.filter(c => c.status === 'completed' && c.result).sort((a, b) => a.index - b.index);
        if (completedChunks.length === 0) {
            alert("Chưa có dữ liệu để tải xuống.");
            return;
        }

        const headers = ["Phần", "Mã GD", "Ngày", "Nội dung", "PS Nợ (Vào)", "PS Có (Tổng)", "Số tiền GD (Gốc)", "Phí", "VAT"];
        const rows = [headers.join(',')];

        completedChunks.forEach(chunk => {
            chunk.result?.transactions.forEach(tx => {
                const netCredit = tx.credit - (tx.fee || 0) - (tx.vat || 0);
                const row = [
                    `"Phần ${chunk.index}"`,
                    `"${tx.transactionCode || ''}"`,
                    `"${tx.date}"`,
                    `"${tx.description.replace(/"/g, '""')}"`,
                    tx.debit,
                    tx.credit, // Total (Raw)
                    netCredit, // Net (Calculated)
                    tx.fee || 0,
                    tx.vat || 0
                ];
                rows.push(row.join(','));
            });
        });

        const csvContent = "data:text/csv;charset=utf-8," + rows.join('\n');
        const encodedUri = encodeURI(csvContent);
        const link = document.createElement("a");
        link.setAttribute("href", encodedUri);
        link.setAttribute("download", `ket_qua_tung_phan_v${CURRENT_VERSION}.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    const handleBatchCopy = () => {
        const completedChunks = chunks.filter(c => c.status === 'completed' && c.result).sort((a, b) => a.index - b.index);
        if (completedChunks.length === 0) {
             alert("Chưa có dữ liệu để copy.");
             return;
        }

        const headers = ["Phần", "Mã GD", "Ngày", "Mô tả", "Nợ", "Có", "Phí", "VAT"];
        let tsvContent = headers.join('\t') + '\n';

        completedChunks.forEach(chunk => {
             chunk.result?.transactions.forEach(tx => {
                 const row = [
                    `Phần ${chunk.index}`,
                    tx.transactionCode,
                    tx.date,
                    tx.description.replace(/\t/g, ' '), // sanitize tabs
                    tx.debit,
                    tx.credit,
                    tx.fee || 0,
                    tx.vat || 0
                ];
                tsvContent += row.join('\t') + '\n';
             });
        });

        navigator.clipboard.writeText(tsvContent).then(() => {
            alert("Đã copy toàn bộ dữ liệu (từng phần) vào Clipboard!");
        });
    };

    // --- EXTRACTION LOGIC ---
    const handleExtractText = async () => {
        if (selectedFiles.length === 0) {
            setError('Vui lòng chọn file trước khi trích xuất.');
            return;
        }

        const hasImagesOrPDF = selectedFiles.some(f => f.type.startsWith('image/') || f.type === 'application/pdf');
        
        setLoadingState('extracting');
        setError(null);
        setProcessingStatus(hasImagesOrPDF ? "Đang tách trang PDF/Ảnh (OCR)..." : "Đang đọc & phân tích dung lượng...");
        
        try {
            const extractionPromises = selectedFiles.map((file: File) => extractFromFile(file));
            const results = await Promise.all(extractionPromises);
            
            let allLines: string[] = [];
            const imageChunks: ProcessedChunk[] = [];

            // 1. Tổng hợp dữ liệu
            for (const res of results) {
                if (res.images.length > 0) {
                    res.images.forEach((img, idx) => {
                        imageChunks.push({
                            id: `img-${Date.now()}-${idx}`,
                            index: 0, 
                            type: 'image',
                            data: img.data,
                            previewStart: `[Trang Ảnh/PDF ${idx + 1}]`,
                            previewEnd: `(Dữ liệu dạng ảnh, sẽ dùng OCR)`,
                            isSelected: true,
                            status: 'idle',
                            isResultExpanded: true,
                            isCheckedForMerge: true
                        });
                    });
                } else if (res.text) {
                    const lines = res.text.split(/\r?\n/);
                    allLines = [...allLines, ...lines];
                }
            }

            // 2. Logic đề xuất chiến lược (Cập nhật theo các mức mới - Ưu tiên 30 dòng)
            const totalLines = allLines.length;
            let suggestion: ChunkStrategy = '30';
            
            if (totalLines > 5000) suggestion = '200';
            else if (totalLines > 2000) suggestion = '100';
            else if (totalLines > 1000) suggestion = '50';
            else if (totalLines > 0 && totalLines <= 100) suggestion = 'ALL'; 
            else if (totalLines > 0) suggestion = '30'; // Mặc định cho phần lớn các file (100 - 1000 dòng)
            
            setRecommendedStrategy(suggestion);
            setChunkStrategy(suggestion); 

            // 3. Thực hiện chia nhỏ (Splitting)
            let finalChunks: ProcessedChunk[] = [...imageChunks];
            
            if (allLines.length > 0) {
                let chunkSize = 30; // Default fallback
                if (chunkStrategy === 'ALL') {
                    chunkSize = Math.max(1, allLines.length);
                } else {
                    chunkSize = parseInt(chunkStrategy);
                }

                // FIX LỖI MẤT DỮ LIỆU ĐẦU FILE (v1.6.7)
                // Lấy 20 dòng đầu làm header để tham khảo cho các phần SAU
                const HEADER_ROWS = 20; 
                const headerText = allLines.slice(0, HEADER_ROWS).join('\n');
                
                // QUAN TRỌNG: KHÔNG ĐƯỢC CẮT BỎ HEADER KHỎI SOURCE LINES
                // Trước đây: const sourceLines = allLines.slice(HEADER_ROWS); -> SAI, mất dữ liệu
                // Bây giờ: const sourceLines = allLines; -> ĐÚNG
                const sourceLines = allLines;

                for (let i = 0; i < sourceLines.length; i += chunkSize) {
                    const chunkBodyLines = sourceLines.slice(i, i + chunkSize);
                    const chunkBody = chunkBodyLines.join('\n');
                    
                    let contextContent = chunkBody;

                    // Chỉ chèn Header Context cho các phần từ thứ 2 trở đi (i > 0)
                    // Phần đầu tiên (i=0) đã chứa sẵn header tự nhiên, không cần chèn thêm để tránh lặp
                    if (i > 0 && headerText) {
                         contextContent = `--- HEADER CONTEXT (INFO ONLY - DO NOT EXTRACT) ---\n${headerText}\n--- END HEADER ---\n\n${chunkBody}`;
                    }

                    const previewStart = chunkBodyLines.slice(0, 3).map(l => l.trim()).filter(l => l).join('\n') || "(Trống)";
                    const previewEnd = chunkBodyLines.slice(-3).map(l => l.trim()).filter(l => l).join('\n') || "(Trống)";

                    finalChunks.push({
                        id: `txt-${Date.now()}-${i}`,
                        index: 0,
                        type: 'text',
                        data: contextContent,
                        previewStart: previewStart,
                        previewEnd: previewEnd,
                        isSelected: true,
                        status: 'idle',
                        isResultExpanded: true,
                        isCheckedForMerge: true
                    });
                }
            }

            // Re-index
            finalChunks = finalChunks.map((c, idx) => ({ ...c, index: idx + 1 }));
            setChunks(finalChunks);
            setProcessingStatus(`Đã trích xuất ${totalLines} dòng & chia thành ${finalChunks.length} phần.`);

        } catch (err) {
            console.error(err);
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoadingState('idle');
        }
    };

    // --- SELECTION HANDLERS ---
    const toggleChunkSelection = (id: string) => {
        setChunks(prev => prev.map(c => c.id === id ? { ...c, isSelected: !c.isSelected } : c));
    };

    const toggleAllChunks = (select: boolean) => {
        setChunks(prev => prev.map(c => ({ ...c, isSelected: select })));
    };
    
    // --- RESULT VIEW HANDLERS ---
    const toggleResultExpand = (id: string) => {
        setChunks(prev => prev.map(c => c.id === id ? { ...c, isResultExpanded: !c.isResultExpanded } : c));
    };

    const toggleAllResultsExpand = (expand: boolean) => {
        setChunks(prev => prev.map(c => ({ ...c, isResultExpanded: expand })));
    };

    const toggleMergeCheckbox = (id: string) => {
        setChunks(prev => prev.map(c => c.id === id ? { ...c, isCheckedForMerge: !c.isCheckedForMerge } : c));
    };

    const toggleAllMergeCheckbox = (checked: boolean) => {
        setChunks(prev => prev.map(c => ({ ...c, isCheckedForMerge: checked })));
    };


    // --- PROCESSING HANDLERS ---
    const handleSubmit = async () => {
        const selectedChunks = chunks.filter(c => c.isSelected);
        if (selectedChunks.length === 0) {
            setError('Vui lòng chọn ít nhất một phần để xử lý.');
            return;
        }

        setLoadingState('processing');
        setError(null);
        setMergedResult(null); 
        setIsMergedView(false);
        setActiveKeyInfo('');
        setGlobalProgress(0);

        let completedCount = 0;
        const total = selectedChunks.length;

        // Reset status
        setChunks(prev => prev.map(c => c.isSelected ? { ...c, status: 'idle', result: undefined, error: undefined, processingMessage: undefined, isResultExpanded: true, isCheckedForMerge: true } : c));

        for (const chunk of selectedChunks) {
            setChunks(prev => prev.map(c => c.id === chunk.id ? { ...c, status: 'processing' } : c));
            setProcessingStatus(`Đang xử lý phần ${chunk.index}...`);

            try {
                let result: GeminiResponse;
                const statusCallback = (model: string, keyIdx: number) => {
                     let displayModel = "Gemini";
                     if (model.includes("pro")) displayModel = "Gemini Pro";
                     else if (model.includes("flash")) displayModel = "Gemini Flash";
                     
                     const msg = `${displayModel} ${keyIdx}`;
                     setActiveKeyInfo(msg); 
                     setChunks(prev => prev.map(c => c.id === chunk.id ? { ...c, processingMessage: msg } : c));
                };

                if (chunk.type === 'text') {
                    result = await processStatement({ text: chunk.data }, true, statusCallback);
                } else {
                    const text = await extractTextFromContent({ images: [{ mimeType: 'image/jpeg', data: chunk.data }] });
                    result = await processStatement({ text: text }, true, statusCallback);
                }

                setChunks(prev => prev.map(c => c.id === chunk.id ? { 
                    ...c, 
                    status: 'completed', 
                    result: result 
                } : c));

            } catch (err: any) {
                console.error(`Error processing chunk ${chunk.index}:`, err);
                setChunks(prev => prev.map(c => c.id === chunk.id ? { 
                    ...c, 
                    status: 'error', 
                    error: err.message || "Lỗi xử lý" 
                } : c));
            }

            completedCount++;
            setGlobalProgress(Math.round((completedCount / total) * 100));
        }

        setLoadingState('idle');
        setProcessingStatus('Hoàn tất toàn bộ!');
        setActiveKeyInfo('');
    };

    // --- MERGE LOGIC WITH GLOBAL DEDUPLICATION ---
    const handleMergeResults = () => {
        // Chỉ gộp những phần đã hoàn thành VÀ được tick chọn
        const chunksToMerge = chunks.filter(c => c.status === 'completed' && c.result && c.isCheckedForMerge);
        
        if (chunksToMerge.length === 0) {
            alert("Vui lòng tick chọn ít nhất 1 phần để xem báo cáo.");
            return;
        }

        // Sắp xếp lại theo index để đảm bảo thứ tự
        const sortedChunks = [...chunksToMerge].sort((a, b) => a.index - b.index);

        let allTransactions: Transaction[] = [];
        let firstAccountInfo = sortedChunks[0].result?.accountInfo;
        
        // --- 1. GLOBAL SMART DEDUPLICATION ---
        // Sử dụng một Set toàn cục để lưu "chữ ký" của TẤT CẢ các giao dịch đã duyệt qua.
        // Điều này đảm bảo nếu Phần 2, Phần 3... có lặp lại giao dịch của Phần 1 (do Header Context), nó sẽ bị loại bỏ.
        
        const globalSeenSignatures = new Set<string>();
        
        // Helper tạo chữ ký duy nhất cho giao dịch (Vân tay)
        const createTxSignature = (tx: Transaction) => {
            // Chữ ký gồm: Ngày + Nợ + Có.
            // Nếu có Mã GD -> Dùng Mã GD.
            // Nếu KHÔNG có Mã GD -> Dùng 30 ký tự đầu của Diễn giải (đã chuẩn hóa) để phân biệt.
            const normalizedDesc = tx.description 
                ? tx.description.toLowerCase().replace(/\s/g, '').substring(0, 30) 
                : 'nodesc';
            
            const normalizedCode = tx.transactionCode 
                ? tx.transactionCode.trim().toLowerCase() 
                : normalizedDesc; // Fallback dùng description nếu ko có code
            
            return `${tx.date}|${tx.debit}|${tx.credit}|${normalizedCode}`;
        };

        sortedChunks.forEach((chunk) => {
            if (!chunk.result?.transactions) return;

            // Lọc rác cơ bản trước
            const valid = chunk.result.transactions.filter(tx => 
                !tx.description.toLowerCase().includes("số dư đầu kỳ") &&
                !tx.description.toLowerCase().includes("cộng phát sinh")
            );

            // Duyệt qua từng giao dịch trong phần này
            valid.forEach(tx => {
                const sig = createTxSignature(tx);
                
                // Nếu chữ ký này CHƯA từng xuất hiện trong bất kỳ phần nào trước đó -> Thêm vào
                if (!globalSeenSignatures.has(sig)) {
                    globalSeenSignatures.add(sig);
                    allTransactions.push(tx);
                } else {
                    // Nếu đã có rồi -> Bỏ qua (Đây là giao dịch trùng lặp do Header Context)
                    console.log("Phát hiện trùng lặp, loại bỏ:", tx);
                }
            });
        });

        // --- 2. Logic Số dư đầu kỳ (Opening Balance) ---
        let globalOpening = 0;
        if (openingBalance) {
            globalOpening = parseFloat(openingBalance.replace(/\./g, '')) || 0;
        } else {
            globalOpening = sortedChunks[0].result?.openingBalance || 0;
        }

        // --- 3. Logic Số dư cuối kỳ Đọc được (Detected Closing Balance) ---
        const lastChunk = sortedChunks[sortedChunks.length - 1];
        const detectedEnding = lastChunk.result?.endingBalance || 0;

        // --- 4. Sắp xếp lại thời gian (Sau khi đã khử trùng) ---
        allTransactions.sort((a, b) => {
            const parseDate = (dateStr: string) => {
                if (!dateStr) return 0;
                const parts = dateStr.split('/');
                if (parts.length === 3) return new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0])).getTime();
                return 0;
            };
            return parseDate(a.date) - parseDate(b.date);
        });

        // TÍNH TOÁN LẠI TỔNG (Logic mới: Credit/Debit là số Tổng)
        const { totalDebit, totalCredit, totalFee, totalVat } = allTransactions.reduce((acc, tx) => ({
             totalDebit: acc.totalDebit + tx.debit,
             totalCredit: acc.totalCredit + tx.credit,
             totalFee: acc.totalFee + (tx.fee || 0),
             totalVat: acc.totalVat + (tx.vat || 0),
        }), { totalDebit: 0, totalCredit: 0, totalFee: 0, totalVat: 0 });

        // --- 5. Tính toán & Đối chiếu ---
        // Số dư = Đầu kỳ + Tổng Vào (Debit) - Tổng Ra (Credit)
        // Vì Debit/Credit giờ là số Tổng, nên trừ thẳng, không cần cộng Fee/VAT vào nữa
        const calculatedEnding = globalOpening + totalDebit - totalCredit;
        const diff = Math.abs(calculatedEnding - detectedEnding);
        
        if (diff > 100 && detectedEnding !== 0) {
            setBalanceMismatchWarning(`LỆCH SỐ LIỆU: Số dư trên file (Cuối phần ${lastChunk.index}) là ${formatCurrency(detectedEnding)}, nhưng tính toán ra ${formatCurrency(calculatedEnding)}. Chênh lệch: ${formatCurrency(diff)}.`);
        } else {
            setBalanceMismatchWarning(null); 
        }

        setMergedResult({
            accountInfo: firstAccountInfo || { accountName: '', accountNumber: '', bankName: '', branch: '' },
            transactions: allTransactions,
            openingBalance: globalOpening,
            endingBalance: calculatedEnding
        });

        setIsMergedView(true);
    };

    // --- WRAPPERS ---
    const handleTransactionUpdate = (index: number, field: any, value: any) => {
        if (isMergedView && mergedResult) {
            const updatedTx = [...mergedResult.transactions];
            updatedTx[index] = { ...updatedTx[index], [field]: value };
            setMergedResult({ ...mergedResult, transactions: updatedTx });
        }
    };
    
    const updateChunkResult = (chunkId: string, index: number, field: any, value: any) => {
        setChunks(prev => prev.map(c => {
            if (c.id === chunkId && c.result) {
                const updatedTx = [...c.result.transactions];
                updatedTx[index] = { ...updatedTx[index], [field]: value };
                return { ...c, result: { ...c.result, transactions: updatedTx } };
            }
            return c;
        }));
    };
     const updateChunkResultString = (chunkId: string, index: number, field: any, value: any) => {
        setChunks(prev => prev.map(c => {
            if (c.id === chunkId && c.result) {
                const updatedTx = [...c.result.transactions];
                updatedTx[index] = { ...updatedTx[index], [field]: value };
                return { ...c, result: { ...c.result, transactions: updatedTx } };
            }
            return c;
        }));
    };


    return (
        <div className="min-h-screen text-gray-800 dark:text-gray-200 p-4 sm:p-6 lg:p-8">
            <div className="max-w-7xl mx-auto">
                <header className="text-center mb-8">
                    <h1 className="text-3xl sm:text-4xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-blue-500 to-teal-400">
                        Vr_1.0: Chuyển Đổi Số Ngân Hàng (Cuong)
                    </h1>
                    <p className="mt-2 text-gray-600 dark:text-gray-400 flex items-center justify-center gap-2">
                        <span>Xử lý Big Data (Chia nhỏ & Gộp). Powered by Gemini.</span>
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200 border border-purple-200 dark:border-purple-700">
                            Version {CURRENT_VERSION}
                        </span>
                    </p>
                </header>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                    {/* LEFT COLUMN: CONTROLS */}
                    <div className="bg-white dark:bg-gray-800 p-6 rounded-xl shadow-lg">
                        <h2 className="text-2xl font-bold mb-4 text-gray-800 dark:text-gray-200">QUY TRÌNH XỬ LÝ</h2>
                        
                        <div className={`transition-opacity duration-300 ease-in-out ${isLoading && loadingState === 'processing' ? 'opacity-80 pointer-events-none' : ''}`}>
                            
                            {/* BƯỚC 1, 2: GIỮ NGUYÊN */}
                            <div className="mb-6 border-b border-gray-200 pb-4 dark:border-gray-700">
                                <label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-2">1. Upload file sao kê</label>
                                {selectedFiles.length > 0 && (
                                    <div className="mb-3 space-y-2">
                                        {selectedFiles.map((file, idx) => (
                                            <div key={`${file.name}-${idx}`} className="flex items-center justify-between bg-gray-50 dark:bg-gray-700 rounded-lg p-2 border border-gray-200 dark:border-gray-600">
                                                <span className="truncate text-sm font-medium ml-2">{file.name} ({(file.size/1024).toFixed(0)}KB)</span>
                                                <button onClick={() => handleRemoveFile(idx)} className="text-red-500 hover:text-red-700 p-1">Xóa</button>
                                            </div>
                                        ))}
                                    </div>
                                )}
                                <div className="space-y-2">
                                    <label htmlFor="file-upload" className={`cursor-pointer bg-white dark:bg-gray-700 rounded-md font-medium text-indigo-600 dark:text-indigo-400 border-2 border-dashed border-gray-300 dark:border-gray-600 flex flex-col items-center justify-center p-4 hover:border-indigo-500`}>
                                        <div className="flex items-center space-x-2">
                                            <UploadIcon/>
                                            <span className="text-sm">{selectedFiles.length > 0 ? 'Thêm file khác' : 'Chọn tệp (PDF, Excel, Ảnh...)'}</span>
                                        </div>
                                        <input id="file-upload" type="file" className="sr-only" onChange={handleFileChange} accept=".pdf,.docx,.xlsx,.xls,.txt,.csv,.json,.png,.jpg,.jpeg" multiple/>
                                    </label>
                                    {uploadState === 'uploading' && <div className="w-full bg-gray-200 rounded-full h-1.5 mt-2"><div className="h-1.5 rounded-full bg-blue-500" style={{ width: `${uploadProgress}%` }}></div></div>}
                                </div>
                            </div>

                            <div className="mb-6 border-b border-gray-200 pb-4 dark:border-gray-700">
                                <label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-2">2. Cấu hình & Trích xuất</label>
                                <div className="flex flex-col gap-2 mb-3">
                                    <span className="text-xs text-gray-500">AI sẽ tự động đề xuất cách chia nhỏ dựa trên dung lượng file.</span>
                                    <select value={chunkStrategy} onChange={(e) => setChunkStrategy(e.target.value as ChunkStrategy)} className="block w-full px-3 py-2 text-sm bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-md focus:ring-indigo-500" disabled={loadingState === 'extracting'}>
                                        <option value="30">30 dòng/phần {recommendedStrategy === '30' ? '(Khuyên dùng - Rất chi tiết)' : ''}</option>
                                        <option value="50">50 dòng/phần {recommendedStrategy === '50' ? '(Khuyên dùng - Chi tiết)' : ''}</option>
                                        <option value="100">100 dòng/phần {recommendedStrategy === '100' ? '(Khuyên dùng)' : ''}</option>
                                        <option value="200">200 dòng/phần {recommendedStrategy === '200' ? '(Khuyên dùng - File lớn)' : ''}</option>
                                        <option value="ALL">Gửi toàn bộ {recommendedStrategy === 'ALL' ? '(Khuyên dùng - File nhỏ)' : ''}</option>
                                    </select>
                                </div>
                                <button onClick={handleExtractText} disabled={selectedFiles.length === 0 || loadingState === 'extracting'} className={`w-full flex items-center justify-center px-4 py-2 border border-transparent text-sm font-medium rounded-md transition-all ${selectedFiles.length > 0 && uploadState !== 'uploading' ? 'text-white bg-indigo-600 hover:bg-indigo-700' : 'bg-gray-100 text-gray-400 cursor-not-allowed'}`}>
                                    {loadingState === 'extracting' ? <><ProcessIcon /> Đang phân tích...</> : `Trích xuất & Chia nhỏ`}
                                </button>
                            </div>

                             {/* BƯỚC 3: CHỌN PHẦN XỬ LÝ (PREVIEW CARDS) */}
                            {chunks.length > 0 && (
                                <div className="mb-6 border-b border-gray-200 pb-4 dark:border-gray-700">
                                    <div className="flex justify-between items-center mb-2">
                                        <label className="block text-sm font-bold text-gray-700 dark:text-gray-300">
                                            3. Chọn phần dữ liệu ({chunks.filter(c => c.isSelected).length}/{chunks.length})
                                        </label>
                                        <div className="space-x-2">
                                            <button onClick={() => toggleAllChunks(true)} className="text-xs text-blue-600 hover:underline">Chọn tất cả</button>
                                            <button onClick={() => toggleAllChunks(false)} className="text-xs text-gray-500 hover:underline">Bỏ chọn</button>
                                        </div>
                                    </div>
                                    <div className="max-h-60 overflow-y-auto space-y-2 pr-1 custom-scrollbar">
                                        {chunks.map((chunk) => (
                                            <div key={chunk.id} className={`p-3 rounded-lg border text-sm transition-colors ${chunk.isSelected ? 'border-blue-400 bg-blue-50 dark:bg-blue-900/20' : 'border-gray-200 bg-gray-50 dark:bg-gray-700 opacity-70'}`}>
                                                <div className="flex items-start gap-3">
                                                    <input type="checkbox" checked={chunk.isSelected} onChange={() => toggleChunkSelection(chunk.id)} className="mt-1 h-4 w-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500"/>
                                                    <div className="flex-1 min-w-0">
                                                        <div className="flex justify-between">
                                                            <span className="font-semibold text-gray-800 dark:text-gray-200">Phần {chunk.index} ({chunk.type})</span>
                                                            <span className={`text-xs px-2 py-0.5 rounded-full ${chunk.status === 'completed' ? 'bg-green-100 text-green-800' : chunk.status === 'processing' ? 'bg-yellow-100 text-yellow-800' : chunk.status === 'error' ? 'bg-red-100 text-red-800' : 'bg-gray-200 text-gray-600'}`}>{chunk.status === 'processing' ? 'Đang chạy...' : chunk.status}</span>
                                                        </div>
                                                        <div className="mt-1 text-xs text-gray-500 font-mono bg-white dark:bg-gray-800 p-1.5 rounded border border-gray-100 dark:border-gray-600">
                                                            <div className="text-blue-600">{chunk.previewStart}</div>
                                                            <div className="text-center my-0.5 text-gray-300">...</div>
                                                            <div className="text-purple-600">{chunk.previewEnd}</div>
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                             {/* BƯỚC 4: SỐ DƯ */}
                             <div className="mb-4">
                                <label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-1">4. Số dư đầu kỳ (Tùy chọn - Sẽ ưu tiên hơn AI)</label>
                                <input type="text" value={openingBalance ? new Intl.NumberFormat('vi-VN').format(parseFloat(openingBalance.replace(/\./g, ''))) : ''} onChange={(e) => { const value = e.target.value.replace(/\./g, ''); if (!isNaN(parseFloat(value)) || value === '') setOpeningBalance(value); }} placeholder="Nhập số dư đầu kỳ..." className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 focus:ring-indigo-500"/>
                            </div>

                             {/* BƯỚC 5: XỬ LÝ */}
                             <div className="mt-6">
                                {isLoading && (
                                    <div className="mb-2">
                                        <div className="flex justify-between text-xs text-gray-500 mb-1">
                                            <span>Tiến trình: {processingStatus}</span>
                                            <span>{globalProgress}%</span>
                                        </div>
                                        <div className="w-full bg-gray-200 rounded-full h-2"><div className="bg-green-500 h-2 rounded-full transition-all" style={{ width: `${globalProgress}%` }}></div></div>
                                    </div>
                                )}
                                <button onClick={handleSubmit} disabled={isLoading || chunks.length === 0} className="w-full flex items-center justify-center px-6 py-3 border border-transparent text-base font-bold rounded-md shadow-sm text-white bg-green-600 hover:bg-green-700 disabled:bg-green-400 disabled:cursor-not-allowed transition-colors">
                                    {loadingState === 'processing' ? <><ProcessIcon /> Đang xử lý ({activeKeyInfo || 'Gemini'})...</> : '5. Bắt đầu Xử lý'}
                                </button>
                             </div>
                             
                             {error && <div className="mt-4 p-3 bg-red-100 text-red-700 text-sm rounded border border-red-300">{error}</div>}
                        </div>
                    </div>

                    {/* RIGHT COLUMN: RESULTS */}
                    <div className="bg-white dark:bg-gray-800 p-6 rounded-xl shadow-lg min-h-[500px] flex flex-col">
                        <div className="flex justify-between items-center mb-4 flex-wrap gap-2">
                            <h2 className="text-2xl font-bold text-gray-800 dark:text-gray-200">KẾT QUẢ</h2>
                            
                            {/* ACTIONS GROUP */}
                            <div className="flex items-center gap-3">
                                
                                {/* Nút Batch Download/Copy - Chỉ hiện khi chưa gộp và có dữ liệu */}
                                {!isMergedView && chunks.some(c => c.status === 'completed') && (
                                    <div className="flex items-center bg-gray-100 dark:bg-gray-700 rounded-lg p-1 mr-2">
                                        <button onClick={handleBatchCopy} className="p-2 text-gray-600 dark:text-gray-300 hover:text-green-600 hover:bg-white dark:hover:bg-gray-600 rounded transition-colors" title="Copy toàn bộ kết quả các phần">
                                            <CopyIcon className="h-5 w-5"/>
                                        </button>
                                        <div className="w-px h-4 bg-gray-300 dark:bg-gray-600 mx-1"></div>
                                        <button onClick={handleBatchDownload} className="p-2 text-gray-600 dark:text-gray-300 hover:text-blue-600 hover:bg-white dark:hover:bg-gray-600 rounded transition-colors" title="Tải xuống toàn bộ kết quả các phần (CSV)">
                                            <DownloadIcon className="h-5 w-5"/>
                                        </button>
                                    </div>
                                )}

                                <div className="space-x-2">
                                    <button onClick={() => setIsMergedView(false)} className={`px-3 py-1 text-sm rounded-md transition-colors ${!isMergedView ? 'bg-indigo-100 text-indigo-700 font-bold' : 'text-gray-500 hover:bg-gray-100'}`}>
                                        Từng phần
                                    </button>
                                    <button onClick={handleMergeResults} className={`px-3 py-1 text-sm rounded-md transition-colors ${isMergedView ? 'bg-indigo-100 text-indigo-700 font-bold' : 'text-gray-500 hover:bg-gray-100'}`}>
                                        Gộp & Đối chiếu
                                    </button>
                                </div>
                            </div>
                        </div>

                        {/* Controls for Separate View */}
                        {!isMergedView && chunks.some(c => c.status === 'completed') && (
                            <div className="flex justify-between items-center mb-3 bg-gray-100 dark:bg-gray-700 p-2 rounded text-xs text-gray-600 dark:text-gray-300">
                                <div className="space-x-3">
                                    <label className="inline-flex items-center cursor-pointer hover:text-indigo-500">
                                        <input type="checkbox" className="mr-1 rounded text-indigo-600 focus:ring-indigo-500" 
                                            checked={chunks.filter(c => c.status === 'completed').every(c => c.isCheckedForMerge)}
                                            onChange={(e) => toggleAllMergeCheckbox(e.target.checked)}
                                        />
                                        Chọn tất cả để gộp
                                    </label>
                                </div>
                                <div className="space-x-2">
                                    <button onClick={() => toggleAllResultsExpand(true)} className="hover:text-indigo-500">Mở rộng hết</button>
                                    <span>|</span>
                                    <button onClick={() => toggleAllResultsExpand(false)} className="hover:text-indigo-500">Thu gọn hết</button>
                                </div>
                            </div>
                        )}

                        <div className="flex-1 overflow-y-auto custom-scrollbar">
                            {/* VIEW: MERGED */}
                            {isMergedView && mergedResult && (
                                <div>
                                    <div className="mb-4 p-2 bg-indigo-50 border border-indigo-200 text-indigo-800 rounded text-center text-sm">
                                        Đang xem bảng gộp của <b>{chunks.filter(c => c.isCheckedForMerge && c.status === 'completed').length}</b> phần được chọn.
                                    </div>
                                    <ResultTable 
                                        accountInfo={mergedResult.accountInfo} 
                                        transactions={mergedResult.transactions} 
                                        openingBalance={mergedResult.openingBalance}
                                        onUpdateTransaction={(idx, field, val) => handleTransactionUpdate(idx, field, val)}
                                        onUpdateTransactionString={(idx, field, val) => handleTransactionUpdate(idx, field, val)}
                                        balanceMismatchWarning={balanceMismatchWarning}
                                    />
                                    <ChatAssistant 
                                        reportData={mergedResult}
                                        rawStatementContent={"[Merged Data]"}
                                        onUpdateTransaction={(idx, f, v) => handleTransactionUpdate(idx, f, v)}
                                        onTransactionAdd={() => {}}
                                        onUndoLastChange={() => {}}
                                    />
                                </div>
                            )}

                            {/* VIEW: SEPARATE LIST */}
                            {!isMergedView && (
                                <div className="space-y-4">
                                    {chunks.filter(c => c.status === 'completed' && c.result).map((chunk) => (
                                        <div key={chunk.id} className="border border-gray-200 dark:border-gray-700 rounded-lg bg-gray-50 dark:bg-gray-900/30 overflow-hidden">
                                            {/* HEADER CARD */}
                                            <div className="p-3 bg-gray-100 dark:bg-gray-800 flex items-center justify-between cursor-pointer select-none" onClick={() => toggleResultExpand(chunk.id)}>
                                                <div className="flex items-center gap-3" onClick={(e) => e.stopPropagation()}>
                                                    <input 
                                                        type="checkbox" 
                                                        className="h-5 w-5 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                                                        checked={chunk.isCheckedForMerge}
                                                        onChange={() => toggleMergeCheckbox(chunk.id)}
                                                        title="Tick để chọn gộp phần này"
                                                    />
                                                    <span className="font-bold text-gray-700 dark:text-gray-200" onClick={() => toggleResultExpand(chunk.id)}>
                                                        Phần {chunk.index} 
                                                        <span className="ml-2 text-xs font-normal text-gray-500">({chunk.processingMessage}) - {chunk.result?.transactions.length} dòng</span>
                                                    </span>
                                                </div>
                                                <button className="text-gray-500 hover:text-indigo-600 transition-colors transform duration-200" style={{ transform: chunk.isResultExpanded ? 'rotate(180deg)' : 'rotate(0deg)' }}>
                                                    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                                                        <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
                                                    </svg>
                                                </button>
                                            </div>

                                            {/* CONTENT */}
                                            {chunk.isResultExpanded && chunk.result && (
                                                <div className="p-4 border-t border-gray-200 dark:border-gray-700">
                                                    <ResultTable 
                                                        accountInfo={chunk.result.accountInfo} 
                                                        transactions={chunk.result.transactions} 
                                                        // Nếu phần này được chọn đầu tiên trong danh sách merge -> Dùng số dư đầu kỳ user nhập
                                                        // Nếu không -> Dùng số dư đầu do AI trích xuất
                                                        openingBalance={chunk.index === 1 ? (parseFloat(openingBalance) || chunk.result.openingBalance) : chunk.result.openingBalance} 
                                                        onUpdateTransaction={(idx, f, v) => updateChunkResult(chunk.id, idx, f, v)}
                                                        onUpdateTransactionString={(idx, f, v) => updateChunkResultString(chunk.id, idx, f, v)}
                                                        balanceMismatchWarning={null} // Không hiện warning ở view lẻ
                                                    />
                                                </div>
                                            )}
                                        </div>
                                    ))}
                                    {chunks.filter(c => c.status === 'completed').length === 0 && (
                                        <div className="text-center text-gray-400 mt-20">
                                            Chưa có kết quả. Vui lòng chọn phần dữ liệu và bấm "Bắt đầu Xử lý".
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}