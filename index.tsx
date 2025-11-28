import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

// --- POLYFILL CHO VITE/VERCEL ---
// Giúp code cũ sử dụng process.env.API_KEY hoạt động được với import.meta.env của Vite
if (typeof window !== 'undefined' && !(window as any).process) {
  (window as any).process = {
    env: {
      // Map VITE_API_KEY từ Vercel settings sang API_KEY mà ứng dụng cần
      API_KEY: import.meta.env.VITE_API_KEY, 
      DEEPSEEK_API_KEY: import.meta.env.VITE_DEEPSEEK_API_KEY,
      ...import.meta.env
    }
  };
}
// --------------------------------

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