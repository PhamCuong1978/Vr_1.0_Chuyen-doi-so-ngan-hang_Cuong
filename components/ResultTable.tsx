import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import type { AccountInfo, Transaction } from '../types';
import { DownloadIcon, CopyIcon, OpenHtmlIcon, MicrophoneIcon } from './Icons';
import { CURRENT_VERSION } from '../utils/version';

// --- UTILS (Đưa vào nội bộ để tránh lỗi import trên Preview) ---
const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('vi-VN').format(value);
};
// --- END UTILS ---

interface ResultTableProps {
    accountInfo: AccountInfo;
    transactions: Transaction[];
    openingBalance: number;
    onUpdateTransaction: (index: number, field: 'debit' | 'credit' | 'fee' | 'vat', value: number) => void;
    onUpdateTransactionString: (index: number, field: 'transactionCode' | 'date' | 'description', value: string) => void;
    balanceMismatchWarning: string | null;
}

const ResultTable: React.FC<ResultTableProps> = ({ accountInfo, transactions, openingBalance, onUpdateTransaction, onUpdateTransactionString, balanceMismatchWarning }) => {
    const [copySuccess, setCopySuccess] = useState('');
    type EditableTransactionField = 'transactionCode' | 'date' | 'description' | 'debit' | 'credit' | 'fee' | 'vat';
    const [listeningFor, setListeningFor] = useState<{ index: number; field: EditableTransactionField } | null>(null);
    const recognitionRef = useRef<any>(null);

    useEffect(() => {
        console.log(`ResultTable Mounted - v${CURRENT_VERSION}`); 
        const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
        if (!SpeechRecognition) {
            console.warn("Speech Recognition not supported in this browser.");
            return;
        }
        const recognition = new SpeechRecognition();
        recognition.continuous = false;
        recognition.interimResults = false;
        recognition.lang = 'vi-VN';

        recognition.onresult = (event: any) => {
            const last = event.results.length - 1;
            const transcript = event.results[last][0].transcript.trim();
            
            if (listeningFor) {
                 const isNumericField = ['debit', 'credit', 'fee', 'vat'].includes(listeningFor.field);

                if (isNumericField) {
                    // Basic Vietnamese number parsing
                    let numericValue = parseFloat(transcript.replace(/,/g, '').replace(/\./g, '').replace(/\s/g, ''));
                    if (!isNaN(numericValue)) {
                        if (transcript.toLowerCase().includes('triệu')) {
                            numericValue *= 1000000;
                        } else if (transcript.toLowerCase().includes('nghìn') || transcript.toLowerCase().includes('ngàn')) {
                            numericValue *= 1000;
                        }
                        onUpdateTransaction(listeningFor.index, listeningFor.field as 'debit' | 'credit' | 'fee' | 'vat', numericValue);
                    }
                } else {
                    // It's a string field
                    onUpdateTransactionString(listeningFor.index, listeningFor.field as 'transactionCode' | 'date' | 'description', transcript);
                }
            }
        };

        recognition.onerror = (event: any) => {
            console.error("Speech recognition error:", event.error);
            if (event.error === 'no-speech') {
                return; 
            }
            let errorMessage = `Đã xảy ra lỗi nhận dạng giọng nói: ${event.error}.`;
             if (event.error === 'audio-capture') {
                errorMessage = "Không tìm thấy micrô. Vui lòng kiểm tra xem micrô đã được kết nối và cấp quyền trong trình duyệt.";
            } else if (event.error === 'not-allowed') {
                errorMessage = "Quyền truy cập micrô đã bị từ chối. Vui lòng vào cài đặt trình duyệt để cấp quyền.";
            }
            alert(errorMessage);
        };


        recognition.onend = () => {
            setListeningFor(null);
        };
        
        recognitionRef.current = recognition;

    }, [onUpdateTransaction, onUpdateTransactionString, listeningFor]);
    
    const handleVoiceInput = (index: number, field: EditableTransactionField) => {
        if (recognitionRef.current) {
            if (listeningFor) {
                recognitionRef.current.stop();
                setListeningFor(null);
            } else {
                setListeningFor({ index, field });
                recognitionRef.current.start();
            }
        } else {
             alert("Trình duyệt không hỗ trợ nhận dạng giọng nói.");
        }
    };


    const { totalDebit, totalCredit, totalFee, totalVat, totalNetCredit, calculatedEndingBalance } = useMemo(() => {
        const totals = transactions.reduce((acc, tx) => {
            acc.totalDebit += tx.debit; // PS Nợ (Tổng)
            acc.totalCredit += tx.credit; // PS Có (Tổng)
            acc.totalFee += tx.fee || 0;
            acc.totalVat += tx.vat || 0;
            
            // Số tiền giao dịch (Net) = Tổng - Phí - VAT
            // Lưu ý: Chỉ tính Net cho Credit (Tiền ra), vì Fee/VAT thường trừ vào tiền ra.
            const netCredit = tx.credit - (tx.fee || 0) - (tx.vat || 0);
            acc.totalNetCredit += netCredit;
            
            return acc;
        }, { totalDebit: 0, totalCredit: 0, totalFee: 0, totalVat: 0, totalNetCredit: 0 });
        
        // Số dư = Đầu kỳ + Tổng Nợ - Tổng Có (Vì debit/credit giờ đã là số Tổng)
        const calculatedEndingBalance = openingBalance + totals.totalDebit - totals.totalCredit;
        return { ...totals, calculatedEndingBalance };
    }, [transactions, openingBalance]);


    const generateTableData = useCallback(() => {
        // Cập nhật Header cho CSV/Excel
        // "Phát Sinh Có" là cột tổng từ AI. "Số tiền giao dịch" là cột Net.
        const headers = ["Mã GD", "Ngày giá trị", "Nội dung thanh toán", "Phát Sinh Nợ (Vào)", "Phát Sinh Có (Ra/Tổng)", "Số tiền giao dịch (Gốc)", "Phí", "Thuế VAT", "Số dư"];
        let runningBalance = openingBalance;
        
        const rows = transactions.map(tx => {
            const netCredit = tx.credit - (tx.fee || 0) - (tx.vat || 0);
            runningBalance = runningBalance + tx.debit - tx.credit;
            return [
                tx.transactionCode || '',
                tx.date,
                tx.description,
                tx.debit,
                tx.credit,        // PS Có (Tổng)
                netCredit,        // Số tiền giao dịch (Net)
                tx.fee || 0,
                tx.vat || 0,
                runningBalance
            ];
        });

        const initialRow = ['', '', 'Số dư đầu kỳ', '', '', '', '', '', openingBalance];
        
        // Dòng tổng cộng
        const totalRow = ['', '', 'Cộng phát sinh', totalDebit, totalCredit, totalNetCredit, totalFee, totalVat, calculatedEndingBalance];

        return { headers, rows: [initialRow, ...rows, totalRow] };
    }, [transactions, openingBalance, totalDebit, totalCredit, totalFee, totalVat, totalNetCredit, calculatedEndingBalance]);


    const handleDownload = () => {
        const { headers, rows } = generateTableData();
        const accountInfoRows = [
            `"Tên tài khoản:","${accountInfo.accountName || 'N/A'}"`,
            `"Số tài khoản:","${accountInfo.accountNumber || 'N/A'}"`,
            `"Ngân hàng:","${accountInfo.bankName || 'N/A'}"`,
            `"Chi nhánh:","${accountInfo.branch || 'N/A'}"`,
            ''
        ];
        const csvContent = "data:text/csv;charset=utf-8," 
            + [...accountInfoRows, headers.join(','), ...rows.map(row => row.map(item => `"${String(item).replace(/"/g, '""')}"`).join(','))].join('\n');
        
        const encodedUri = encodeURI(csvContent);
        const link = document.createElement("a");
        link.setAttribute("href", encodedUri);
        link.setAttribute("download", `so_ke_ke_toan_v${CURRENT_VERSION}.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    const handleCopy = () => {
        const { headers, rows } = generateTableData();
         const accountInfoRows = [
            `Tên tài khoản:\t${accountInfo.accountName || 'N/A'}`,
            `Số tài khoản:\t${accountInfo.accountNumber || 'N/A'}`,
            `Ngân hàng:\t${accountInfo.bankName || 'N/A'}`,
            `Chi nhánh:\t${accountInfo.branch || 'N/A'}`,
            ''
        ];
        const tsvContent = [...accountInfoRows, headers.join('\t'), ...rows.map(row => row.join('\t'))].join('\n');
        
        navigator.clipboard.writeText(tsvContent).then(() => {
            setCopySuccess('Đã sao chép vào clipboard!');
            setTimeout(() => setCopySuccess(''), 2000);
        }, () => {
            setCopySuccess('Sao chép thất bại.');
            setTimeout(() => setCopySuccess(''), 2000);
        });
    };

    const handleOpenHtml = () => {
        let currentBalance = openingBalance;
        const tableRowsHtml = transactions.map(tx => {
            const netCredit = tx.credit - (tx.fee || 0) - (tx.vat || 0);
            currentBalance += tx.debit - tx.credit;
            return `
                <tr>
                    <td>${tx.transactionCode || ''}</td>
                    <td>${tx.date}</td>
                    <td>${tx.description}</td>
                    <td style="color: green;">${tx.debit > 0 ? formatCurrency(tx.debit) : ''}</td>
                    <td style="color: red; font-weight: bold;">${tx.credit > 0 ? formatCurrency(tx.credit) : ''}</td>
                    <td>${netCredit > 0 ? formatCurrency(netCredit) : ''}</td>
                    <td>${(tx.fee || 0) > 0 ? formatCurrency(tx.fee!) : ''}</td>
                    <td>${(tx.vat || 0) > 0 ? formatCurrency(tx.vat!) : ''}</td>
                    <td>${formatCurrency(currentBalance)}</td>
                </tr>
            `;
        }).join('');

        const htmlContent = `
            <!DOCTYPE html>
            <html lang="vi">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Sổ Kế Toán</title>
                <style>
                    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; margin: 2em; color: #333; }
                    h1, h3 { color: #1a202c; }
                    table { width: 100%; border-collapse: collapse; font-size: 0.9em; }
                    th, td { border: 1px solid #ddd; padding: 12px; text-align: left; }
                    th { background-color: #f2f2f2; font-weight: bold; }
                    tr:nth-child(even) { background-color: #f9f9f9; }
                    tr:hover { background-color: #f1f1f1; }
                    td:nth-child(4), td:nth-child(5), td:nth-child(6), td:nth-child(7), td:nth-child(8), td:nth-child(9) { text-align: right; font-family: monospace; }
                    tfoot tr { background-color: #f8fafc; font-weight: bold; }
                </style>
            </head>
            <body>
                <h1>Bảng Kê Kế Toán</h1>
                <h3>Thông tin tài khoản</h3>
                <p><strong>Tên tài khoản:</strong> ${accountInfo.accountName || 'N/A'}</p>
                <p><strong>Số tài khoản:</strong> ${accountInfo.accountNumber || 'N/A'}</p>
                <p><strong>Ngân hàng:</strong> ${accountInfo.bankName || 'N/A'}</p>
                <p><strong>Chi nhánh:</strong> ${accountInfo.branch || 'N/A'}</p>
                
                <table>
                    <thead>
                        <tr>
                            <th>Mã GD</th>
                            <th>Ngày</th>
                            <th>Nội dung</th>
                            <th>PS Nợ</th>
                            <th>PS Có (Tổng)</th>
                            <th>Số tiền Gốc</th>
                            <th>Phí</th>
                            <th>Thuế VAT</th>
                            <th>Số dư</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr style="font-weight: bold;">
                            <td colspan="8" style="text-align: center;">Số dư đầu kỳ</td>
                            <td>${formatCurrency(openingBalance)}</td>
                        </tr>
                        ${tableRowsHtml}
                    </tbody>
                     <tfoot>
                        <tr style="font-weight: bold; border-top: 2px solid #e2e8f0;">
                            <td colspan="3" style="text-align: center;">Cộng phát sinh</td>
                            <td style="text-align: right; color: green;">${formatCurrency(totalDebit)}</td>
                            <td style="text-align: right; color: red;">${formatCurrency(totalCredit)}</td>
                            <td style="text-align: right;">${formatCurrency(totalNetCredit)}</td>
                            <td style="text-align: right;">${formatCurrency(totalFee)}</td>
                            <td style="text-align: right;">${formatCurrency(totalVat)}</td>
                            <td style="text-align: right;">${formatCurrency(calculatedEndingBalance)}</td>
                        </tr>
                    </tfoot>
                </table>
            </body>
            </html>
        `;

        const blob = new Blob([htmlContent], { type: 'text/html' });
        const url = URL.createObjectURL(blob);
        window.open(url, '_blank');
    };


    let currentBalance = openingBalance;
    const editableCellClass = "px-1 py-1 bg-transparent text-right w-full focus:bg-white dark:focus:bg-gray-900 focus:ring-1 focus:ring-indigo-500 rounded";
    const editableTextCellClass = "px-1 py-1 bg-transparent text-left w-full focus:bg-white dark:focus:bg-gray-900 focus:ring-1 focus:ring-indigo-500 rounded";

    return (
        <div className="mt-8">
            <h2 className="text-2xl font-bold text-center text-gray-800 dark:text-gray-200">KẾT QUẢ ĐẦU RA</h2>
            
            <div className="p-4 bg-gray-50 dark:bg-gray-700 rounded-lg my-4 grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-2 text-sm text-gray-800 dark:text-gray-200">
                <div><strong className="font-semibold text-gray-600 dark:text-gray-400">Tên TK:</strong> {accountInfo.accountName || 'N/A'}</div>
                <div><strong className="font-semibold text-gray-600 dark:text-gray-400">Số TK:</strong> {accountInfo.accountNumber || 'N/A'}</div>
                <div><strong className="font-semibold text-gray-600 dark:text-gray-400">Ngân hàng:</strong> {accountInfo.bankName || 'N/A'}</div>
                <div><strong className="font-semibold text-gray-600 dark:text-gray-400">Chi nhánh:</strong> {accountInfo.branch || 'N/A'}</div>
            </div>

            {balanceMismatchWarning && (
                <div className="my-4 p-4 bg-yellow-100 dark:bg-yellow-900 border-l-4 border-yellow-500 text-yellow-700 dark:text-yellow-200 rounded-lg shadow-md">
                    <p className="font-bold">Cảnh báo đối chiếu!</p>
                    <p>{balanceMismatchWarning}</p>
                </div>
            )}
            <div className="flex justify-end my-4 space-x-2">
                <button onClick={handleCopy} className="flex items-center px-4 py-2 text-sm font-medium text-white bg-green-600 rounded-lg hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-500 transition-colors">
                    <CopyIcon /> {copySuccess || 'Copy Bảng'}
                </button>
                <button onClick={handleDownload} className="flex items-center px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-colors">
                    <DownloadIcon /> Download CSV
                </button>
                <button onClick={handleOpenHtml} className="flex items-center px-4 py-2 text-sm font-medium text-white bg-purple-600 rounded-lg hover:bg-purple-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-purple-500 transition-colors">
                    <OpenHtmlIcon /> Mở HTML
                </button>
            </div>
            <div className="overflow-x-auto bg-white dark:bg-gray-800 rounded-lg shadow">
                <table className="min-w-full text-sm text-left text-gray-500 dark:text-gray-400">
                    <thead className="text-xs text-gray-700 uppercase bg-gray-50 dark:bg-gray-700 dark:text-gray-400 sticky top-0 z-10">
                        <tr>
                            {["Mã GD", "Ngày", "Nội dung", "PS Nợ (Vào)", "PS Có (Ra)", "Số tiền Gốc", "Phí", "Thuế VAT", "Số dư"].map((header, idx) => (
                                <th key={header} scope="col" className={`px-2 md:px-6 py-3 ${idx === 0 ? 'sticky left-0 bg-gray-50 dark:bg-gray-700' : ''}`}>{header}</th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        <tr className="bg-white border-b dark:bg-gray-800 dark:border-gray-700 font-semibold">
                            <td colSpan={8} className="px-2 md:px-6 py-4 text-center sticky left-0 bg-white dark:bg-gray-800">Số dư đầu kỳ</td>
                            <td className="px-2 md:px-6 py-4 text-right">{formatCurrency(openingBalance)}</td>
                        </tr>
                        {transactions.map((tx, index) => {
                            // Logic tính toán: Net = Credit (Tổng) - Phí - VAT
                            const netCredit = tx.credit - (tx.fee || 0) - (tx.vat || 0);
                            
                            // Logic số dư lũy kế
                            currentBalance = openingBalance + transactions.slice(0, index + 1).reduce((acc, currentTx) => {
                                // currentTx.credit bây giờ là TỔNG nên trừ thẳng
                                return acc + currentTx.debit - currentTx.credit;
                            }, 0);
                            
                            const isListening = (field: EditableTransactionField) => listeningFor?.index === index && listeningFor?.field === field;

                            return (
                                <tr key={index} className="bg-white border-b dark:bg-gray-800 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600">
                                    <td className="px-2 md:px-6 py-4 sticky left-0 bg-white dark:bg-gray-800">
                                        <div className="flex items-center justify-start space-x-2">
                                            <input
                                                type="text"
                                                value={tx.transactionCode || ''}
                                                onChange={(e) => onUpdateTransactionString(index, 'transactionCode', e.target.value)}
                                                className={editableTextCellClass}
                                            />
                                            <MicrophoneIcon isListening={isListening('transactionCode')} onClick={() => handleVoiceInput(index, 'transactionCode')} />
                                        </div>
                                    </td>
                                    <td className="px-2 md:px-6 py-4">
                                         <div className="flex items-center justify-start space-x-2">
                                            <input
                                                type="text"
                                                value={tx.date}
                                                onChange={(e) => onUpdateTransactionString(index, 'date', e.target.value)}
                                                className={editableTextCellClass}
                                            />
                                            <MicrophoneIcon isListening={isListening('date')} onClick={() => handleVoiceInput(index, 'date')} />
                                        </div>
                                    </td>
                                    <td className="px-2 md:px-6 py-4 max-w-xs">
                                         <div className="flex items-center justify-start space-x-2">
                                            <input
                                                type="text"
                                                value={tx.description}
                                                onChange={(e) => onUpdateTransactionString(index, 'description', e.target.value)}
                                                className={`${editableTextCellClass} truncate`}
                                            />
                                            <MicrophoneIcon isListening={isListening('description')} onClick={() => handleVoiceInput(index, 'description')} />
                                        </div>
                                    </td>
                                    {/* Cột PS Nợ (Vào) */}
                                    <td className="px-2 md:px-6 py-4 text-right text-green-600 dark:text-green-400">
                                        <div className="flex items-center justify-end space-x-2">
                                            <input
                                                type="text"
                                                value={new Intl.NumberFormat('vi-VN').format(tx.debit)}
                                                onChange={(e) => {
                                                     const value = parseFloat(e.target.value.replace(/\./g, ''));
                                                     onUpdateTransaction(index, 'debit', isNaN(value) ? 0 : value)
                                                }}
                                                className={editableCellClass}
                                            />
                                            <MicrophoneIcon isListening={isListening('debit')} onClick={() => handleVoiceInput(index, 'debit')} />
                                        </div>
                                    </td>
                                    {/* Cột PS Có (TỔNG/Ra) - Đây là cột gốc có thể sửa */}
                                    <td className="px-2 md:px-6 py-4 text-right text-red-600 dark:text-red-400 font-bold">
                                         <div className="flex items-center justify-end space-x-2">
                                            <input
                                                type="text"
                                                value={new Intl.NumberFormat('vi-VN').format(tx.credit)}
                                                onChange={(e) => {
                                                     const value = parseFloat(e.target.value.replace(/\./g, ''));
                                                     onUpdateTransaction(index, 'credit', isNaN(value) ? 0 : value)
                                                }}
                                                className={editableCellClass}
                                            />
                                            <MicrophoneIcon isListening={isListening('credit')} onClick={() => handleVoiceInput(index, 'credit')} />
                                        </div>
                                    </td>
                                    {/* Cột Số tiền Gốc (NET) - Calculated */}
                                    <td className="px-2 md:px-6 py-4 text-right bg-gray-50 dark:bg-gray-700 text-gray-500">
                                        {formatCurrency(netCredit)}
                                    </td>
                                     <td className="px-2 md:px-6 py-4 text-right">
                                         <div className="flex items-center justify-end space-x-2">
                                            <input
                                                type="text"
                                                value={new Intl.NumberFormat('vi-VN').format(tx.fee || 0)}
                                                onChange={(e) => {
                                                     const value = parseFloat(e.target.value.replace(/\./g, ''));
                                                     onUpdateTransaction(index, 'fee', isNaN(value) ? 0 : value)
                                                }}
                                                className={editableCellClass}
                                            />
                                            <MicrophoneIcon isListening={isListening('fee')} onClick={() => handleVoiceInput(index, 'fee')} />
                                        </div>
                                    </td>
                                     <td className="px-2 md:px-6 py-4 text-right">
                                         <div className="flex items-center justify-end space-x-2">
                                            <input
                                                type="text"
                                                value={new Intl.NumberFormat('vi-VN').format(tx.vat || 0)}
                                                onChange={(e) => {
                                                     const value = parseFloat(e.target.value.replace(/\./g, ''));
                                                     onUpdateTransaction(index, 'vat', isNaN(value) ? 0 : value)
                                                }}
                                                className={editableCellClass}
                                            />
                                            <MicrophoneIcon isListening={isListening('vat')} onClick={() => handleVoiceInput(index, 'vat')} />
                                        </div>
                                    </td>
                                    <td className="px-2 md:px-6 py-4 text-right font-medium">{formatCurrency(currentBalance)}</td>
                                </tr>
                            );
                        })}
                    </tbody>
                     <tfoot className="bg-gray-50 dark:bg-gray-700 sticky bottom-0">
                        <tr className="font-semibold text-gray-900 dark:text-white">
                            <td colSpan={3} className="px-2 md:px-6 py-3 text-center text-base sticky left-0 bg-gray-50 dark:bg-gray-700">Cộng phát sinh</td>
                            <td className="px-2 md:px-6 py-3 text-right text-base text-green-600 dark:text-green-400">{formatCurrency(totalDebit)}</td>
                            {/* Tổng PS Có (Tổng) */}
                            <td className="px-2 md:px-6 py-3 text-right text-base text-red-600 dark:text-red-400">{formatCurrency(totalCredit)}</td>
                            {/* Tổng Net */}
                            <td className="px-2 md:px-6 py-3 text-right text-base">{formatCurrency(totalNetCredit)}</td>
                            <td className="px-2 md:px-6 py-3 text-right text-base">{formatCurrency(totalFee)}</td>
                            <td className="px-2 md:px-6 py-3 text-right text-base">{formatCurrency(totalVat)}</td>
                            <td className="px-2 md:px-6 py-3 text-right text-base font-bold">{formatCurrency(calculatedEndingBalance)}</td>
                        </tr>
                    </tfoot>
                </table>
            </div>
        </div>
    );
};

export default ResultTable;