/**
 * Currencies whose smallest unit equals the major unit (no decimal subunit).
 * Everything else is assumed to use two decimal places.
 */
const ZERO_DECIMAL_CURRENCIES = new Set(['VND', 'VNĐ', 'JPY', 'KRW', 'IDR', 'CLP', 'ISK', 'PYG', 'RWF', 'UGX', 'VUV', 'XAF', 'XOF', 'XPF']);

export const normalizeCurrency = (currency?: string | null) => {
    const normalized = (currency || '').trim().toUpperCase();
    if (!normalized) return '';
    return normalized === 'VNĐ' ? 'VND' : normalized;
};

export const currencyDecimals = (currency?: string | null) =>
    ZERO_DECIMAL_CURRENCIES.has(normalizeCurrency(currency)) ? 0 : 2;

/**
 * Parses a human-formatted amount into a Number, handling both Vietnamese
 * (1.234.567,89) and Anglo (1,234,567.89) separator conventions.
 */
export const parseCurrencyAmount = (value: string) => {
    const normalizedValue = value.trim().replace(/\s/g, '');
    const lastComma = normalizedValue.lastIndexOf(',');
    const lastDot = normalizedValue.lastIndexOf('.');

    if (lastComma > -1 && lastDot > -1) {
        const decimalSeparator = lastComma > lastDot ? ',' : '.';
        const thousandsSeparator = decimalSeparator === ',' ? '.' : ',';
        return Number(normalizedValue.replace(new RegExp(`\\${thousandsSeparator}`, 'g'), '').replace(decimalSeparator, '.'));
    }

    const separator = lastComma > -1 ? ',' : lastDot > -1 ? '.' : '';
    if (!separator) return Number(normalizedValue);

    const separatorIndex = normalizedValue.lastIndexOf(separator);
    const digitsAfterSeparator = normalizedValue.length - separatorIndex - 1;
    const isDecimalSeparator = digitsAfterSeparator > 0 && digitsAfterSeparator <= 2;

    return Number(isDecimalSeparator
        ? normalizedValue.replace(separator, '.')
        : normalizedValue.replace(new RegExp(`\\${separator}`, 'g'), ''));
};

/** Converts a human-formatted amount into integer minor units for the currency. */
export const toMinorUnits = (value: string | number | null | undefined, currency?: string | null) => {
    if (value === null || value === undefined || value === '') return null;

    const parsed = typeof value === 'number' ? value : parseCurrencyAmount(String(value));
    if (!Number.isFinite(parsed)) return null;

    return Math.round(parsed * 10 ** currencyDecimals(currency));
};

/** Inverse of `toMinorUnits`, returning the major-unit Number. */
export const fromMinorUnits = (minor: number, currency?: string | null) => minor / 10 ** currencyDecimals(currency);

/**
 * Converts an amount in minor units to VND minor units (VND has no subunit, so
 * minor units are whole đồng) using a major-unit exchange rate.
 */
export const toVndMinorUnits = (minor: number, currency: string, rateToVnd: number) =>
    Math.round(fromMinorUnits(minor, currency) * rateToVnd);
