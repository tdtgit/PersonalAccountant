import { Telegraf } from 'telegraf';
import type { Environment } from '../types';

const formatVietnameseNumber = (value: string) => {
    const separator = value.includes(',') ? ',' : value.includes('.') ? '.' : '';
    const separatorIndex = separator ? value.lastIndexOf(separator) : -1;
    const digitsAfterSeparator = separatorIndex > -1 ? value.length - separatorIndex - 1 : 0;
    const isThousandsSeparator = separator && digitsAfterSeparator === 3;
    const normalizedValue = isThousandsSeparator
        ? value.replace(new RegExp(`\\${separator}`, 'g'), '')
        : value.replace(/\./g, '').replace(',', '.');
    const parsedValue = Number(normalizedValue);

    if (!Number.isFinite(parsedValue)) return value;

    return new Intl.NumberFormat('vi-VN', {
        maximumFractionDigits: Number.isInteger(parsedValue) ? 0 : 2,
    }).format(parsedValue);
};

const parseCurrencyAmount = (value: string) => {
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

const formatDong = (value: number) => `${new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 0 }).format(Math.round(value))}đ`;

const getExchangeRateToVnd = async (currency: string) => {
    const normalizedCurrency = currency.toLowerCase();
    const urls = [
        `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/${normalizedCurrency}.min.json`,
        `https://latest.currency-api.pages.dev/v1/currencies/${normalizedCurrency}.min.json`,
    ];

    for (const url of urls) {
        try {
            const response = await fetch(url);
            if (!response.ok) continue;

            const data = await response.json() as Record<string, Record<string, number>>;
            const rate = data[normalizedCurrency]?.vnd;
            if (Number.isFinite(rate)) return rate;
        } catch (error) {
            console.warn(`⚠️ Failed to fetch ${currency.toUpperCase()} to VND exchange rate from ${url}`, error);
        }
    }

    return null;
};

export const formatCurrencyAmounts = (text: string) =>
    text.replace(/(?<![\d.,])([+-]?\d{1,15}(?:[.,]\d{1,3})?)\s*(VND|VNĐ|đ)(?=$|[^\p{L}\p{N}_])/giu, (_match, amount: string) => {
        const formattedAmount = formatVietnameseNumber(amount);
        return `${formattedAmount}đ`;
    });

export const convertCurrencyAmountsToVnd = async (text: string) => {
    const formattedText = formatCurrencyAmounts(text);
    const currencyMatches = [...formattedText.matchAll(/(?<![\d.,])([+-]?\d{1,15}(?:[.,]\d{1,3})?)\s*([A-Z]{3})(?!\s*\()(?=$|[^\p{L}\p{N}_])/giu)]
        .filter((match) => !['VND', 'VNĐ'].includes(match[2].toUpperCase()));

    let convertedText = formattedText;
    const rates = new Map<string, number | null>();

    for (const match of currencyMatches) {
        const [matchedText, amount, currency] = match;
        const normalizedCurrency = currency.toUpperCase();
        if (!rates.has(normalizedCurrency)) {
            rates.set(normalizedCurrency, await getExchangeRateToVnd(normalizedCurrency));
        }

        const rate = rates.get(normalizedCurrency);
        const parsedAmount = parseCurrencyAmount(amount);
        if (!rate || !Number.isFinite(parsedAmount)) continue;

        convertedText = convertedText.replace(matchedText, `${matchedText} (${formatDong(parsedAmount * rate)})`);
    }

    return convertedText;
};

export const normalize = (text: string) =>
    text.replace(/【\d+:\d+†source】/g, '').replace(/[\\_\[\]\(\)~`>#\+\-=|{}.!]/g, '\\$&');

export const stripTelegramMarkdown = (text: string) =>
    text.replace(/【\d+:\d+†source】/g, '').replace(/[\\\*_\[\]\(\)~`>#\+\-=|{}.!]/g, '');

/**
 * Formats transaction details into a readable string for Telegram notification.
 * 
 * @param {object} details - The transaction details.
 * @param {string} [details.error] - Error message if there's an error.
 * @param {string} details.message - Transaction message.
 * @param {string} [details.bank_name="N/A"] - Name of the bank.
 * @param {string} [details.datetime="N/A"] - Datetime of the transaction.
 * @returns {string} Formatted string with transaction details or error message.
 */
export const formatTransactionDetails = (details: any, headline = '💳 *Có giao dịch thẻ mới nè*') =>
    details.error
        ? `Transaction error: ${details.error}`
        : `${headline}\n\n${details.message}\n\n*Từ:* ${details.bank_name || "N/A"}\n*Ngày:* ${details.datetime || "N/A"}\n------------------`;

const getTelegramMessageContent = (message): string | null => {
    const content = message?.text || message?.caption;
    return typeof content === "string" && content.trim() ? content : null;
};

const getReplyContext = (message): string | null => getTelegramMessageContent(message?.reply_to_message);

export const buildMessageWithReplyContext = (message, fallbackText?: string) => {
    const currentText = fallbackText || getTelegramMessageContent(message) || "";
    const replyContext = getReplyContext(message);

    if (!replyContext) return currentText;

    return [
        "The user is replying to this previous Telegram message. Use it as conversational context, especially for follow-up references like 'this', 'that', 'why', 'more details', or corrections.",
        `Previous Telegram message:\n${replyContext}`,
        `Current user message:\n${currentText}`,
    ].join("\n\n");
};

/**
 * Sends a Telegram message with the provided message and options.
 *
 * The message is normalized before sending (special characters are escaped and any "source" markers are removed).
 *
 * @param {Environment} env - Runtime environment with Telegram credentials.
 * @param {string} message - The message to send.
 * @param {object} [options={}] - Additional options for the message (e.g. reply_to_message_id).
 * @returns {Promise<void>}
 */
export const sendTelegramMessage = async (env: Environment, message: string, options = {}) => {
    const bot = new Telegraf(env.TELEGRAM_BOT_TOKEN);
    const formattedMessage = await convertCurrencyAmountsToVnd(message);

    try {
        await bot.telegram.sendMessage(env.TELEGRAM_CHAT_ID, normalize(formattedMessage), { parse_mode: "MarkdownV2", ...options });
        console.info("🔫 Telegram response sent successfully");
    } catch (error) {
        console.warn("⚠️ Telegram MarkdownV2 response failed, retrying as plain text", error);
        await bot.telegram.sendMessage(env.TELEGRAM_CHAT_ID, formatCurrencyAmounts(stripTelegramMarkdown(formattedMessage)), options);
        console.info("🔫 Telegram plain-text fallback response sent successfully");
    }
};
