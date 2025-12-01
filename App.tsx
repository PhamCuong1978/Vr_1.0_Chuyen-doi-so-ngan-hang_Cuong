import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { processBatchData, extractTextFromContent } from './services/geminiService';
import type { Transaction, GeminiResponse } from './types';
import { UploadIcon, ProcessIcon } from './components/Icons';
import ChatAssistant from './components/ChatAssistant';
import ResultTable from './components/ResultTable';
import { extractFromFile } from './utils/fileHelper';
import { formatCurrency } from './utils/formatters';
import { CURRENT_VERSION } from './utils/version';

type LoadingState = 'idle' | 'extracting' | 'processing';
type UploadState = 'idle' | 'uploading' | 'completed';

export default function App() {
    const [openingBalance, setOpeningBalance] = useState('');
    // Lưu trữ text thô để hiện preview
    const [statementContent, setStatementContent] = useState<string>(() => localStorage.getItem('statementContent') || '');
    // MỚI: Lưu trữ danh sách các phần tử đã trích xuất để gửi đi xử lý (Text chunks hoặc Image List)
    const [processedChunks, setProcessedChunks] = useState<{ type: 'text' | 'image', data: string }[]>([]);
    
    const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
    
    // State cho quy trình Upload
    const [uploadState, setUploadState] = useState<UploadState>('idle');
    const [uploadProgress, setUploadProgress] = useState(0);

    const [loadingState, setLoadingState] = useState<LoadingState>('idle');
    const [progress, setProgress] = useState(0);
    const [processingStatus, setProcessingStatus] = useState<string>(''); // Hiển thị chi tiết: "Đang xử lý phần 1/5"

    const [error, setError] = useState<string | null>(null);
    const [result, setResult] = useState<GeminiResponse | null>(null);
    const [balanceMismatchWarning, setBalanceMismatchWarning] = useState<string | null>(null);
    const [history, setHistory] = useState<GeminiResponse[]>([]);
    
    const uploadInterval = useRef<number | null>(null);

    const isLoading = loadingState !== 'idle';
    
    useEffect(() => {
        localStorage.setItem('statementContent', statementContent);
    }, [statementContent]);

    useEffect(() => {
        console.log(`App Version ${CURRENT_VERSION} Loaded`);
        return () => {
            if (uploadInterval.current) clearInterval(uploadInterval.current);
        };
    }, []);
    
    const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        const files = event.target.files;
        if (files && files.length > 0) {
            const newFiles = Array.from(files);
            
            setResult(null);
            setStatementContent('');
            setProcessedChunks([]); // Reset chunks
            setBalanceMismatchWarning(null);
            setError(null);
            setLoadingState('idle');

            setSelectedFiles(prev => [...prev, ...newFiles]);
            event.target.value = '';
            simulateUploadProcess();
        }
    };

    const handleRemoveFile = (indexToRemove: number) => {
        setSelectedFiles(prev => {
            const newFiles = prev.filter((_, index) => index !== indexToRemove);
            if (newFiles.length === 0) {
                setUploadState('idle');
                setUploadProgress(0);
                setStatementContent('');
                setProcessedChunks([]);
            }
            return newFiles;
        });
        setResult(null);
        setStatementContent('');
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
        setResult(null);
        setStatementContent('');
        setProcessedChunks([]);
        setOpeningBalance('');
    };

    const handleExtractText = async () => {
        if (selectedFiles.length === 0) {
            setError('Vui lòng chọn file trước khi trích xuất.');
            return;
        }

        const hasImagesOrPDF = selectedFiles.some(f => f.type.startsWith('image/') || f.type === 'application/pdf');
        
        setLoadingState('extracting');
        setError(null);
        setProcessingStatus(hasImagesOrPDF ? "Đang tách trang PDF/Ảnh..." : "Đang đọc & Chia nhỏ văn bản...");
        
        try {
            const extractionPromises = selectedFiles.map((file: File) => extractFromFile(file));
            const results = await Promise.all(extractionPromises);
            
            const allChunks: { type: 'text' | 'image', data: string }[] = [];
            let fullPreviewText = '';

            for (const res of results) {
                if (res.images.length > 0) {
                    // TRƯỜNG HỢP 1: PDF hoặc Ảnh -> Chia theo trang/ảnh
                    res.images.forEach(img => {
                        allChunks.push({ type: 'image', data: img.data });
                    });
                    fullPreviewText += `[Đã tải ${res.images.length} trang hình ảnh/PDF]\n`;
                } else if (res.text) {
                    // TRƯỜNG HỢP 2: Text/Excel -> Chia nhỏ theo 20 dòng
                    fullPreviewText += res.text + '\n\n';
                    
                    const lines = res.text.split('\n');
                    const CHUNK_SIZE = 20; 
                    // Giữ lại Header (khoảng 5-10 dòng đầu) để AI hiểu ngữ cảnh cho các chunk sau
                    // Giả sử 10 dòng đầu là header
                    const header = lines.slice(0, 10).join('\n');
                    const body = lines.slice(10); // Phần còn lại là giao dịch

                    if (body.length === 0) {
                         // File quá ngắn, gửi cả cục
                         allChunks.push({ type: 'text', data: res.text });
                    } else {
                        for (let i = 0; i < body.length; i += CHUNK_SIZE) {
                            const chunkBody = body.slice(i, i + CHUNK_SIZE).join('\n');
                            // Ghép Header + Chunk Body để AI không bị mất ngữ cảnh
                            const chunkContent = `--- HEADER INFO ---\n${header}\n--- TRANSACTIONS PART ${Math.floor(i/CHUNK_SIZE) + 1} ---\n${chunkBody}`;
                            allChunks.push({ type: 'text', data: chunkContent });
                        }
                    }
                }
            }

            setProcessedChunks(allChunks);
            setStatementContent(fullPreviewText.trim());
            setProcessingStatus(`Đã sẵn sàng xử lý ${allChunks.length} phần dữ liệu.`);

        } catch (err) {
            if (err instanceof Error) {
                setError(`Lỗi trích xuất: ${err.message}`);
            } else {
                    setError(`Lỗi trích xuất: ${String(err)}`);
            }
        } finally {
            setLoadingState('idle');
        }
    };

    const handleSubmit = async () => {
        if (processedChunks.length === 0) {
            setError('Không có dữ liệu. Vui lòng nhấn "Trích xuất dữ liệu" trước.');
            return;
        }

        setLoadingState('processing');
        setError(null);
        setResult(null);
        setBalanceMismatchWarning(null);
        setHistory([]); 
        
        // Reset tiến trình
        setProgress(0);
        setProcessingStatus(`Chuẩn bị xử lý ${processedChunks.length} phần dữ liệu...`);

        try {
            // Gọi hàm xử lý Batch từ Service
            const data = await processBatchData(processedChunks, (current, total) => {
                const percent = Math.round((current / total) * 100);
                setProgress(percent);
                setProcessingStatus(`Đang xử lý phần ${current}/${total} (${percent}%)`);
            });
            
            setOpeningBalance(data.openingBalance?.toString() ?? '0');
            setResult(data);
            setHistory([data]);

            // Balance Cross-Check
            if (data.endingBalance !== undefined && data.endingBalance !== 0) {
                const { totalDebit, totalCredit, totalFee, totalVat } = data.transactions.reduce((acc, tx) => {
                    acc.totalDebit += tx.debit;
                    acc.totalCredit += tx.credit;
                    acc.totalFee += tx.fee || 0;
                    acc.totalVat += tx.vat || 0;
                    return acc;
                }, { totalDebit: 0, totalCredit: 0, totalFee: 0, totalVat: 0 });

                const openingBal = data.openingBalance || 0;
                const calculatedEndingBalance = openingBal + totalDebit - totalCredit - totalFee - totalVat;
                
                if (Math.abs(calculatedEndingBalance - data.endingBalance) > 1) { 
                    setBalanceMismatchWarning(`Số dư cuối kỳ tính toán (${formatCurrency(calculatedEndingBalance)}) không khớp với số dư trên sao kê (${formatCurrency(data.endingBalance)}). Chênh lệch: ${formatCurrency(calculatedEndingBalance - data.endingBalance)}.`);
                }
            }

        } catch (err) {
            if (err instanceof Error) {
                setError(err.message);
            } else {
                setError('Đã xảy ra lỗi không xác định khi xử lý sao kê.');
            }
        } finally {
            setLoadingState('idle');
            setProcessingStatus('Hoàn tất!');
        }
    };
    
    const handleTransactionUpdate = (index: number, field: 'debit' | 'credit' | 'fee' | 'vat', value: number) => {
        if (!result) return;
        setHistory(prev => [...prev, result]); 
        const updatedTransactions = [...result.transactions];
        const transactionToUpdate = { ...updatedTransactions[index] };
        if (field === 'fee' || field === 'vat') {
            (transactionToUpdate as any)[field] = value;
        } else {
            transactionToUpdate[field] = value;
        }
        updatedTransactions[index] = transactionToUpdate;
        setResult({ ...result, transactions: updatedTransactions });
    };

    const handleTransactionStringUpdate = (index: number, field: 'transactionCode' | 'date' | 'description', value: string) => {
        if (!result) return;
        setHistory(prev => [...prev, result]); 
        const updatedTransactions = [...result.transactions];
        const transactionToUpdate = { ...updatedTransactions[index] };
        transactionToUpdate[field] = value;
        updatedTransactions[index] = transactionToUpdate;
        setResult({ ...result, transactions: updatedTransactions });
    };

    const handleTransactionAdd = (transaction: Transaction) => {
        if (!result) return;
        setHistory(prev => [...prev, result]); 
        const newTransaction = {
            transactionCode: transaction.transactionCode || '',
            date: transaction.date || new Date().toLocaleDateString('vi-VN'),
            description: transaction.description || 'Giao dịch mới',
            debit: transaction.debit || 0,
            credit: transaction.credit || 0,
            fee: transaction.fee || 0,
            vat: transaction.vat || 0,
        };
        const updatedTransactions = [...result.transactions, newTransaction];
        setResult({ ...result, transactions: updatedTransactions });
    };

    const handleUndoLastChange = () => {
        if (history.length <= 1) return; 
        const lastState = history[history.length - 1];
        setResult(lastState);
        setHistory(prev => prev.slice(0, -1));
    };

    const getLoadingMessage = () => {
        return processingStatus;
    }
    
    useEffect(() => {
        if (!result) {
            setBalanceMismatchWarning(null);
            return;
        };
        const { endingBalance: extractedEndingBalance, transactions } = result;
        if (extractedEndingBalance !== undefined && extractedEndingBalance !== 0) {
            const { totalDebit, totalCredit, totalFee, totalVat } = transactions.reduce((acc, tx) => {
                acc.totalDebit += tx.debit;
                acc.totalCredit += tx.credit;
                acc.totalFee += tx.fee || 0;
                acc.totalVat += tx.vat || 0;
                return acc;
            }, { totalDebit: 0, totalCredit: 0, totalFee: 0, totalVat: 0 });
            const calculatedEndingBalance = (parseFloat(openingBalance) || 0) + totalDebit - totalCredit - totalFee - totalVat;
            if (Math.abs(calculatedEndingBalance - extractedEndingBalance) > 1) {
                setBalanceMismatchWarning(`Số dư cuối kỳ tính toán (${formatCurrency(calculatedEndingBalance)}) không khớp với số dư trên sao kê (${formatCurrency(extractedEndingBalance)}). Chênh lệch: ${formatCurrency(calculatedEndingBalance - extractedEndingBalance)}.`);
            } else {
                setBalanceMismatchWarning(null);
            }
        }
    }, [result, openingBalance]);

    return (
        <div className="min-h-screen text-gray-800 dark:text-gray-200 p-4 sm:p-6 lg:p-8">
            <div className="max-w-7xl mx-auto">
                <header className="text-center mb-8">
                    <h1 className="text-3xl sm:text-4xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-blue-500 to-teal-400">
                        Chuyển Đổi Sổ Phụ Ngân Hàng Thành Sổ Kế Toán
                    </h1>
                    <p className="mt-2 text-gray-600 dark:text-gray-400 flex items-center justify-center gap-2">
                        <span>Upload sao kê (Excel, PDF, Ảnh), chia nhỏ xử lý thông minh & chính xác.</span>
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200 border border-purple-200 dark:border-purple-700">
                            Version {CURRENT_VERSION}
                        </span>
                    </p>
                </header>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                    <div className="bg-white dark:bg-gray-800 p-6 rounded-xl shadow-lg">
                        <h2 className="text-2xl font-bold mb-4 text-gray-800 dark:text-gray-200">THÔNG TIN ĐẦU VÀO</h2>
                        
                        <div className={`transition-opacity duration-300 ease-in-out ${isLoading ? 'opacity-50 pointer-events-none' : ''}`}>
                            
                            {/* BƯỚC 1: UPLOAD FILE */}
                            <div className="mb-6">
                                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                                    1. Upload file Sao kê (Excel/Word/PDF/Ảnh)
                                </label>
                                
                                {selectedFiles.length > 0 && (
                                    <div className="mb-3 space-y-2">
                                        {selectedFiles.map((file, idx) => (
                                            <div key={`${file.name}-${idx}`} className="flex items-center justify-between bg-gray-50 dark:bg-gray-700 rounded-lg p-3 border border-gray-200 dark:border-gray-600">
                                                <div className="flex items-center overflow-hidden">
                                                    <div className="p-1.5 rounded-full bg-blue-100 text-blue-600 mr-3">
                                                         <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                                                        </svg>
                                                    </div>
                                                    <div className="truncate">
                                                        <p className="text-sm font-medium text-gray-900 dark:text-white truncate max-w-[200px]">{file.name}</p>
                                                        <p className="text-xs text-gray-500 dark:text-gray-400">{(file.size / 1024).toFixed(1)} KB</p>
                                                    </div>
                                                </div>
                                                <button onClick={() => handleRemoveFile(idx)} className="text-gray-400 hover:text-red-500 p-1" title="Xóa file">
                                                    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                                                        <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                                                    </svg>
                                                </button>
                                            </div>
                                        ))}
                                    </div>
                                )}

                                <div className="space-y-2">
                                    <label htmlFor="file-upload" className={`relative cursor-pointer bg-white dark:bg-gray-700 rounded-md font-medium text-indigo-600 dark:text-indigo-400 hover:text-indigo-500 focus-within:outline-none focus-within:ring-2 focus-within:ring-offset-2 focus-within:ring-indigo-500 border-2 border-dashed border-gray-300 dark:border-gray-600 flex flex-col items-center justify-center ${selectedFiles.length > 0 ? 'p-4' : 'p-6'} hover:border-indigo-500 dark:hover:border-indigo-400 transition-colors`}>
                                        <div className="flex items-center space-x-2">
                                            <UploadIcon/>
                                            <span className="text-sm">{selectedFiles.length > 0 ? 'Thêm file khác' : 'Chọn tệp (Excel, Word, PDF, Ảnh)'}</span>
                                        </div>
                                        <input id="file-upload" name="file-upload" type="file" className="sr-only" onChange={handleFileChange} accept=".pdf,.docx,.xlsx,.xls,.txt,.csv,.png,.jpg,.jpeg,.bmp" multiple/>
                                    </label>
                                    
                                    {uploadState === 'uploading' && (
                                         <div className="w-full bg-gray-200 rounded-full h-1.5 dark:bg-gray-600 overflow-hidden mt-2">
                                            <div className="h-1.5 rounded-full bg-blue-500 transition-all duration-300" style={{ width: `${uploadProgress}%` }}></div>
                                        </div>
                                    )}
                                    
                                    {selectedFiles.length > 0 && (
                                        <div className="flex justify-end">
                                            <button onClick={handleResetUpload} className="text-xs text-red-500 hover:underline">
                                                Xóa tất cả ({selectedFiles.length})
                                            </button>
                                        </div>
                                    )}
                                </div>
                            </div>

                            {/* BƯỚC 2: TRÍCH XUẤT */}
                            <div className="mb-6">
                                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                                    2. Chuẩn bị dữ liệu (Tách trang / Chia dòng)
                                </label>
                                <button
                                    onClick={handleExtractText}
                                    disabled={selectedFiles.length === 0 || loadingState === 'extracting'}
                                    className={`w-full flex items-center justify-center px-4 py-3 border border-transparent text-sm font-medium rounded-md transition-all
                                        ${selectedFiles.length > 0 && uploadState !== 'uploading'
                                            ? 'text-white bg-indigo-600 hover:bg-indigo-700 shadow-md transform hover:-translate-y-0.5' 
                                            : 'bg-gray-100 text-gray-400 cursor-not-allowed dark:bg-gray-700 dark:text-gray-500'}
                                    `}
                                >
                                    {loadingState === 'extracting' ? <ProcessIcon /> : null}
                                    {loadingState === 'extracting' 
                                        ? 'Đang chuẩn bị...' 
                                        : `Trích xuất & Chia nhỏ (${selectedFiles.length} file)`
                                    }
                                </button>
                                {processedChunks.length > 0 && (
                                    <div className="mt-2 p-2 bg-indigo-50 text-indigo-700 rounded text-xs text-center border border-indigo-200">
                                        Đã chia thành <b>{processedChunks.length}</b> phần nhỏ để xử lý chính xác.
                                    </div>
                                )}
                            </div>
                            
                            {/* BƯỚC 3: NỘI DUNG */}
                            <div className="mb-4">
                                <label htmlFor="statementContent" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                                    3. Xem trước (Preview gộp)
                                </label>
                                <textarea
                                    id="statementContent"
                                    rows={6}
                                    value={statementContent}
                                    onChange={(e) => setStatementContent(e.target.value)}
                                    placeholder="Nội dung văn bản trích xuất sẽ hiện ở đây..."
                                    className="w-full px-3 py-2 text-gray-900 dark:text-white bg-gray-50 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
                                    disabled
                                />
                            </div>

                             {/* BƯỚC 4: SỐ DƯ */}
                             <div className="mb-4">
                                <label htmlFor="openingBalance" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                                    4. Số dư đầu kỳ (Tùy chọn)
                                </label>
                                <input
                                    type="text"
                                    id="openingBalance"
                                    value={openingBalance ? new Intl.NumberFormat('vi-VN').format(parseFloat(openingBalance.replace(/\./g, ''))) : ''}
                                    onChange={(e) => {
                                        const value = e.target.value.replace(/\./g, '');
                                        if (!isNaN(parseFloat(value)) || value === '') {
                                            setOpeningBalance(value);
                                        }
                                    }}
                                    placeholder="Nhập số dư đầu kỳ nếu có..."
                                    className="w-full px-3 py-2 text-gray-900 dark:text-white bg-gray-50 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
                                />
                            </div>
                        </div>

                        {/* Loading cho BƯỚC 5 */}
                        {isLoading && loadingState === 'processing' && (
                            <div className="mt-4">
                                <div className="flex justify-between text-xs text-gray-500 mb-1">
                                    <span>Tiến trình xử lý</span>
                                    <span>{Math.round(progress)}%</span>
                                </div>
                                <div className="w-full bg-gray-200 rounded-full h-3 dark:bg-gray-700 overflow-hidden">
                                    <div className="bg-gradient-to-r from-blue-500 to-green-500 h-3 rounded-full transition-all duration-500 ease-out" style={{ width: `${progress}%` }}></div>
                                </div>
                                <p className="text-center text-sm font-medium text-indigo-600 dark:text-indigo-400 mt-2 animate-pulse">{getLoadingMessage()}</p>
                            </div>
                        )}

                         {/* BƯỚC 5: XỬ LÝ */}
                         <div className="mt-6">
                             <button
                                 onClick={handleSubmit}
                                 disabled={isLoading || processedChunks.length === 0}
                                 className="w-full flex items-center justify-center px-6 py-3 border border-transparent text-base font-medium rounded-md shadow-sm text-white bg-green-600 hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-500 disabled:bg-green-400 disabled:cursor-not-allowed transition-colors"
                             >
                                 {loadingState === 'processing' ? <><ProcessIcon /> Đang xử lý tuần tự...</> : '5. Bắt đầu Xử lý & Gộp dữ liệu'}
                             </button>
                         </div>
                    </div>

                    <div className="bg-white dark:bg-gray-800 p-6 rounded-xl shadow-lg">
                        <h2 className="text-2xl font-bold mb-4 flex items-baseline">
                            Quy trình Batch Processing
                        </h2>
                        <ul className="space-y-4 text-gray-600 dark:text-gray-400">
                            <li className="flex items-start">
                                <span className="flex-shrink-0 flex items-center justify-center h-6 w-6 rounded-full bg-indigo-500 text-white font-bold text-sm mr-3">1</span>
                                <span><b>Chia nhỏ (Chunking):</b> PDF được tách thành từng trang. Excel/Word được chia thành từng đoạn (20 dòng).</span>
                            </li>
                            <li className="flex items-start">
                                <span className="flex-shrink-0 flex items-center justify-center h-6 w-6 rounded-full bg-indigo-500 text-white font-bold text-sm mr-3">2</span>
                                <span><b>Xử lý tuần tự:</b> AI xử lý từng phần nhỏ để đảm bảo độ chính xác tối đa và không bị lỗi Timeout.</span>
                            </li>
                             <li className="flex items-start">
                                <span className="flex-shrink-0 flex items-center justify-center h-6 w-6 rounded-full bg-indigo-500 text-white font-bold text-sm mr-3">3</span>
                                <span><b>Gộp (Merging):</b> Kết quả từ các phần được tự động ghép lại thành một bảng thống nhất.</span>
                            </li>
                            <li className="flex items-start">
                                <span className="flex-shrink-0 flex items-center justify-center h-6 w-6 rounded-full bg-green-500 text-white font-bold text-sm mr-3">4</span>
                                <span><b>Hoàn tất:</b> Bạn nhận được bảng kê chi tiết và chính xác.</span>
                            </li>
                        </ul>
                    </div>
                </div>

                {error && (
                    <div className="mt-8 p-4 bg-red-100 dark:bg-red-900 border border-red-400 dark:border-red-700 text-red-700 dark:text-red-200 rounded-lg">
                        <p className="font-bold">Đã xảy ra lỗi!</p>
                        <p>{error}</p>
                    </div>
                )}
                
                {result && (
                  <>
                    <ResultTable 
                        accountInfo={result.accountInfo} 
                        transactions={result.transactions} 
                        openingBalance={parseFloat(openingBalance) || 0}
                        onUpdateTransaction={handleTransactionUpdate}
                        onUpdateTransactionString={handleTransactionStringUpdate}
                        balanceMismatchWarning={balanceMismatchWarning}
                    />
                    <ChatAssistant 
                        reportData={result}
                        rawStatementContent={statementContent}
                        onUpdateTransaction={handleTransactionUpdate}
                        onUndoLastChange={handleUndoLastChange}
                        onTransactionAdd={handleTransactionAdd}
                    />
                  </>
                )}
            </div>
        </div>
    );
}