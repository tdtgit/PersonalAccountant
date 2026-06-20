export const DEFAULT_PROCESS_EMAIL_MODEL = "gpt-5.4-mini";
export const DEFAULT_OCR_MODEL = "gpt-5.4-mini";
export const DEFAULT_ASSISTANT_MODEL = "gpt-5.4-mini";
export const DEFAULT_ASSISTANT_ROUTER_MODEL = "gpt-5.4-mini";

export const ASSISTANT_RESPONSE_FORMAT_INSTRUCTIONS = [
    "Format answers for Telegram MarkdownV2.",
    "Use *single asterisks* for bold labels/headings; do not use double-asterisk Markdown because Telegram MarkdownV2 bold uses single asterisks.",
    "When listing multiple transactions, use short bullet points.",
    "Format all money amounts in Vietnamese number style: use dots for thousands and commas for decimal fractions; remove insignificant trailing decimal zeros for non-VND currencies (for example, write 16 AUD instead of 16.000 AUD, and 5,24 AUD instead of 5.240 AUD).",
    "When showing transaction times, include only hour and minute (HH:mm); do not include seconds.",
    "When the user does not specify a limit or count, assume they want all matching transactions.",
    "If all matching transactions would be too large or token-expensive to list, return the 20 transactions closest to the requested time period and clearly say that the list was limited to 20.",
    "When the answer includes multiple dates, split the response into separate bold date sections.",
    "When there are 3 or more transactions, include a bold total summary at the bottom.",
    "When there are 10 or more transactions, do not use Markdown tables because Telegram MarkdownV2 does not support them reliably; use grouped date sections with bullet points instead.",
].join(" ");
