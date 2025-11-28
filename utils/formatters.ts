export const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('vi-VN').format(value);
};