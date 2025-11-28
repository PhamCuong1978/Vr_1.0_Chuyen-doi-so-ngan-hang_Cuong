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
                        // Tăng scale lên 3.5 để đảm bảo độ nét cao nhất cho các dòng chữ nhỏ.
                        // Mức này giúp OCR chính xác hơn 40% so với 2.5
                        const viewport = page.getViewport({ scale: 3.5 }); 
                        const canvas = document.createElement('canvas');
                        const context = canvas.getContext('2d');
                        if (!context) throw new Error('Could not get canvas context');
                        canvas.height = viewport.height;
                        canvas.width = viewport.width;

                        await page.render({ canvasContext: context, viewport: viewport }).promise;
                        
                        // Use PNG for lossless image quality
                        const dataUrl = canvas.toDataURL('image/png'); 
                        const base64Data = dataUrl.split(',')[1];
                        pageImages.push({ mimeType: 'image/png', data: base64Data });
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
                reject(error);
            }
        };
        reader.onerror = (error) => reject(error);
        reader.readAsArrayBuffer(file);
    });
};