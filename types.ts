export interface AccountInfo {
  accountName: string;
  accountNumber: string;
  bankName: string;
  branch: string;
}

export interface Transaction {
  transactionCode: string;
  date: string;
  description: string;
  debit: number; // Phát sinh nợ (tiền vào)
  credit: number; // Phát Sinh Có (tiền ra, chưa bao gồm phí)
  fee?: number; // Phí giao dịch (tùy chọn)
  vat?: number; // Thuế GTGT (tùy chọn)
}

export interface GeminiResponse {
  accountInfo: AccountInfo;
  transactions: Transaction[];
  openingBalance: number;
  endingBalance: number;
}

// Types for AI Chat Assistant
export interface ChatMessage {
    role: 'user' | 'model';
    content: string;
    image?: string; // Optional: for displaying pasted images (data URL)
}

export interface TransactionUpdate {
    index: number;
    field: 'debit' | 'credit' | 'fee' | 'vat';
    newValue: number;
}

export interface AIChatResponse {
    responseText: string;
    update?: TransactionUpdate;
    add?: Transaction; // For adding a new transaction from pasted content
    action?: 'update' | 'undo' | 'query' | 'add';
    confirmationRequired?: boolean; // Flag to indicate if the action needs user confirmation
}