import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

// --- POLYFILL AN TOÀN CHO VITE/VERCEL ---
try {
  if (typeof window !== 'undefined') {
    const win = window as any;
    
    // 1. Khởi tạo process.env nếu chưa có
    win.process = win.process || {};
    win.process.env = win.process.env || {};

    // 2. Lấy env từ Vite (import.meta.env) một cách an toàn
    // Sử dụng 'as any' để tránh lỗi TS nếu môi trường không hỗ trợ chuẩn này
    const viteEnv = (import.meta as any).env || {};

    // 3. Map các biến VITE_ sang process.env để các thư viện (như Google GenAI) dùng được
    // Ưu tiên VITE_API_KEY (trên Vercel), sau đó đến API_KEY thường
    const apiKey = viteEnv.VITE_API_KEY || viteEnv.API_KEY || win.process.env.API_KEY;
    const deepSeekKey = viteEnv.VITE_DEEPSEEK_API_KEY || viteEnv.DEEPSEEK_API_KEY || win.process.env.DEEPSEEK_API_KEY;

    if (apiKey) win.process.env.API_KEY = apiKey;
    if (deepSeekKey) win.process.env.DEEPSEEK_API_KEY = deepSeekKey;

    console.log("Environment Variables Polyfilled:", {
      hasGemini: !!win.process.env.API_KEY,
      hasDeepSeek: !!win.process.env.DEEPSEEK_API_KEY
    });
  }
} catch (e) {
  console.warn("Lỗi khi khởi tạo biến môi trường (Polyfill):", e);
  // Không throw error để App vẫn có thể render giao diện (dù có thể lỗi API sau đó)
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);