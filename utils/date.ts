/**
 * Formats a date for a report.
 *
 * @param {('ngày' | 'tuần' | 'tháng')} reportType - The type of report to format the date for.
 * @returns {string} The formatted date string.
 *
 * The date format varies depending on the report type:
 * - For "ngày", the date is returned in the format "YYYY-MM-DD".
 * - For "tuần", the date range is returned in the format "YYYY-MM-DD đến YYYY-MM-DD".
 * - For "tháng", the date is returned in the format "MM/YYYY".
 */
export const formatDate = (reportType?: 'giờ' | 'ngày' | 'tuần' | 'tháng') => {
    const currentDate = new Date();
    switch (reportType) {
        case 'giờ':
            return currentDate.toLocaleTimeString('vi-VN', { timeZone: "Asia/Bangkok" });
        case 'ngày':
            return currentDate.toLocaleDateString('vi-VN', { timeZone: "Asia/Bangkok" });
        case 'tuần':
            const currentSunday = new Date(currentDate.setDate(currentDate.getDate() - currentDate.getDay()));
            const lastMonday = new Date(currentSunday);
            lastMonday.setDate(currentSunday.getDate() - 6);
            const formattedMonday = lastMonday.toLocaleDateString('vi-VN', { timeZone: "Asia/Bangkok" });
            const formattedSunday = currentSunday.toLocaleDateString('vi-VN', { timeZone: "Asia/Bangkok" });
            return ` từ ${formattedMonday} đến ${formattedSunday}`;
        case 'tháng':
            return `${currentDate.getMonth() + 1}/${currentDate.getFullYear()}`;
        default:
            return `${formatDate('ngày')} vào lúc ${formatDate('giờ')}`;
    }
};
