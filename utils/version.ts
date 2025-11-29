// Phiên bản hiện tại của ứng dụng
// LƯU Ý: Trong môi trường dev/preview, cần cập nhật số này thủ công hoặc dùng script build CI/CD.
export const CURRENT_VERSION = '1.0.6';

/**
 * Công thức cập nhật phiên bản theo yêu cầu:
 * - Tăng số cuối (Patch) mỗi lần cập nhật.
 * - Nếu số cuối là 9, khi tăng sẽ chuyển về 0 và tăng số giữa (Minor) lên 1 đơn vị.
 * - Ví dụ: 1.0.0 -> 1.0.1 ... 1.0.9 -> 1.1.0
 */
export const getNextVersion = (currentVersion: string): string => {
    const parts = currentVersion.split('.').map(Number);
    if (parts.length !== 3 || parts.some(isNaN)) {
        return currentVersion; // Trả về nguyên gốc nếu format sai
    }

    let [major, minor, patch] = parts;

    if (patch < 9) {
        patch++;
    } else {
        patch = 0;
        minor++;
    }

    return `${major}.${minor}.${patch}`;
};