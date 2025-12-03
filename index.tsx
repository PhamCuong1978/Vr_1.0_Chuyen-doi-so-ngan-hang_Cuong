import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

// --- POLYFILL AN TOÀN CHO VITE/VERCEL ---
// Mục đích: Đảm bảo process.env hoạt động ngay cả khi build production trên Vercel
try {
  if (typeof window !== 'undefined') {
    const win = window as any;
    
    // 1. Khởi tạo process.env nếu chưa có
    win.process = win.process || {};
    win.process.env = win.process.env || {};

    // 2. Lấy giá trị trực tiếp từ import.meta.env
    // QUAN TRỌNG: Phải gọi tường minh (explicit) để bundler của Vercel nhận diện và replace string
    // Không dùng loop hoặc dynamic access ở đây.
    
    // API KEY Google Gemini
    const viteApiKey = import.meta.env.VITE_API_KEY || import.meta.env.API_KEY;
    
    // API KEY DeepSeek
    const viteDeepSeekKey = import.meta.env.VITE_DEEPSEEK_API_KEY || import.meta.env.DEEPSEEK_API_KEY;

    // 3. Gán vào process.env để các logic cũ hoạt động
    if (viteApiKey) {
        win.process.env.API_KEY = viteApiKey;
    }
    if (viteDeepSeekKey) {
        win.process.env.DEEPSEEK_API_KEY = viteDeepSeekKey;
    }

    console.log("Environment Config Loaded:", {
      gemini: !!win.process.env.API_KEY,
      deepseek: !!win.process.env.DEEPSEEK_API_KEY
    });
  }
} catch (e) {
  console.warn("Lỗi khi khởi tạo biến môi trường (Polyfill):", e);
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