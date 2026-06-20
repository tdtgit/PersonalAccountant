import { Hono } from 'hono';
import { logger } from 'hono/logger'
import PostalMime from 'postal-mime';
import OpenAI from 'openai';
import { Telegraf } from 'telegraf';
import { Buffer } from 'node:buffer';

type Environment = {
    readonly TELEGRAM_CHAT_ID: string;
    readonly TELEGRAM_BOT_TOKEN: string;
    readonly TELEGRAM_BOT_SECRET_TOKEN: string;

    readonly AI_API_GATEWAY: string;

    readonly OPENAI_PROJECT_ID: string;
    readonly OPENAI_API_KEY: string;

    readonly OPENAI_PROCESS_EMAIL_SYSTEM_PROMPT: string;
    readonly OPENAI_PROCESS_EMAIL_USER_PROMPT: string;
    readonly OPENAI_PROCESS_EMAIL_MODEL: string;
    readonly OPENAI_OCR_MODEL?: string;
    readonly OPENAI_ASSISTANT_MODEL?: string;
    readonly OPENAI_ASSISTANT_ROUTER_MODEL?: string;

    readonly OPENAI_ASSISTANT_VECTORSTORE_ID: string;
    readonly OPENAI_ASSISTANT_SCHEDULED_PROMPT: string;
};

const DEFAULT_PROCESS_EMAIL_MODEL = "gpt-5.4-mini";
const DEFAULT_OCR_MODEL = "gpt-5.4-mini";
const DEFAULT_ASSISTANT_MODEL = "gpt-5.4-mini";
const DEFAULT_ASSISTANT_ROUTER_MODEL = "gpt-5.4-mini";

const ASSISTANT_RESPONSE_FORMAT_INSTRUCTIONS = [
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

const app = new Hono<{ Bindings: Environment }>();
app.use(logger())

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

const createOpenAIClient = (env: Environment) => new OpenAI({
    project: env.OPENAI_PROJECT_ID,
    apiKey: env.OPENAI_API_KEY,

    // Your AI gateway, example:
    // https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/openai
    baseURL: env.AI_API_GATEWAY || "https://api.openai.com/v1",
});


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
        `Previous Telegram message:
${replyContext}`,
        `Current user message:
${currentText}`,
    ].join("\n\n");
};

