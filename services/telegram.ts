import { Telegraf } from 'telegraf';
import type { Environment } from '../types';

export const normalize = (text: string) =>
    text.replace(/【\d+:\d+†source】/g, '').replace(/[_\[\]\(\)~`>#\+\-=|{}.!]/g, '\\$&');

export const stripTelegramMarkdown = (text: string) =>
    text.replace(/【\d+:\d+†source】/g, '').replace(/[\*_\[\]\(\)~`>#\+\-=|{}.!]/g, '');

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
export const formatTransactionDetails = (details: any) =>
    details.error
        ? `Transaction error: ${details.error}`
        : `💳 *Có giao dịch thẻ mới nè*\n\n${details.message}\n\n*Từ:* ${details.bank_name || "N/A"}\n*Ngày:* ${details.datetime || "N/A"}\n------------------`;

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
 * @param {Telegraf} bot - The Telegram bot instance.
 * @param {string} chatId - The chat ID to send the message to.
 * @param {string} message - The message to send.
 * @param {object} [options={}] - Additional options for the message (e.g. reply_to_message_id).
 * @returns {Promise<void>}
 */
let bot: Telegraf | null = null;

export const sendTelegramMessage = async (env: Environment, message: string, options = {}) => {
    if (!bot) bot = new Telegraf(env.TELEGRAM_BOT_TOKEN);

    try {
        await bot.telegram.sendMessage(env.TELEGRAM_CHAT_ID, normalize(message), { parse_mode: "MarkdownV2", ...options });
        console.info("🔫 Telegram response sent successfully");
    } catch (error) {
        console.warn("⚠️ Telegram MarkdownV2 response failed, retrying as plain text", error);
        await bot.telegram.sendMessage(env.TELEGRAM_CHAT_ID, stripTelegramMarkdown(message), options);
        console.info("🔫 Telegram plain-text fallback response sent successfully");
    }
};
