import React, { useState, useRef, useEffect } from 'react';
import type { GeminiResponse, ChatMessage, Transaction, AIChatResponse } from '../types';
import { chatWithAI } from '../services/geminiService';
import { ChatIcon, CloseIcon, SendIcon, MicrophoneIcon, RemoveImageIcon } from './Icons';

interface ChatAssistantProps {
    reportData: GeminiResponse;
    rawStatementContent: string;
    onUpdateTransaction: (index: number, field: 'debit' | 'credit' | 'fee' | 'vat', value: number) => void;
    onTransactionAdd: (transaction: Transaction) => void;
    onUndoLastChange: () => void;
}

const fileToGenerativePart = (file: File): Promise<{ mimeType: string; data: string }> => {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const base64Data = (e.target?.result as string).split(',')[1];
            resolve({
                mimeType: file.type,
                data: base64Data
            });
        };
        reader.readAsDataURL(file);
    });
};

const ChatAssistant: React.FC<ChatAssistantProps> = ({ reportData, rawStatementContent, onUpdateTransaction, onTransactionAdd, onUndoLastChange }) => {
    const [isOpen, setIsOpen] = useState(false);
    const [messages, setMessages] = useState<ChatMessage[]>([
        { role: 'model', content: 'Chào Anh Cường, Em là trợ lý kế toán ảo. Em có thể giúp gì cho Anh trong việc đối chiếu và chỉnh sửa báo cáo này ạ?' }
    ]);
    const [input, setInput] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [isListening, setIsListening] = useState(false);
    const [pastedImage, setPastedImage] = useState<{ dataUrl: string; file: File } | null>(null);
    const [pendingAction, setPendingAction] = useState<AIChatResponse | null>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const recognitionRef = useRef<any>(null);
    const chatWindowRef = useRef<HTMLDivElement>(null);

    // Effect to handle clicking outside the chat window to close it
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            const chatBubble = document.querySelector('[aria-label="Mở Trợ lý AI"]');
            if (
                chatWindowRef.current &&
                !chatWindowRef.current.contains(event.target as Node) &&
                !chatBubble?.contains(event.target as Node)
            ) {
                setIsOpen(false);
            }
        };

        if (isOpen) {
            document.addEventListener('mousedown', handleClickOutside);
        }

        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, [isOpen]);


    useEffect(() => {
        const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
        if (SpeechRecognition) {
            const recognition = new SpeechRecognition();
            recognition.continuous = false;
            recognition.interimResults = true;
            recognition.lang = 'vi-VN';

            recognition.onstart = () => setIsListening(true);

            recognition.onresult = (event: any) => {
                let finalTranscript = '';
                for (let i = event.resultIndex; i < event.results.length; ++i) {
                     if (event.results[i].isFinal) {
                        finalTranscript += event.results[i][0].transcript;
                    }
                }
                if (finalTranscript) {
                    setInput(prev => prev + finalTranscript);
                }
            };

            recognition.onerror = (event: any) => {
                console.error("Speech recognition error in chat:", event.error);
                setIsListening(false);
            };

            recognition.onend = () => setIsListening(false);

            recognitionRef.current = recognition;
        }
    }, []);

    const handleVoiceInput = () => {
        if (recognitionRef.current) {
            if (isListening) {
                recognitionRef.current.stop();
            } else {
                recognitionRef.current.start();
            }
        } else {
            alert("Trình duyệt không hỗ trợ nhận dạng giọng nói.");
        }
    };


    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    };

    useEffect(scrollToBottom, [messages, isLoading]);

    const handleSendMessage = async (e: React.FormEvent) => {
        e.preventDefault();
        if ((!input.trim() && !pastedImage) || isLoading) return;

        const userMessageContent = input.trim();
        const userMessage: ChatMessage = { 
            role: 'user', 
            content: userMessageContent,
            ...(pastedImage && { image: pastedImage.dataUrl })
        };
        setMessages(prev => [...prev, userMessage]);
        setInput('');
        setIsLoading(true);

        // --- Confirmation Handling Logic ---
        if (pendingAction) {
            const affirmativeAnswers = ['có', 'ok', 'yes', 'đồng ý', 'ừ', 'uhm', 'uh', 'confirm', 'được'];
            if (affirmativeAnswers.includes(userMessageContent.toLowerCase())) {
                // Execute the pending action
                if (pendingAction.action === 'update' && pendingAction.update) {
                    const { index, field, newValue } = pendingAction.update;
                    onUpdateTransaction(index, field, newValue);
                } else if (pendingAction.action === 'undo') {
                    onUndoLastChange();
                } else if (pendingAction.action === 'add' && pendingAction.add) {
                    onTransactionAdd(pendingAction.add);
                }
                
                const modelMessage: ChatMessage = { role: 'model', content: "Dạ, em đã điều chỉnh xong cho Anh Cường ạ." };
                setMessages(prev => [...prev, modelMessage]);
            } else {
                // User said "no" or something else
                const modelMessage: ChatMessage = { role: 'model', content: "Dạ vâng, em đã hủy yêu cầu điều chỉnh." };
                setMessages(prev => [...prev, modelMessage]);
            }
            setPastedImage(null); // Clear image if it was part of the request
            setPendingAction(null); // Clear pending action
            setIsLoading(false);
            return; // Stop further processing
        }
        // --- End Confirmation Handling Logic ---

        try {
            const imagePart = pastedImage ? await fileToGenerativePart(pastedImage.file) : null;
            
            // Clear the pasted image *after* converting it
            setPastedImage(null);
            
            // Pass the current messages (without the user's latest message) to maintain context
            const aiResponse = await chatWithAI(userMessage.content, reportData, messages, rawStatementContent, imagePart);
            
            const modelMessage: ChatMessage = { role: 'model', content: aiResponse.responseText };
            setMessages(prev => [...prev, modelMessage]);

            if (aiResponse.confirmationRequired && (aiResponse.update || aiResponse.add || aiResponse.action === 'undo')) {
                 setPendingAction(aiResponse); // Save the action to be confirmed
            }

        } catch (error) {
            console.error("Chat error:", error);
            const errorMessage: ChatMessage = { role: 'model', content: 'Xin lỗi Anh Cường, đã có lỗi xảy ra. Anh Cường vui lòng thử lại nhé.' };
            setMessages(prev => [...prev, errorMessage]);
        } finally {
            setIsLoading(false);
        }
    };

    const handlePaste = (e: React.ClipboardEvent) => {
        if (pendingAction) return; // Don't allow pasting while waiting for confirmation
        const items = e.clipboardData.items;
        for (let i = 0; i < items.length; i++) {
            if (items[i].type.indexOf('image') !== -1) {
                const file = items[i].getAsFile();
                if (file) {
                    const reader = new FileReader();
                    reader.onload = (event) => {
                        setPastedImage({
                            dataUrl: event.target?.result as string,
                            file: file
                        });
                    };
                    reader.readAsDataURL(file);
                    e.preventDefault();
                    break;
                }
            }
        }
    };

    return (
        <>
            {/* Backdrop for mobile */}
            <div
                onClick={() => setIsOpen(false)}
                className={`fixed inset-0 bg-black bg-opacity-40 z-30 transition-opacity duration-300 ease-in-out md:hidden ${isOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
            />
            {/* Chat Bubble */}
            <button
                onClick={() => setIsOpen(!isOpen)}
                className="fixed bottom-5 right-5 z-50 p-4 bg-indigo-600 rounded-full shadow-lg hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 transition-transform transform hover:scale-110"
                aria-label="Mở Trợ lý AI"
            >
                <ChatIcon />
            </button>

            {/* Chat Window */}
            <div ref={chatWindowRef} className={`fixed bottom-20 z-40 bg-white dark:bg-gray-800 rounded-xl shadow-2xl flex flex-col transition-all duration-300 ease-in-out inset-x-4 md:inset-x-auto md:right-5 md:w-full md:max-w-md max-h-[90vh] ${isOpen ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4 pointer-events-none'}`}>
                {/* Header */}
                <header className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
                    <h3 className="text-lg font-bold text-gray-800 dark:text-gray-200">Trợ lý Kế toán của Anh Cường</h3>
                    <button onClick={() => setIsOpen(false)} className="text-gray-500 hover:text-gray-800 dark:hover:text-gray-200" aria-label="Đóng chat">
                        <CloseIcon />
                    </button>
                </header>

                {/* Messages */}
                <div className="flex-1 p-4 overflow-y-auto h-[60vh] min-h-[300px]">
                    <div className="space-y-4">
                        {messages.map((msg, index) => (
                            <div key={index} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                                <div className={`max-w-xs md:max-w-sm px-4 py-2 rounded-2xl ${msg.role === 'user' ? 'bg-indigo-600 text-white' : 'bg-gray-200 dark:bg-gray-700 text-gray-800 dark:text-gray-200'}`}>
                                    {msg.image && <img src={msg.image} alt="Pasted content" className="rounded-lg mb-2 max-h-48" />}
                                    <p className="text-sm" style={{ whiteSpace: 'pre-wrap' }}>{msg.content}</p>
                                </div>
                            </div>
                        ))}
                        {isLoading && (
                            <div className="flex justify-start">
                                <div className="max-w-xs md:max-w-sm px-4 py-2 rounded-2xl bg-gray-200 dark:bg-gray-700 text-gray-800 dark:text-gray-200">
                                    <div className="flex items-center space-x-2">
                                        <div className="w-2 h-2 bg-gray-500 rounded-full animate-bounce [animation-delay:-0.3s]"></div>
                                        <div className="w-2 h-2 bg-gray-500 rounded-full animate-bounce [animation-delay:-0.15s]"></div>
                                        <div className="w-2 h-2 bg-gray-500 rounded-full animate-bounce"></div>
                                    </div>
                                </div>
                            </div>
                        )}
                        <div ref={messagesEndRef} />
                    </div>
                </div>

                {/* Input */}
                <footer className="p-4 border-t border-gray-200 dark:border-gray-700 flex-shrink-0">
                    {pastedImage && (
                        <div className="relative mb-2 p-2 bg-gray-100 dark:bg-gray-900 rounded-lg">
                            <img src={pastedImage.dataUrl} alt="Preview" className="max-h-24 rounded" />
                            <button 
                                onClick={() => setPastedImage(null)}
                                className="absolute top-1 right-1 bg-gray-800 bg-opacity-50 rounded-full p-0.5 hover:bg-opacity-75"
                                aria-label="Xóa ảnh"
                            >
                                <RemoveImageIcon />
                            </button>
                        </div>
                    )}
                    <form onSubmit={handleSendMessage} onPaste={handlePaste} className="flex items-center space-x-2">
                         <div className="flex-1 relative">
                            <input
                                type="text"
                                value={input}
                                onChange={(e) => setInput(e.target.value)}
                                placeholder={pendingAction ? "Trả lời xác nhận (có/không)..." : "Hỏi, ra lệnh, hoặc dán ảnh..."}
                                className="w-full px-4 py-2 pr-12 text-gray-900 dark:text-white bg-gray-100 dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-full focus:outline-none focus:ring-2 focus:ring-indigo-500"
                                disabled={isLoading}
                                autoFocus
                            />
                            <div className="absolute inset-y-0 right-0 flex items-center pr-3">
                                <MicrophoneIcon isListening={isListening} onClick={handleVoiceInput} />
                            </div>
                        </div>
                        <button
                            type="submit"
                            disabled={isLoading || (!input.trim() && !pastedImage)}
                            className="p-3 bg-indigo-600 text-white rounded-full hover:bg-indigo-700 disabled:bg-indigo-400 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
                            aria-label="Gửi tin nhắn"
                        >
                            <SendIcon />
                        </button>
                    </form>
                </footer>
            </div>
        </>
    );
};

export default ChatAssistant;