const askTransactionAssistant = async (env: Environment, input: string) => {
    const response = await createOpenAIClient(env).responses.create({
        model: env.OPENAI_ASSISTANT_MODEL || DEFAULT_ASSISTANT_MODEL,
        instructions: `Answer personal finance questions using the transaction vector store. If the user reply includes a previous Telegram message, use it as context for the current request. Be concise and answer in Vietnamese unless the user asks otherwise. ${ASSISTANT_RESPONSE_FORMAT_INSTRUCTIONS}`,
        input,
        tools: [{
            type: "file_search",
            vector_store_ids: [env.OPENAI_ASSISTANT_VECTORSTORE_ID],
        }],
    });

    return response.output_text;
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

const sendTelegramMessage = async (env: Environment, message: string, options = {}) => {
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
const formatDate = (reportType?: 'giờ' |'ngày' | 'tuần' | 'tháng') => {
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

/**
 * Creates a report response from the configured transaction vector store and sends it to Telegram.
 *
 * @param {Environment} env - The environment variables.
 * @param {'ngày' | 'tuần' | 'tháng'} reportType - The type of report to process.
 * @returns {Promise<string>} A promise that resolves to a message indicating that the scheduled process has completed.
 */
const createAndProcessScheduledReport = async (env: Environment, reportType: 'ngày' | 'tuần' | 'tháng') => {
    const prompt = env.OPENAI_ASSISTANT_SCHEDULED_PROMPT.replace("%DATETIME%", formatDate(reportType));
    console.info(`⏰ Processing report for prompt ${prompt}`)

    const msgContent = await askTransactionAssistant(env, prompt);
    console.info(`⏰ ${reportType.charAt(0).toUpperCase() + reportType.slice(1)} report processed:`, msgContent);

    const msg = `🥳 Báo cáo ${reportType} tới rồi đêi\n\n${msgContent}\n------------------`;
    await sendTelegramMessage(env, msg);

    console.info(`⏰ ${reportType.charAt(0).toUpperCase() + reportType.slice(1)} message sent successfully`);
    return "⏰ Scheduled process completed";
};

const assistantQuestion = async (c, message, question?: string) => {
    const msg = await askTransactionAssistant(c.env, buildMessageWithReplyContext(message, question));
    console.info("🔫 Message processed successfully:", msg);

    await sendTelegramMessage(c.env, msg, { reply_to_message_id: message.message_id });

    return c.text("Request completed");
}

const getLatestPhotoFileId = (message): string | null => {
    const photos = message?.photo;
    if (!Array.isArray(photos) || photos.length === 0) return null;
    return photos[photos.length - 1]?.file_id ?? null;
};


// Function to download telegram file from bot from file_id and return as base64
const downloadTelegramFile = async (fileId: string, env: Environment) => {
    const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`;
    const response = await fetch(url);
    const data = await response.json();
    const fileUrl = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${data.result.file_path}`;
    const fileResponse = await fetch(fileUrl);
    const buffer = Buffer.from(await fileResponse.arrayBuffer());

    // Extract the file extension to determine the image type
    const fileExtension = data.result.file_path.split('.').pop();
    const imageType = fileExtension ? fileExtension : 'jpeg';

    console.log("🔫 File downloaded successfully", `data:image/${imageType};base64,${buffer.toString('base64')}`);

    return `data:image/${imageType};base64,${buffer.toString('base64')}`;
}


const imageOcr = async (message, c) => {
    const fileId = getLatestPhotoFileId(message);
    if (!fileId) throw new Error("No photo found in telegram message");

    let imgB64 = await downloadTelegramFile(fileId, c.env);

    const response = await createOpenAIClient(c.env).responses.create({
        model: c.env.OPENAI_OCR_MODEL || DEFAULT_OCR_MODEL,
        input: [
            {
                role: "user",
                content: [
                    { type: "input_text", text: `Print the text inside the image. Try to focus on store name, date time (if not found, please use ${formatDate()}), price tag of receipt` },
                    {
                        type: "input_image",
                        image_url: imgB64,
                        detail: "auto",
                    },
                ],
            },
        ],
    });
    
    return response.output_text;
}

const assistantOcr = async (message, c) => {
    const transaction = await imageOcr(message, c);
    const transactionDetails = await processTransaction(transaction, c.env);

    if (!transactionDetails) return "Not okay";
    await Promise.all([storeTransaction(transactionDetails, c.env), notifyServices(transactionDetails, c.env)]);
    return "📬 Email processed successfully";
}

const assistantManualTransaction = async (transaction, env: Environment) => {
    console.info("🔫 Processing manual transaction:", transaction);
    const transactionDetails = await processTransaction(transaction, env);

    if (!transactionDetails) return "Not okay";
    await Promise.all([storeTransaction(transactionDetails, env), notifyServices(transactionDetails, env)]);
    return "📬 Email processed successfully";
}

const verifyAssistantRequest = async (c) => {
    const secretToken = c.req.header('X-Telegram-Bot-Api-Secret-Token');
    if (!secretToken || secretToken !== c.env.TELEGRAM_BOT_SECRET_TOKEN) {
        console.error("Authentication failed. You are not welcome here");
        return c.text("Unauthorized", 401);
    }

    const { message } = await c.req.json();

    if (message.from.id != c.env.TELEGRAM_CHAT_ID) {
        console.warn("⚠️ Received new assistant request from unknown chat:", message);
        await sendTelegramMessage(c.env, "Bạn là người dùng không xác định, bạn không phải anh Ảgú");
        return c.text("Unauthorized user");
    }

    return message;
}

app.post('/assistant', async (c) => {
    const message = await verifyAssistantRequest(c);
    if (message instanceof Response) {
        return message; // Stop execution if an error response is returned
    }

    const available_functions = [{
        type: "function",
        name: "assistantQuestion",
        description: "Get information of transactions when asked.",
        parameters: {
            type: "object",
            properties: {
                question: {
                    type: "string",
                    description: "Question in user's request"
                }
            },
            required: [
                "question"
            ],
            additionalProperties: false
        },
        strict: false
    }, {
        type: "function",
        name: "assistantOcr",
        description: "Process image sent by user and extract information.",
        parameters: {
            type: "object",
            properties: {
                image: {
                    type: "string",
                    description: "Image sent by user"
                }
            },
            required: [
                "image"
            ],
            additionalProperties: false
        },
        strict: false
    }, {
        type: "function",
        name: "assistantManualTransaction",
        description: "Add a transaction manually when user defined.",
        parameters: {
            type: "object",
            properties: {
                transaction: {
                    type: "string",
                    description: "Content of transaction"
                }
            },
            required: [
                "transaction"
            ],
            additionalProperties: false
        },
        strict: false
    }] as const;

    if (message.text === undefined) {
        console.log("🔫 Processing case assistantOcr");
        await assistantOcr(message, c);
        return c.text("Success");
    }

    console.log("🔫 /assistant/OpenAiResponse request:", message.text);
    const response = await createOpenAIClient(c.env).responses.create({
        model: c.env.OPENAI_ASSISTANT_ROUTER_MODEL || DEFAULT_ASSISTANT_ROUTER_MODEL,
        input: [
            {
                role: "user",
                content: buildMessageWithReplyContext(message)
            }
        ],
        tools: [...available_functions]
    });
    console.log("🔫 /assistant/OpenAiResponse response:", response);

    const functionCall = response.output.find((item) => item.type === "function_call");
    if (!functionCall) {
        console.log("🔫 No function call from model, falling back to assistantQuestion");
        await assistantQuestion(c, message);
        return c.text("Success");
    }

    switch (functionCall.name) {
        case "assistantManualTransaction":
            console.log("🔫 Processing case assistantManualTransaction");
            await assistantManualTransaction(JSON.parse(functionCall.arguments).transaction, c.env);
            break;
        case "assistantQuestion":
            console.log("🔫 Processing case assistantQuestion");
            await assistantQuestion(c, message, JSON.parse(functionCall.arguments).question);
            break;
        default:
            console.log("🔫 Processing default case");
            return c.text("Request completed");
    }

    return c.text("Success");
});

const email = async (message, env: Environment) => {
    const parser = new PostalMime();
    const body = await new Response(message.raw).arrayBuffer();
    const email = await parser.parse(body);
    console.info(`📬 New mail arrived! Sender ${email.from.address} (${email.from.address}), subject: ${email.subject}`);

    const emailContent = email.text || email.html;
    if (!emailContent) throw new Error("📬 Email content is empty");

    const emailData = `Email date: ${email.date}\nEmail sender: ${email.from.name}\nEmail content:\n${emailContent}`;
    const transactionDetails = await processTransaction(emailData, env);

    if (!transactionDetails) return "Not okay";

    await Promise.all([storeTransaction(transactionDetails, env), notifyServices(transactionDetails, env)]);
    return "📬 Email processed successfully";
}

const storeTransaction = async (details, env: Environment) => {
    const fileName = `ArgusChiTieu_transaction_${new Date().toISOString()}.txt`;

    // Seems Cloudflare not allow Workers to write temporary files so
    // we use HTTP API instead of client library.

    // Convert the details to a text format
    const transactionText = JSON.stringify(details, null, 2);
    const formData = new FormData();
    formData.append('purpose', 'assistants');

    // Create a Blob from the file content
    const blob = Buffer.from(transactionText); // Convert content to Buffer
    const file = new File([blob], fileName, { type: 'application/json' });

    // Append the file to FormData
    formData.append('file', file);

    // Make the fetch request
    const uploadResponse = await fetch(`${env.AI_API_GATEWAY || "https://api.openai.com/v1"}/files`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
            // Note: FormData automatically sets the 'Content-Type' boundary, so no need to set it manually
        },
        body: formData,
    });

    // Check if the response is okay
    if (!uploadResponse.ok) {
        throw new Error(`Upload transaction file error: ${uploadResponse.statusText}`);
    }

    console.info(`🤖 Upload ${fileName} successfully`)

    const uploadResult = await uploadResponse.json();
    const fileId = uploadResult.id;
    const vectorStoreResponse = await fetch(`${env.AI_API_GATEWAY || "https://api.openai.com/v1"}/vector_stores/${env.OPENAI_ASSISTANT_VECTORSTORE_ID}/files`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ file_id: fileId }),
    });

    // Check if the response for adding to vector store is okay
    if (!vectorStoreResponse.ok) {
        throw new Error(`Error adding file to vector store: ${vectorStoreResponse.statusText}`);
    }

    console.info(`🤖 Add ${fileName} to Vector store successfully`)
}

