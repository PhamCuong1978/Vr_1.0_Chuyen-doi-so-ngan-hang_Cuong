// Helper to extract text or images from various file types
export const extractFromFile = async (file: File): Promise<{ text: string | null; images: { mimeType: string; data: string }[] }> => {
    return new Promise((resolve, reject) => {
        // --- TỐI ƯU HÓA 1: Đọc ảnh trực tiếp bằng DataURL (Nhanh & Nhẹ) ---
        // Phiên bản cũ dùng readAsArrayBuffer + reduce gây treo máy với ảnh lớn.
        if (file.type.startsWith('image/')) {
            const reader = new FileReader();
            reader.onload = (e) => {
                const result = e.target?.result as string;
                // Loại bỏ prefix "data:image/xyz;base64," để lấy raw base64
                const base64Data = result.split(',')[1];
                resolve({ text: null, images: [{ mimeType: file.type, data: base64Data }] });
            };
            reader.onerror = (err) => reject(new Error("Lỗi đọc file ảnh: " + err));
            reader.readAsDataURL(file);
            return;
        }

        // --- TỐI ƯU HÓA 2: Đọc các file văn bản/PDF ---
        const reader = new FileReader();
        reader.onload = async (e) => {
            try {
                const content = e.target?.result as ArrayBuffer;
                if (!content) {
                    return reject(new Error('File rỗng.'));
                }

                if (file.type === 'application/pdf') {
                    // Xử lý PDF (Vẫn cần rasterize ra ảnh để OCR chính xác form bảng biểu)
                    if (typeof (window as any).pdfjsLib === 'undefined') throw new Error("Thư viện PDF chưa tải xong.");
                    
                    const pdf = await (window as any).pdfjsLib.getDocument({ data: content }).promise;
                    const pageImages: { mimeType: string, data: string }[] = [];
                    
                    // Giới hạn 10 trang đầu để tránh treo nếu PDF quá dài
                    const maxPages = Math.min(pdf.numPages, 10);
                    
                    for (let i = 1; i <= maxPages; i++) {
                        const page = await pdf.getPage(i);
                        // Scale 2.0 đủ nét cho OCR, 3.5 như bản cũ quá tốn RAM
                        const viewport = page.getViewport({ scale: 2.0 }); 
                        const canvas = document.createElement('canvas');
                        const context = canvas.getContext('2d');
                        if (!context) throw new Error('Lỗi khởi tạo Canvas');
                        
                        canvas.height = viewport.height;
                        canvas.width = viewport.width;

                        await page.render({ canvasContext: context, viewport: viewport }).promise;
                        
                        // Xuất JPEG 0.85 để tối ưu dung lượng upload
                        const dataUrl = canvas.toDataURL('image/jpeg', 0.85); 
                        const base64Data = dataUrl.split(',')[1];
                        pageImages.push({ mimeType: 'image/jpeg', data: base64Data });
                    }
                    resolve({ text: null, images: pageImages });

                } else { 
                    // --- XỬ LÝ FILE VĂN BẢN (LOCAL - KHÔNG CẦN AI) ---
                    let extractedText = '';
                    
                    if (file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
                        // Word (.docx)
                        if (typeof (window as any).mammoth === 'undefined') throw new Error("Thư viện Mammoth chưa tải.");
                        const result = await (window as any).mammoth.extractRawText({ arrayBuffer: content });
                        extractedText = result.value;
                    } else if (file.type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' || file.name.endsWith('.xlsx') || file.name.endsWith('.xls')) {
                        // Excel (.xlsx, .xls)
                        if (typeof (window as any).XLSX === 'undefined') throw new Error("Thư viện XLSX chưa tải.");
                        const workbook = (window as any).XLSX.read(content, { type: 'array' });
                        // Đọc tất cả các sheet
                        workbook.SheetNames.forEach((sheetName: string) => {
                            const worksheet = workbook.Sheets[sheetName];
                            // Chuyển sang CSV để giữ cấu trúc hàng/cột tốt nhất cho AI đọc
                            extractedText += `--- SHEET: ${sheetName} ---\n`;
                            extractedText += (window as any).XLSX.utils.sheet_to_csv(worksheet);
                            extractedText += '\n\n';
                        });
                    } else { 
                        // Plain text (.txt, .csv, ...)
                        extractedText = new TextDecoder("utf-8").decode(content);
                    }
                    resolve({ text: extractedText, images: [] });
                }
            } catch (error) {
                console.error("Lỗi trích xuất file:", error);
                reject(error);
            }
        };
        
        reader.onerror = (error) => reject(error);
        reader.readAsArrayBuffer(file);
    });
};