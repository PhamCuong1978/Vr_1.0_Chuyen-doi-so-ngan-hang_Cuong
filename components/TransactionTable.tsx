import React from 'react';
import { Transaction } from '../types';
import { TrendingUp, TrendingDown, AlertCircle } from 'lucide-react';

interface TransactionTableProps {
  transactions: Transaction[];
}

const TransactionTable: React.FC<TransactionTableProps> = ({ transactions }) => {
  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(amount);
  };

  return (
    <div className="overflow-x-auto shadow ring-1 ring-black ring-opacity-5 md:rounded-lg">
      <table className="min-w-full divide-y divide-slate-300">
        <thead className="bg-slate-50">
          <tr>
            <th scope="col" className="py-3.5 pl-4 pr-3 text-left text-sm font-semibold text-slate-900 sm:pl-6">Ngày</th>
            <th scope="col" className="px-3 py-3.5 text-left text-sm font-semibold text-slate-900">Mã GD</th>
            <th scope="col" className="px-3 py-3.5 text-left text-sm font-semibold text-slate-900">Diễn giải</th>
            <th scope="col" className="px-3 py-3.5 text-right text-sm font-semibold text-emerald-600">Nợ (Vào)</th>
            <th scope="col" className="px-3 py-3.5 text-right text-sm font-semibold text-rose-600">Có (Ra)</th>
            <th scope="col" className="px-3 py-3.5 text-right text-sm font-semibold text-slate-500">Phí/Thuế</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-200 bg-white">
          {transactions.length === 0 ? (
            <tr>
              <td colSpan={6} className="py-10 text-center text-slate-400">
                <div className="flex flex-col items-center">
                  <AlertCircle className="w-8 h-8 mb-2" />
                  <p>Chưa có giao dịch nào được tìm thấy.</p>
                </div>
              </td>
            </tr>
          ) : (
            transactions.map((tx, index) => (
              <tr key={index} className="hover:bg-slate-50">
                <td className="whitespace-nowrap py-4 pl-4 pr-3 text-sm text-slate-900 sm:pl-6">{tx.date}</td>
                <td className="whitespace-nowrap px-3 py-4 text-sm text-slate-500 font-mono text-xs">{tx.transactionCode}</td>
                <td className="px-3 py-4 text-sm text-slate-700 max-w-xs truncate" title={tx.description}>{tx.description}</td>
                <td className="whitespace-nowrap px-3 py-4 text-sm text-right font-medium text-emerald-600">
                  {tx.debit > 0 && (
                    <span className="flex items-center justify-end gap-1 bg-emerald-50 px-2 py-1 rounded">
                      <TrendingUp className="w-3 h-3" />
                      {formatCurrency(tx.debit)}
                    </span>
                  )}
                </td>
                <td className="whitespace-nowrap px-3 py-4 text-sm text-right font-medium text-rose-600">
                   {tx.credit > 0 && (
                    <span className="flex items-center justify-end gap-1 bg-rose-50 px-2 py-1 rounded">
                      <TrendingDown className="w-3 h-3" />
                      {formatCurrency(tx.credit)}
                    </span>
                  )}
                </td>
                <td className="whitespace-nowrap px-3 py-4 text-sm text-right text-slate-500">
                  {(tx.fee || 0) + (tx.vat || 0) > 0 ? formatCurrency((tx.fee || 0) + (tx.vat || 0)) : '-'}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
};

export default TransactionTable;