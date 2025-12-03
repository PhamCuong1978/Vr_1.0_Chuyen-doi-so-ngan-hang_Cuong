// Phiên bản hiện tại của ứng dụng
// LƯU Ý: Trong môi trường dev/preview, cần cập nhật số này thủ công hoặc dùng script build CI/CD.
export const CURRENT_VERSION = '1.2.7';

/**
 * Công thức cập nhật phiên bản theo yêu cầu (Quy tắc Base 10):
 * - Tăng số cuối (Patch) mỗi lần cập nhật.
 * - Nếu Patch > 9 -> Reset Patch về 0 và tăng Minor.
 * - Nếu Minor > 9 -> Reset Minor về 0 và tăng Major.
 * 
 * Ví dụ: 
 * 1.0.9 -> 1.1.0
 * 1.1.9 -> 1.2.0
 * 1.9.9 -> 2.0.0
 */
export const getNextVersion = (currentVersion: string): string => {
    const parts = currentVersion.split('.').map(Number);
    if (parts.length !== 3 || parts.some(isNaN)) {
        return currentVersion; // Trả về nguyên gốc nếu format sai
    }

    let [major, minor, patch] = parts;

    // 1. Tăng patch
    patch++;

    // 2. Kiểm tra tràn Patch ( > 9 )
    if (patch > 9) {
        patch = 0;
        minor++;
    }

    // 3. Kiểm tra tràn Minor ( > 9 )
    if (minor > 9) {
        minor = 0;
        major++;
    }

    return `${major}.${minor}.${patch}`;
};