const notifyServices = async (details: any, env: Environment) => {
    const message = formatTransactionDetails(details);
    await sendTelegramMessage(env, message);
}

const processTransaction = async (emailData: string, env: Environment) => {
    console.log(`🤖 Processing email content: ${emailData}`);

    const response = await createOpenAIClient(env).responses.create({
        model: env.OPENAI_PROCESS_EMAIL_MODEL || DEFAULT_PROCESS_EMAIL_MODEL,
        instructions: env.OPENAI_PROCESS_EMAIL_SYSTEM_PROMPT,
        input: `${env.OPENAI_PROCESS_EMAIL_USER_PROMPT}\n\n${emailData}`,
        store: false,
    });

    const contentStr = response.output_text.replaceAll('`', '');
    if (!contentStr) {
        console.error("🤖 Failed to parse transaction details");
        return;
    }
    let content;
    try {
        content = JSON.parse(contentStr);
    } catch (error) {
        console.error("🤖 Failed to parse transaction JSON", error);
        return;
    }
    if (content.result === "failed") {
        console.warn("🤖 Not a transaction email");
        return;
    }

    console.info(`🤖 Processed email content: ${JSON.stringify(content)}`);
    return content;
}

const dailyReport = async (env: Environment) => {
    return createAndProcessScheduledReport(env, 'ngày');
}

const weeklyReport = async (env: Environment) => {
    return createAndProcessScheduledReport(env, 'tuần');
}

const monthlyReport = async (env: Environment) => {
    return createAndProcessScheduledReport(env, 'tháng');
}

export default {
    fetch: app.fetch,

    async scheduled(event, env: Environment) {
        switch (event.cron) {
            case "0 15 * * *":
                console.info("⏰ Daily scheduler triggered");
                await dailyReport(env);
                break;
            case "58 16 * * 0":
                console.info("⏰ Weekly scheduler triggered");
                await weeklyReport(env);
                break;
            case "0 15 1 * *":
                console.info("⏰ Monthly scheduler triggered");
                await monthlyReport(env);
                break;
        }
    },

    async email(message, env: Environment) {
        return email(message, env);
    }
};
