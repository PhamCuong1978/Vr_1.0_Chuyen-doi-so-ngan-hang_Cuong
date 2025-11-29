import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { processStatement, extractTextFromContent } from './services/geminiService';
import type { Transaction, GeminiResponse } from './types';
import { UploadIcon, ProcessIcon, CancelIcon } from './components/Icons';
import ChatAssistant from './components/ChatAssistant';
import ResultTable from './components/ResultTable';
import { extractFromFile } from './utils/fileHelper';
import { formatCurrency } from './utils/formatters';
import { CURRENT_VERSION } from './utils/version';

type LoadingState = 'idle' | 'extracting' | 'processing';
type UploadState = 'idle' | 'uploading' | 'completed';

export default function App() {
    const [openingBalance, setOpeningBalance] = useState('');
    const [statementContent, setStatementContent] = useState<string>(() => localStorage.getItem('statementContent') || '');
    // Bỏ state fileName đơn lẻ, dùng selectedFiles để render UI
    const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
    
    // State cho quy trình Upload
    const [uploadState, setUploadState] = useState<UploadState>('idle');
    const [uploadProgress, setUploadProgress] = useState(0);

    const [loadingState, setLoadingState] = useState<LoadingState>('idle');
    const [progress, setProgress] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const [result, setResult] = useState<GeminiResponse | null>(null);
    const [balanceMismatchWarning, setBalanceMismatchWarning] = useState<string | null>(null);
    const [history, setHistory] = useState<GeminiResponse[]>([]);
    const progressInterval = useRef<number | null>(null);
    const uploadInterval = useRef<number | null>(null);

    const isLoading = loadingState !== 'idle';
    
    useEffect(() => {
        localStorage.setItem('statementContent', statementContent);
    }, [statementContent]);

    useEffect(() => {
        console.log(`App Version ${CURRENT_VERSION} Loaded`);
        return () => {
            if (progressInterval.current) clearInterval(progressInterval.current);
            if (uploadInterval.current) clearInterval(uploadInterval.current);
        };
    }, []);
    
    const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        const files = event.target.files;
        if (files && files.length > 0) {
            const newFiles = Array.from(files);
            
            // Reset kết quả xử lý cũ vì đầu vào đã thay đổi
            setResult(null);
            setStatementContent('');
            setBalanceMismatchWarning(null);
            setError(null);
            setLoadingState('idle');

            // Nối file mới vào danh sách cũ
            setSelectedFiles(prev => {
                // Có thể thêm logic lọc trùng lặp ở đây nếu cần, hiện tại cho phép trùng tên
                return [...prev, ...newFiles];
            });

            // Reset input value để cho phép chọn lại cùng 1 file nếu muốn (dù ít khi xảy ra)
            event.target.value = '';

            // Bắt đầu giả lập quá trình Upload
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
            }
            return newFiles;
        });
        // Reset kết quả nếu thay đổi file nguồn
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
                return prev + 15; // Tăng nhanh hơn chút
            });
        }, 80); 
    };

    // Hàm Hủy / Reset toàn bộ (STOP EVERYTHING)
    const handleCancel = () => {
        // 1. Dừng ngay lập tức các interval đang chạy
        if (progressInterval.current) {
            clearInterval(progressInterval.current);
            progressInterval.current = null;
        }
        if (uploadInterval.current) {
            clearInterval(uploadInterval.current);
            uploadInterval.current = null;
        }

        // 2. Reset trạng thái UI về Idle
        setLoadingState('idle');
        setUploadState('idle');
        setProgress(0);
        setUploadProgress(0);
        
        // 3. Xóa dữ liệu (Về trạng thái ban đầu)
        setSelectedFiles([]);
        setStatementContent('');
        setOpeningBalance('');
        setResult(null);
        setHistory([]);
        setError(null);
        setBalanceMismatchWarning(null);
        
        // Clear local storage nếu cần thiết để sạch hoàn toàn
        localStorage.removeItem('statementContent');
    };

    // Tương thích ngược nếu cần dùng (nhưng giờ handleCancel đã bao gồm)
    const handleResetUpload = handleCancel;

    const handleExtractText = async () => {
        if (selectedFiles.length === 0) {
            setError('Vui lòng chọn file trước khi trích xuất.');
            return;
        }

        setLoadingState('extracting');
        setError(null);
        startProgress("Gemini Flash đang đọc ảnh...");

        try {
            const extractionPromises = selectedFiles.map((file: File) => extractFromFile(file));
            const results = await Promise.all(extractionPromises);
            
            const allTexts = results.map(r => r.text).filter(Boolean);
            const allImages = results.flatMap(r => r.images);

            let combinedText = allTexts.join('\n\n--- TÁCH BIỆT FILE ---\n\n');

            if(allImages.length > 0) {
                const textFromImages = await extractTextFromContent({ images: allImages });
                combinedText += '\n\n' + textFromImages;
            }

            setStatementContent(combinedText.trim());

        } catch (err) {
            // Nếu là lỗi do user hủy (nếu có cơ chế abort) thì không hiện
            if (loadingState === 'idle') return;

            if (err instanceof Error) {
                setError(`Lỗi trích xuất: ${err.message}`);
            } else {
                    setError(`Lỗi trích xuất: ${String(err)}`);
            }
        } finally {
            // Chỉ finish nếu chưa bị Cancel
            if (loadingState !== 'idle') {
                finishProgress();
                setLoadingState('idle');
            }
        }
    };

    const startProgress = (message: string) => {
        setProgress(0);
        if (progressInterval.current) clearInterval(progressInterval.current);

        progressInterval.current = window.setInterval(() => {
            setProgress(prev => {
                if (prev >= 95) {
                    if (progressInterval.current) clearInterval(progressInterval.current);
                    return 95;
                }
                const newProgress = Math.min(prev + Math.random() * 5, 95);
                return newProgress;
            });
        }, 300);
    };


    const finishProgress = () => {
        if (progressInterval.current) clearInterval(progressInterval.current);
        setProgress(100);
        setTimeout(() => {
            setLoadingState('idle');
            setProgress(0);
        } , 500);
    };

    const handleSubmit = async () => {
        if (!statementContent) {
            setError('Không có nội dung sao kê để xử lý. Vui lòng trích xuất văn bản hoặc dán nội dung.');
            return;
        }
        setLoadingState('processing');
        setError(null);
        setResult(null);
        setBalanceMismatchWarning(null);
        setHistory([]); // Reset history on new processing
        startProgress("DeepSeek V3 đang phân tích nghiệp vụ...");

        try {
            const data = await processStatement({ text: statementContent });
            
            // Kiểm tra lại nếu user đã cancel trong lúc chờ
            if (loadingState === 'idle') return;

            setOpeningBalance(data.openingBalance?.toString() ?? '0');
            setResult(data);
            setHistory([data]); // Set initial state for undo

            // Balance Cross-Check Logic
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
                
                // Use a small tolerance for floating point comparison
                if (Math.abs(calculatedEndingBalance - data.endingBalance) > 1) { // Tolerance of 1 unit (e.g., 1 VND)
                    setBalanceMismatchWarning(`Số dư cuối kỳ tính toán (${formatCurrency(calculatedEndingBalance)}) không khớp với số dư trên sao kê (${formatCurrency(data.endingBalance)}). Chênh lệch: ${formatCurrency(calculatedEndingBalance - data.endingBalance)}. Vui lòng rà soát lại các giao dịch.`);
                }
            }

        } catch (err) {
            if (loadingState === 'idle') return;

            if (err instanceof Error) {
                setError(err.message);
            } else {
                setError('Đã xảy ra lỗi không xác định khi xử lý sao kê.');
            }
        } finally {
            if (loadingState !== 'idle') {
                finishProgress();
            }
        }
    };
    
    const handleTransactionUpdate = (index: number, field: 'debit' | 'credit' | 'fee' | 'vat', value: number) => {
        if (!result) return;
        
        setHistory(prev => [...prev, result]); // Save current state before updating

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
        
        setHistory(prev => [...prev, result]); // Save current state before updating

        const updatedTransactions = [...result.transactions];
        const transactionToUpdate = { ...updatedTransactions[index] };
        
        transactionToUpdate[field] = value;
        
        updatedTransactions[index] = transactionToUpdate;

        setResult({ ...result, transactions: updatedTransactions });
    };

    const handleTransactionAdd = (transaction: Transaction) => {
        if (!result) return;
        setHistory(prev => [...prev, result]); // Save current state before adding
        
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
        if (history.length <= 1) return; // Don't undo the initial state

        const lastState = history[history.length - 1];
        setResult(lastState);
        setHistory(prev => prev.slice(0, -1));
    };


    const getLoadingMessage = () => {
        switch(loadingState) {
            case 'extracting': return `Gemini Flash đang đọc ảnh... ${Math.round(progress)}%`;
            case 'processing': return `DeepSeek V3 đang phân tích... ${Math.round(progress)}%`;
            default: return '';
        }
    }
    
    // Recalculate warning on data change
    useEffect(() => {
        if (!result) {
            setBalanceMismatchWarning(null);
            return;
        };

        const { openingBalance: openingBal, endingBalance: extractedEndingBalance, transactions } = result;
        
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
                setBalanceMismatchWarning(`Số dư cuối kỳ tính toán (${formatCurrency(calculatedEndingBalance)}) không khớp với số dư trên sao kê (${formatCurrency(extractedEndingBalance)}). Chênh lệch: ${formatCurrency(calculatedEndingBalance - extractedEndingBalance)}. Vui lòng rà soát lại các giao dịch.`);
            } else {
                setBalanceMismatchWarning(null);
            }
        }

    }, [result, openingBalance]);

    const isBusy = isLoading || uploadState === 'uploading';

    return (
        <div className="min-h-screen text-gray-800 dark:text-gray-200 p-4 sm:p-6 lg:p-8">
            <div className="max-w-7xl mx-auto">
                <header className="text-center mb-8">
                    <h1 className="text-3xl sm:text-4xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-blue-500 to-teal-400">
                        Chuyển Đổi Sổ Phụ Ngân Hàng Thành Sổ Kế Toán
                    </h1>
                    <p className="mt-2 text-gray-600 dark:text-gray-400 flex items-center justify-center gap-2">
                        <span>Upload sao kê, kiểm tra số dư và nhận ngay bảng dữ liệu theo chuẩn kế toán.</span>
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200 border border-purple-200 dark:border-purple-700">
                            Version {CURRENT_VERSION}
                        </span>
                    </p>
                </header>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                    <div className="bg-white dark:bg-gray-800 p-6 rounded-xl shadow-lg relative">
                        
                        <div className="flex justify-between items-center mb-4">
                            <h2 className="text-2xl font-bold text-gray-800 dark:text-gray-200">THÔNG TIN ĐẦU VÀO</h2>
                            {/* NÚT HỦY BỎ / RESET TOÀN BỘ */}
                            <button
                                onClick={handleCancel}
                                title={isBusy ? "Dừng ngay mọi tiến trình" : "Làm mới lại từ đầu"}
                                className={`flex items-center px-3 py-1.5 text-sm font-medium rounded-lg transition-colors border shadow-sm
                                    ${isBusy 
                                        ? 'text-red-600 bg-red-100 hover:bg-red-200 border-red-200 dark:bg-red-900 dark:text-red-300 dark:border-red-800 animate-pulse' 
                                        : 'text-gray-600 bg-gray-100 hover:bg-gray-200 border-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:border-gray-600'
                                    }`}
                            >
                                <CancelIcon />
                                {isBusy ? 'Dừng & Thoát' : 'Làm mới'}
                            </button>
                        </div>
                        
                        <div className={`transition-opacity duration-300 ease-in-out ${isLoading ? 'opacity-50 pointer-events-none' : ''}`}>
                            
                            {/* BƯỚC 1: UPLOAD FILE (HỖ TRỢ MULTI-FILE) */}
                            <div className="mb-6">
                                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                                    1. Upload file Sao kê (Chọn file nguồn)
                                </label>
                                
                                {/* Danh sách file đã chọn */}
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
                                                <button onClick={() => handleRemoveFile(idx)} className="text-gray-400 hover:text-red-500 p-1" title="Xóa file này">
                                                    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                                                        <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                                                    </svg>
                                                </button>
                                            </div>
                                        ))}
                                    </div>
                                )}

                                {/* Vùng chọn file (Luôn hiển thị để thêm file) */}
                                <div className="space-y-2">
                                    <label htmlFor="file-upload" className={`relative cursor-pointer bg-white dark:bg-gray-700 rounded-md font-medium text-indigo-600 dark:text-indigo-400 hover:text-indigo-500 focus-within:outline-none focus-within:ring-2 focus-within:ring-offset-2 focus-within:ring-indigo-500 border-2 border-dashed border-gray-300 dark:border-gray-600 flex flex-col items-center justify-center ${selectedFiles.length > 0 ? 'p-4' : 'p-6'} hover:border-indigo-500 dark:hover:border-indigo-400 transition-colors`}>
                                        <div className="flex items-center space-x-2">
                                            <UploadIcon/>
                                            <span className="text-sm">{selectedFiles.length > 0 ? 'Thêm file khác' : 'Nhấn để chọn tệp (.pdf, .png, .jpg, .xlsx...)'}</span>
                                        </div>
                                        <input id="file-upload" name="file-upload" type="file" className="sr-only" onChange={handleFileChange} accept=".pdf,.docx,.xlsx,.txt,.png,.jpg,.jpeg,.bmp" multiple/>
                                    </label>
                                    
                                    {/* Thanh upload progress (nếu đang upload) */}
                                    {uploadState === 'uploading' && (
                                         <div className="w-full bg-gray-200 rounded-full h-1.5 dark:bg-gray-600 overflow-hidden mt-2">
                                            <div 
                                                className="h-1.5 rounded-full bg-blue-500 transition-all duration-300" 
                                                style={{ width: `${uploadProgress}%` }}
                                            ></div>
                                        </div>
                                    )}
                                </div>
                            </div>

                            {/* BƯỚC 2: TRÍCH XUẤT */}
                            <div className="mb-6">
                                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                                    2. Trích xuất văn bản (OCR để kiểm tra)
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
                                    {loadingState === 'extracting' ? 'Đang đọc ảnh...' : `Trích xuất dữ liệu (${selectedFiles.length} file)`}
                                </button>
                                {selectedFiles.length === 0 && (
                                    <p className="mt-2 text-xs text-gray-500 italic text-center">Vui lòng chọn file ở Bước 1 trước.</p>
                                )}
                            </div>
                            
                            {/* BƯỚC 3: NỘI DUNG */}
                            <div className="mb-4">
                                <label htmlFor="statementContent" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                                    3. Nội dung sao kê (kiểm tra & chỉnh sửa nếu cần)
                                </label>
                                <textarea
                                    id="statementContent"
                                    rows={6}
                                    value={statementContent}
                                    onChange={(e) => setStatementContent(e.target.value)}
                                    placeholder="Nội dung văn bản trích xuất sẽ hiện ở đây. Bạn có thể dùng ô này để đối chiếu với file gốc..."
                                    className="w-full px-3 py-2 text-gray-900 dark:text-white bg-gray-50 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
                                />
                            </div>

                             {/* BƯỚC 4: SỐ DƯ */}
                             <div className="mb-4">
                                <label htmlFor="openingBalance" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                                    4. Số dư đầu kỳ (AI sẽ tự động điền hoặc bạn có thể sửa)
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
                                    placeholder="Nhập hoặc chỉnh sửa số dư đầu kỳ..."
                                    className="w-full px-3 py-2 text-gray-900 dark:text-white bg-gray-50 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
                                />
                            </div>
                        </div>

                        {/* Loading cho BƯỚC 5 */}
                        {isLoading && loadingState === 'processing' && (
                            <div className="mt-4">
                                <div className="w-full bg-gray-200 rounded-full h-2.5 dark:bg-gray-700">
                                    <div className="bg-indigo-600 h-2.5 rounded-full transition-all duration-300" style={{ width: `${progress}%` }}></div>
                                </div>
                                <p className="text-center text-sm text-gray-600 dark:text-gray-400 mt-1">{getLoadingMessage()}</p>
                            </div>
                        )}

                         {/* BƯỚC 5: XỬ LÝ */}
                         <div className="mt-6">
                             <button
                                 onClick={handleSubmit}
                                 disabled={isLoading || !statementContent}
                                 className="w-full flex items-center justify-center px-6 py-3 border border-transparent text-base font-medium rounded-md shadow-sm text-white bg-green-600 hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-500 disabled:bg-green-400 disabled:cursor-not-allowed transition-colors"
                             >
                                 {loadingState === 'processing' ? <><ProcessIcon /> Đang phân tích...</> : '5. Xử lý Nghiệp vụ & Tạo Bảng'}
                             </button>
                         </div>
                    </div>

                    <div className="bg-white dark:bg-gray-800 p-6 rounded-xl shadow-lg">
                        <h2 className="text-2xl font-bold mb-4 flex items-baseline">
                            Quy trình làm việc
                        </h2>
                        <ul className="space-y-4 text-gray-600 dark:text-gray-400">
                            <li className="flex items-start">
                                <span className="flex-shrink-0 flex items-center justify-center h-6 w-6 rounded-full bg-indigo-500 text-white font-bold text-sm mr-3">1</span>
                                <span><b>Upload File:</b> Chọn một hoặc nhiều file sao kê (ảnh hoặc PDF). Bạn có thể thêm file mới liên tục.</span>
                            </li>
                            <li className="flex items-start">
                                <span className="flex-shrink-0 flex items-center justify-center h-6 w-6 rounded-full bg-indigo-500 text-white font-bold text-sm mr-3">2</span>
                                <span><b>Trích xuất Văn bản:</b> Nhấn nút "Trích xuất dữ liệu" để AI gộp và đọc nội dung từ tất cả các file.</span>
                            </li>
                             <li className="flex items-start">
                                <span className="flex-shrink-0 flex items-center justify-center h-6 w-6 rounded-full bg-indigo-500 text-white font-bold text-sm mr-3">3</span>
                                <span><b>Kiểm tra & Số dư:</b> Đọc lướt qua văn bản trích xuất và nhập/kiểm tra số dư đầu kỳ.</span>
                            </li>
                            <li className="flex items-start">
                                <span className="flex-shrink-0 flex items-center justify-center h-6 w-6 rounded-full bg-indigo-500 text-white font-bold text-sm mr-3">4</span>
                                <span><b>Xử lý Nghiệp vụ:</b> Nhấn nút xử lý (màu xanh lá). AI sẽ phân tích văn bản để tạo ra bảng kế toán chi tiết.</span>
                            </li>
                            <li className="flex items-start">
                                <span className="flex-shrink-0 flex items-center justify-center h-6 w-6 rounded-full bg-green-500 text-white font-bold text-sm mr-3">5</span>
                                <span><b>Chỉnh sửa & Xuất:</b> Sửa trực tiếp trên bảng, dùng Trợ lý AI để điều chỉnh, sau đó xuất file Excel/CSV.</span>
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