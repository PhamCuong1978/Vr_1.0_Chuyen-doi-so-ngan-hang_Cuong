import React from 'react';
import { Upload, FileText, Loader2 } from 'lucide-react';

interface FileUploadProps {
  onFileSelect: (files: FileList) => void;
  isProcessing: boolean;
  statusMessage?: string;
}

const FileUpload: React.FC<FileUploadProps> = ({ onFileSelect, isProcessing, statusMessage }) => {
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      onFileSelect(e.dataTransfer.files);
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      onFileSelect(e.target.files);
    }
  };

  return (
    <div className="w-full max-w-3xl mx-auto p-6">
      <div
        className={`relative border-2 border-dashed rounded-xl p-12 text-center transition-all duration-300 ${
          isProcessing
            ? 'border-blue-400 bg-blue-50'
            : 'border-slate-300 hover:border-blue-500 hover:bg-slate-50'
        }`}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        <input
          type="file"
          id="file-upload"
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
          onChange={handleChange}
          multiple
          accept="image/*"
          disabled={isProcessing}
        />

        <div className="flex flex-col items-center justify-center space-y-4">
          {isProcessing ? (
            <>
              <Loader2 className="w-16 h-16 text-blue-600 animate-spin" />
              <div>
                <h3 className="text-xl font-semibold text-blue-700">Đang xử lý...</h3>
                <p className="text-slate-500 mt-2">{statusMessage || 'Vui lòng đợi'}</p>
              </div>
            </>
          ) : (
            <>
              <div className="p-4 bg-blue-100 rounded-full text-blue-600">
                <Upload className="w-8 h-8" />
              </div>
              <div>
                <h3 className="text-lg font-medium text-slate-800">Kéo thả hình ảnh sao kê vào đây</h3>
                <p className="text-slate-500 mt-1">Hoặc nhấp để chọn tệp</p>
              </div>
              <div className="text-xs text-slate-400 border-t border-slate-200 pt-4 mt-4 w-full max-w-xs">
                Hỗ trợ định dạng hình ảnh (JPG, PNG). <br/> Sử dụng OCR AI để trích xuất dữ liệu.
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default FileUpload;