// Helper to extract text or images from various file types
export const extractFromFile = async (file: File): Promise<{ text: string | null; images: { mimeType: string; data: string }[] }> => {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = async (e) => {
            try {
                const content = e.target?.result as ArrayBuffer;
                if (!content) {
                    return reject(new Error('File content is empty.'));
                }

                if (file.type === 'application/pdf') {
                    const pdf = await (window as any).pdfjsLib.getDocument({ data: content }).promise;
                    const pageImages: { mimeType: string, data: string }[] = [];
                    
                    for (let i = 1; i <= pdf.numPages; i++) {
                        const page = await pdf.getPage(i);
                        // GIẢM SCALE TỪ 3.5 XUỐNG 2.0
                        // Lý do: Scale 3.5 tạo ra ảnh quá lớn (4k-5k px), gây tràn bộ nhớ (Crash/Trắng màn hình) trên trình duyệt mobile hoặc máy cấu hình yếu.
                        // Scale 2.0 vẫn đủ nét để AI OCR chính xác.
                        const viewport = page.getViewport({ scale: 2.0 }); 
                        const canvas = document.createElement('canvas');
                        const context = canvas.getContext('2d');
                        if (!context) throw new Error('Could not get canvas context');
                        canvas.height = viewport.height;
                        canvas.width = viewport.width;

                        await page.render({ canvasContext: context, viewport: viewport }).promise;
                        
                        // Use JPEG with 0.8 quality instead of PNG to further reduce memory usage without losing readability text
                        const dataUrl = canvas.toDataURL('image/jpeg', 0.85); 
                        const base64Data = dataUrl.split(',')[1];
                        pageImages.push({ mimeType: 'image/jpeg', data: base64Data });
                    }
                    resolve({ text: null, images: pageImages });
                } else if (file.type.startsWith('image/')) {
                    const base64Data = btoa(new Uint8Array(content).reduce((data, byte) => data + String.fromCharCode(byte), ''));
                    resolve({ text: null, images: [{ mimeType: file.type, data: base64Data }] });
                } else { // Text-based files
                    let extractedText = '';
                    if (file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
                        const result = await (window as any).mammoth.extractRawText({ arrayBuffer: content });
                        extractedText = result.value;
                    } else if (file.type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
                        const workbook = (window as any).XLSX.read(content, { type: 'array' });
                        workbook.SheetNames.forEach((sheetName: string) => {
                            const worksheet = workbook.Sheets[sheetName];
                            extractedText += (window as any).XLSX.utils.sheet_to_csv(worksheet);
                        });
                    } else { // Plain text
                        extractedText = new TextDecoder().decode(content);
                    }
                    resolve({ text: extractedText, images: [] });
                }
            } catch (error) {
                console.error("Error during file extraction:", error);
                reject(new Error("Lỗi đọc file: Có thể file quá lớn hoặc bị hỏng."));
            }
        };
        reader.onerror = (error) => reject(error);
        reader.readAsArrayBuffer(file);
    });
};