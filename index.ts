import { Hono } from 'hono';
import PostalMime from 'postal-mime';
import OpenAI from 'openai';
import { Telegraf } from 'telegraf';

type Environment = {
    readonly TELEGRAM_CHAT_ID: string;
    readonly TELEGRAM_BOT_TOKEN: string;
    readonly TELEGRAM_BOT_SECRET_TOKEN: string;

    readonly OPENAI_PROJECT_ID: string;
    readonly OPENAI_API_KEY: string;

    readonly OPENAI_PROCESS_EMAIL_SYSTEM_PROMPT: string;
    readonly OPENAI_PROCESS_EMAIL_USER_PROMPT: string;
    readonly OPENAI_PROCESS_EMAIL_MODEL: string;

    readonly OPENAI_ASSISTANT_VECTORSTORE_ID: string;
    readonly OPENAI_ASSISTANT_ID: string;
    readonly OPENAI_ASSISTANT_SCHEDULED_PROMPT: string;
};

const app = new Hono<{ Bindings: Environment }>();

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const normalize = (text: string) =>
    text.replace(/[_\[\]~`>#\+\-=|{}.!]/g, '\\$&').replace(/【\d+:\d+†source】/g, '');

const formatTransactionDetails = (details: any) =>
    details.error
        ? `Transaction error: ${details.error}`
        : `💳 *Có giao dịch thẻ mới nè*\n\n${details.message}\n\n*Từ:* ${details.bank_name || "N/A"}\n*Ngày:* ${details.datetime || "N/A"}\n------------------`;

const createOpenAIClient = (env: Environment) => new OpenAI({ project: env.OPENAI_PROJECT_ID, apiKey: env.OPENAI_API_KEY, });

const sendTelegramMessage = async (bot: Telegraf, chatId: string, message: string, options = {}) =>
    bot.telegram.sendMessage(chatId, normalize(message), { parse_mode: "MarkdownV2", ...options });

const waitForCompletion = async (openai: OpenAI, threadId: string, runId: string) => {
    let run = await openai.beta.threads.runs.retrieve(threadId, runId);
    while (["queued", "in_progress"].includes(run.status)) {
        console.info("⏳ Waiting for thread completion:", threadId);
        await sleep(500);
        run = await openai.beta.threads.runs.retrieve(threadId, runId);
    }
    return run;
};

const formatDateForReport = (reportType: 'ngày' | 'tuần' | 'tháng') => {
    const currentDate = new Date();
    switch (reportType) {
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
    }
};

const createAndProcessScheduledReport = async (env: Environment, reportType: 'ngày' | 'tuần' | 'tháng') => {
    const openai = createOpenAIClient(env);
    const prompt = env.OPENAI_ASSISTANT_SCHEDULED_PROMPT.replace("%DATETIME%", formatDateForReport(reportType));
    console.info(`⏰ Processing report for prompt ${prompt}`)

    const run = await openai.beta.threads.createAndRun({
        assistant_id: env.OPENAI_ASSISTANT_ID,
        thread: { messages: [{ role: "user", content: prompt }] },
    });

    console.info(`⏰ ${reportType.charAt(0).toUpperCase() + reportType.slice(1)} report thread created:`, run.thread_id);
    await waitForCompletion(openai, run.thread_id, run.id);

    const { data: threadMessages } = await openai.beta.threads.messages.list(run.thread_id, { run_id: run.id });
    console.info(`⏰ ${reportType.charAt(0).toUpperCase() + reportType.slice(1)} message processed:`, threadMessages);

    const msgContent = threadMessages[0]?.content[0]?.text?.value;
    const msg = `🥳 Báo cáo ${reportType} tới rồi đêi\n\n${msgContent}\n------------------`;
    const bot = new Telegraf(env.TELEGRAM_BOT_TOKEN);
    await sendTelegramMessage(bot, env.TELEGRAM_CHAT_ID, msg);

    console.info(`⏰ ${reportType.charAt(0).toUpperCase() + reportType.slice(1)} message sent successfully`);
    return "⏰ Scheduled process completed";
};

app.post('/assistant', async (c) => {
    if (c.req.header('X-Telegram-Bot-Api-Secret-Token') !== c.env.TELEGRAM_BOT_SECRET_TOKEN) {
        console.error("Authentication failed. You are not welcome here");
        return;
    }

    const { message } = await c.req.json();
    const { text } = message;
    console.info("🔫 Received new assistant request:", text);

    const openai = createOpenAIClient(c.env);
    const run = await openai.beta.threads.createAndRun({
        assistant_id: c.env.OPENAI_ASSISTANT_ID,
        thread: { messages: [{ role: "user", content: text }] },
    });

    console.info("🔫 Thread created successfully:", run.thread_id);
    await waitForCompletion(openai, run.thread_id, run.id);

    const { data: threadMessages } = await openai.beta.threads.messages.list(run.thread_id, { run_id: run.id });
    console.info("🔫 Message processed successfully:", threadMessages);

    const msg = threadMessages[0]?.content[0]?.text?.value;
    const bot = new Telegraf(c.env.TELEGRAM_BOT_TOKEN);
    await sendTelegramMessage(bot, c.env.TELEGRAM_CHAT_ID, msg, { reply_to_message_id: message.message_id });

    console.info("🔫 Telegram response sent successfully");
    return c.text("Request completed");
});

export default {
    fetch: app.fetch,

    async dailyReport(env: Environment) {
        return createAndProcessScheduledReport(env, 'ngày');
    },

    async weeklyReport(env: Environment) {
        return createAndProcessScheduledReport(env, 'tuần');
    },

    async monthlyReport(env: Environment) {
        return createAndProcessScheduledReport(env, 'tháng');
    },

    async scheduled(event, env: Environment) {
        switch (event.cron) {
            case "0 15 * * *":
                console.info("⏰ Daily scheduler triggered");
                await this.dailyReport(env);
                break;
            case "58 16 * * 0":
                console.info("⏰ Weekly scheduler triggered");
                await this.weeklyReport(env);
                break;
            case "0 15 1 * *":
                console.info("⏰ Monthly scheduler triggered");
                await this.monthlyReport(env);
                break;
        }
    },

    async email(message, env: Environment) {
        const parser = new PostalMime();
        const body = await new Response(message.raw).arrayBuffer();
        const email = await parser.parse(body);
        console.info(`📬 New mail arrived! Sender ${email.from.address} (${email.from.address}), subject: ${email.subject}`);

        const emailContent = email.text || email.html;
        if (!emailContent) throw new Error("📬 Email content is empty");

        const emailData = `Email date: ${email.date}\nEmail sender: ${email.from.name}\nEmail content:\n${emailContent}`;
        const transactionDetails = await this.processEmail(emailData, env);

        if (!transactionDetails) return "Not okay";

        await Promise.all([this.storeTransaction(transactionDetails, env), this.notifyServices(transactionDetails, env)]);
        return "📬 Email processed successfully";
    },

    async processEmail(emailData: string, env: Environment) {
        const openai = createOpenAIClient(env);
        const completion = await openai.chat.completions.create({
            messages: [
                { role: "system", content: env.OPENAI_PROCESS_EMAIL_SYSTEM_PROMPT },
                { role: "user", content: `${env.OPENAI_PROCESS_EMAIL_USER_PROMPT}\n\n${emailData}` },
            ],
            model: env.OPENAI_PROCESS_EMAIL_MODEL,
            store: false,
        });

        try {
            const content = JSON.parse(completion.choices[0]?.message?.content?.replaceAll('`', '') || '');
            if (content.result === "failed") {
                console.warn("🤖 Not a transaction email");
                return false;
            }

            console.info(`🤖 Processed email content: ${JSON.stringify(content)}`);
            return content;
        } catch {
            console.error("🤖 Failed to parse transaction details");
            return false;
        }
    },

    async storeTransaction(details, env: Environment) {
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
        const uploadResponse = await fetch('https://api.openai.com/v1/files', {
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
        const vectorStoreResponse = await fetch(`https://api.openai.com/v1/vector_stores/${env.OPENAI_ASSISTANT_VECTORSTORE_ID}/files`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
                'Content-Type': 'application/json',
                'OpenAI-Beta': 'assistants=v2',
            },
            body: JSON.stringify({ file_id: fileId }),
        });

        // Check if the response for adding to vector store is okay
        if (!vectorStoreResponse.ok) {
            throw new Error(`Error adding file to vector store: ${vectorStoreResponse.statusText}`);
        }

        console.info(`🤖 Add ${fileName} to Vector store successfully`)

        // Return the response from the vector store
        return vectorStoreResponse.json();
    },

    async notifyServices(details: any, env: Environment) {
        await this.sendTelegramNotification(details, env);
    },

    async sendTelegramNotification(details: any, env: Environment) {
        const bot = new Telegraf(env.TELEGRAM_BOT_TOKEN);
        const message = formatTransactionDetails(details);
        await sendTelegramMessage(bot, env.TELEGRAM_CHAT_ID, message);
    },
};
