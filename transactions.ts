import PostalMime from 'postal-mime';
import { Buffer } from 'node:buffer';
import { DEFAULT_PROCESS_EMAIL_MODEL } from './config';
import { createOpenAIClient } from './openai';
import { formatTransactionDetails, sendTelegramMessage } from './telegram';
import type { Environment } from './types';

export const processTransaction = async (emailData: string, env: Environment) => {
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
};

export const storeTransaction = async (details, env: Environment) => {
    const fileName = `ArgusChiTieu_transaction_${new Date().toISOString()}.txt`;

    // Seems Cloudflare not allow Workers to write temporary files so
    // we use HTTP API instead of client library.
    const transactionText = JSON.stringify(details, null, 2);
    const formData = new FormData();
    formData.append('purpose', 'assistants');

    const blob = Buffer.from(transactionText);
    const file = new File([blob], fileName, { type: 'application/json' });
    formData.append('file', file);

    const uploadResponse = await fetch(`${env.AI_API_GATEWAY || "https://api.openai.com/v1"}/files`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
        },
        body: formData,
    });

    if (!uploadResponse.ok) {
        throw new Error(`Upload transaction file error: ${uploadResponse.statusText}`);
    }

    console.info(`🤖 Upload ${fileName} successfully`);

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

    if (!vectorStoreResponse.ok) {
        throw new Error(`Error adding file to vector store: ${vectorStoreResponse.statusText}`);
    }

    console.info(`🤖 Add ${fileName} to Vector store successfully`);
};

export const notifyServices = async (details: any, env: Environment) => {
    const message = formatTransactionDetails(details);
    await sendTelegramMessage(env, message);
};

export const email = async (message, env: Environment) => {
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
};
