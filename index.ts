import { Hono } from 'hono'
import PostalMime from 'postal-mime'
import OpenAI from 'openai'
import { Telegraf } from 'telegraf'

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
}

const app = new Hono<{
    Bindings: Environment
}>()

function escapeMarkdownV2(text) {
    return text
        .replace(/_/g, '\\_')
        .replace(/\[/g, '\\[')
        .replace(/\]/g, '\\]')
        .replace(/\(/g, '\\(')
        .replace(/\)/g, '\\)')
        .replace(/~/g, '\\~')
        .replace(/`/g, '\\`')
        .replace(/>/g, '\\>')
        .replace(/#/g, '\\#')
        .replace(/\+/g, '\\+')
        .replace(/-/g, '\\-')
        .replace(/=/g, '\\=')
        .replace(/\|/g, '\\|')
        .replace(/\{/g, '\\{')
        .replace(/\}/g, '\\}')
        .replace(/\./g, '\\.')
        .replace(/!/g, '\\!');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.post('/assistant', async (c) => {
    if (c.req.header('X-Telegram-Bot-Api-Secret-Token') != c.env.TELEGRAM_BOT_SECRET_TOKEN) {
        console.error("🔐 Authentication failed here")
        return c.text("You are not welcome here")
    }

    const body = await c.req.json()
    console.info("🔫 Received new request", body.message)

    const openai = new OpenAI({
        project: c.env.OPENAI_PROJECT_ID,
        apiKey: c.env.OPENAI_API_KEY,
    });
    
    let run = await openai.beta.threads.createAndRun({
        assistant_id: c.env.OPENAI_ASSISTANT_ID,
        thread: {
            messages: [
                { role: "user", content: body.message.text },
            ],
        },
    });
    console.info("🔫 Create threads and run successfully", run.thread_id)

    while (run.status === "queued" || run.status === "in_progress") {
        // Retrieve the updated run status
        run = await openai.beta.threads.runs.retrieve(
            run.thread_id,
            run.id
        );
        await sleep(500);
    }

    const threadMessages = await openai.beta.threads.messages.list(
        run.thread_id, {
        run_id: run.id
    });

    const msg = `🥳 Báo cáo cuối ngày tới rồi đêi\n\n${threadMessages.data[0].content[0].text.value.replace(/【\d+:\d+†source】/g, '')}\n-------------------`;

    console.info("🔫 Message process successfully", escapeMarkdownV2(msg))

    const bot = new Telegraf(c.env.TELEGRAM_BOT_TOKEN);
    await bot.telegram.sendMessage(c.env.TELEGRAM_CHAT_ID, escapeMarkdownV2(msg), {
        parse_mode: "MarkdownV2",
        reply_parameters: {
            message_id: body.message.message_id
        }
    }).then(() => {
        console.info("🏄 Send Telegram response successfully")
    })

    return c.text("Okay");
})

export default {
    fetch: app.fetch,
    async scheduled(env: Environment) {
        const openai = new OpenAI({
            project: env.OPENAI_PROJECT_ID,
            apiKey: env.OPENAI_API_KEY,
        });
    
        const currentDate = new Date().toLocaleDateString('en-GB');
        let run = await openai.beta.threads.createAndRun({
            assistant_id: env.OPENAI_ASSISTANT_ID,
            thread: {
                messages: [
                    { role: "user", content: `${env.OPENAI_ASSISTANT_SCHEDULED_PROMPT} ${currentDate}` },
                ],
            },
        });
        console.info("🔫 Create scheduled threads and run successfully", currentDate, run.thread_id)
    
        while (run.status === "queued" || run.status === "in_progress") {
            // Retrieve the updated run status
            run = await openai.beta.threads.runs.retrieve(
                run.thread_id,
                run.id
            );
            await sleep(500);
        }
    
        const threadMessages = await openai.beta.threads.messages.list(
            run.thread_id, {
            run_id: run.id
        });
    
        const msg = threadMessages.data[0].content[0].text.value.replace(/【\d+:\d+†source】/g, '')
        console.info("🔫 Message process successfully", escapeMarkdownV2(msg))
    
        const bot = new Telegraf(env.TELEGRAM_BOT_TOKEN);
        await bot.telegram.sendMessage(env.TELEGRAM_CHAT_ID, escapeMarkdownV2(msg), {
            parse_mode: "MarkdownV2",
        }).then(() => {
            console.info("🏄 Send Telegram scheduled message successfully")
        })
    
        return "Should be okay";
    },
    async email(message, env: Environment) {
        // Parse the email using PostalMime
        const parser = new PostalMime();
        const body = await new Response(message.raw).arrayBuffer();
        const email = await parser.parse(body);
        console.info("📬 New mail arrived", email.text)

        const emailContent = email.text || email.html;
        if (!emailContent) {
            throw new Error("Email content is empty");
        }
        const emailDate = email.date;
        const emailFromName = email.from.name;

        const emailData = `Email date: ${emailDate}\nEmail sender: ${emailFromName}\nEmail content:\n${emailContent}`;
        const transactionDetails = await this.processEmail(emailData, env);

        if (transactionDetails === false) return "Not okay";

        // Handle storing and notifying separately
        await this.storeTransaction(transactionDetails, env);
        await this.notifyServices(transactionDetails, env);

        return "Okay";
    },

    async processEmail(emailData: string, env: Environment) {
        if (!emailData) {
            throw new Error("Email content is empty");
        }

        const openai = new OpenAI({
            project: env.OPENAI_PROJECT_ID,
            apiKey: env.OPENAI_API_KEY,
        });

        const completion = await openai.chat.completions.create({
            messages: [
                { role: "system", content: env.OPENAI_PROCESS_EMAIL_SYSTEM_PROMPT },
                { role: "user", content: `${env.OPENAI_PROCESS_EMAIL_USER_PROMPT}\n\n${emailData}` },
            ],
            model: env.OPENAI_PROCESS_EMAIL_MODEL,
            store: false,
        });

        const extractedData = completion.choices[0]?.message?.content?.replaceAll('`', '');
        let transactionDetails;
        try {
            transactionDetails = JSON.parse(extractedData);
            if (transactionDetails.result === "failed") {
                console.info("📬 Not a transaction email. Notification disabled.");
                return false;
            }
        } catch (e) {
            return console.error("Unable to parse transaction details");
        }

        return transactionDetails;
    },

    async storeTransaction(details, env: Environment) {
        const fileName = `ArgusChiTieu_transaction_${new Date().toISOString()}.txt`;

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
        // Future services (e.g., SMS) can be added here
    },

    async sendTelegramNotification(details: any, env: Environment) {
        const bot = new Telegraf(env.TELEGRAM_BOT_TOKEN);

        const humanReadableText = this.formatTransactionDetails(details);
        await bot.telegram.sendMessage(env.TELEGRAM_CHAT_ID, escapeMarkdownV2(humanReadableText), { parse_mode: "MarkdownV2" }).then(() => {
            console.info("🏄 Send Telegram notification successfully")
        })
    },

    formatTransactionDetails(details: any) {
        if (details.error) {
            return `Transaction error: ${details.error}`;
        }

        return `💳 *Có giao dịch thẻ mới nè*\n\n${details.message}\n\n*Từ:* ${details.bank_name || "N/A"}\n*Ngày:* ${details.datetime || "N/A"}\n------------------`;
    },
}
