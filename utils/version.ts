// Phiên bản hiện tại của ứng dụng
// LƯU Ý: Số này sẽ được tự động cập nhật khi chạy lệnh: node scripts/auto_update_version.cjs
export const CURRENT_VERSION = '1.0.1';

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