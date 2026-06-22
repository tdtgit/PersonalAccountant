import { Buffer } from 'node:buffer';
import { formatDate } from '../utils/date';
import { createOpenAIClient } from '../services/openai';
import { processTransaction, storeTransaction, notifyServices } from './transactions';
import { buildMessageWithReplyContext, sendTelegramMessage } from '../services/telegram';
import type { Environment } from '../types';

export const askTransactionAssistant = async (env: Environment, input: string) => {
	const response = await createOpenAIClient(env).responses.create({
		model: env.OPENAI_ASSISTANT_MODEL,
		instructions: `Answer personal finance questions using the transaction vector store. If the user reply includes a previous Telegram message, use it as context for the current request. Be concise and answer in Vietnamese unless the user asks otherwise. ${env.OPENAI_ASSISTANT_RESPONSE_FORMAT_INSTRUCTIONS}`,
		input,
		tools: [
			{
				type: 'file_search',
				vector_store_ids: [env.OPENAI_ASSISTANT_VECTORSTORE_ID],
			},
		],
	});

	return response.output_text;
};

export const createAndProcessScheduledReport = async (env: Environment, reportType: 'ngày' | 'tuần' | 'tháng') => {
	const prompt = env.OPENAI_ASSISTANT_SCHEDULED_PROMPT.replace('%DATETIME%', formatDate(reportType));
	console.info(`⏰ Processing report for prompt ${prompt}`);

	const msgContent = await askTransactionAssistant(env, prompt);
	console.info(`⏰ ${reportType.charAt(0).toUpperCase() + reportType.slice(1)} report processed:`, msgContent);

	const msg = `🥳 Báo cáo ${reportType} tới rồi đêi\n\n${msgContent}\n------------------`;
	await sendTelegramMessage(env, msg);

	console.info(`⏰ ${reportType.charAt(0).toUpperCase() + reportType.slice(1)} message sent successfully`);
	return '⏰ Scheduled process completed';
};

export const assistantQuestion = async (c, message, question?: string) => {
	const msg = await askTransactionAssistant(c.env, buildMessageWithReplyContext(message, question));
	console.info('🔫 Message processed successfully:', msg);

	await sendTelegramMessage(c.env, msg, { reply_to_message_id: message.message_id });

	return c.text('Request completed');
};

const getLatestPhotoFileId = (message): string | null => {
	const photos = message?.photo;
	if (!Array.isArray(photos) || photos.length === 0) return null;
	return photos[photos.length - 1]?.file_id ?? null;
};

const downloadTelegramFile = async (fileId: string, env: Environment) => {
	const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`;
	const response = await fetch(url);
	const data = await response.json();
	const fileUrl = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${data.result.file_path}`;
	const fileResponse = await fetch(fileUrl);
	const buffer = Buffer.from(await fileResponse.arrayBuffer());

	const fileExtension = data.result.file_path.split('.').pop();
	const imageType = fileExtension ? fileExtension : 'jpeg';

	console.log('🔫 File downloaded successfully', `data:image/${imageType};base64,${buffer.toString('base64')}`);

	return `data:image/${imageType};base64,${buffer.toString('base64')}`;
};

const imageOcr = async (message, c) => {
	const fileId = getLatestPhotoFileId(message);
	if (!fileId) throw new Error('No photo found in telegram message');

	let imgB64 = await downloadTelegramFile(fileId, c.env);

	const response = await createOpenAIClient(c.env).responses.create({
		model: c.env.OPENAI_OCR_MODEL,
		input: [
			{
				role: 'user',
				content: [
					{
						type: 'input_text',
						text: `Print the text inside the image. Try to focus on store name, date time (if not found, please use ${formatDate()}), price tag of receipt`,
					},
					{
						type: 'input_image',
						image_url: imgB64,
						detail: 'auto',
					},
				],
			},
		],
	});

	return response.output_text;
};

const assistantOcr = async (message, c) => {
	const transaction = await imageOcr(message, c);
	const transactionDetails = await processTransaction(transaction, c.env);

	if (!transactionDetails) return 'Not okay';
	await Promise.all([storeTransaction(transactionDetails, c.env), notifyServices(transactionDetails, c.env)]);
	return '📬 Email processed successfully';
};

export const buildManualTransactionInput = (transaction: string) => {
	const currentMessage = transaction.split('Current user message:\n').pop()?.trim() || transaction;

	return [
		'Manual transaction request from Telegram user.',
		'Parse the user message as a transaction to record. Extract the date, amount, currency, and description from the message when present.',
		`User message: ${currentMessage}`,
	].join('\n');
};

const assistantManualTransaction = async (transaction, env: Environment) => {
	console.info('🔫 Processing manual transaction:', transaction);
	const transactionDetails = await processTransaction(buildManualTransactionInput(transaction), env, 'manual');

	if (!transactionDetails) return 'Not okay';
	await Promise.all([storeTransaction(transactionDetails, env), notifyServices(transactionDetails, env)]);
	return '📬 Email processed successfully';
};

export const verifyAssistantRequest = async (c) => {
	const secretToken = c.req.header('X-Telegram-Bot-Api-Secret-Token');
	if (!secretToken || secretToken !== c.env.TELEGRAM_BOT_SECRET_TOKEN) {
		console.error('Authentication failed. You are not welcome here');
		return c.text('Unauthorized', 401);
	}

	const { message } = await c.req.json();

	if (message.from.id != c.env.TELEGRAM_CHAT_ID) {
		console.warn('⚠️ Received new assistant request from unknown chat:', message);
		await sendTelegramMessage(c.env, 'Bạn là người dùng không xác định, bạn không phải anh Ảgú');
		return c.text('Unauthorized user');
	}

	return message;
};

export const handleAssistantRequest = async (c) => {
	const message = await verifyAssistantRequest(c);
	if (message instanceof Response) {
		return message;
	}

	const available_functions = [
		{
			type: 'function',
			name: 'assistantQuestion',
			description: 'Answer questions about existing transactions, summaries, totals, or whether something has already been recorded.',
			parameters: {
				type: 'object',
				properties: {
					question: {
						type: 'string',
						description: "Question in user's request",
					},
				},
				required: ['question'],
				additionalProperties: false,
			},
			strict: false,
		},
		{
			type: 'function',
			name: 'assistantOcr',
			description: 'Process image sent by user and extract information.',
			parameters: {
				type: 'object',
				properties: {
					image: {
						type: 'string',
						description: 'Image sent by user',
					},
				},
				required: ['image'],
				additionalProperties: false,
			},
			strict: false,
		},
		{
			type: 'function',
			name: 'assistantManualTransaction',
			description:
				'Record a manual transaction when the user asks to add, note, save, or record spending. Use this even when the message is phrased conditionally, for example "if it has not been added yet, note it", as long as the user provides transaction details.',
			parameters: {
				type: 'object',
				properties: {
					transaction: {
						type: 'string',
						description: 'Content of transaction',
					},
				},
				required: ['transaction'],
				additionalProperties: false,
			},
			strict: false,
		},
	] as const;

	if (message.text === undefined) {
		console.log('🔫 Processing case assistantOcr');
		await assistantOcr(message, c);
		return c.text('Success');
	}

	console.log('🔫 /assistant/OpenAiResponse request:', message.text);
	const response = await createOpenAIClient(c.env).responses.create({
		model: c.env.OPENAI_ASSISTANT_ROUTER_MODEL,
		instructions: [
			'You are a Telegram finance assistant router. Decide which tool to call from the user message.',
			'Call assistantQuestion when the user only asks for information about existing transactions, totals, reports, or whether a transaction already exists.',
			'Call assistantManualTransaction when the user asks to add, note, save, or record a transaction and provides transaction details such as amount, date, merchant, person, or description.',
			'If the message both asks whether a transaction exists and asks to add/note/save it if missing, treat it as a manual transaction request and pass the full user message to assistantManualTransaction.',
			'Do not rely on fixed keywords only; infer the user intent from the whole message.',
		].join('\n'),
		input: [
			{
				role: 'user',
				content: buildMessageWithReplyContext(message),
			},
		],
		tools: [...available_functions],
	});
	console.log('🔫 /assistant/OpenAiResponse response:', response);

	const functionCall = response.output.find((item) => item.type === 'function_call');
	if (!functionCall) {
		console.log('🔫 No function call from model, falling back to assistantQuestion');
		await assistantQuestion(c, message);
		return c.text('Success');
	}

	switch (functionCall.name) {
		case 'assistantManualTransaction':
			console.log('🔫 Processing case assistantManualTransaction');
			await assistantManualTransaction(JSON.parse(functionCall.arguments).transaction, c.env);
			break;
		case 'assistantQuestion':
			console.log('🔫 Processing case assistantQuestion');
			await assistantQuestion(c, message, JSON.parse(functionCall.arguments).question);
			break;
		default:
			console.log('🔫 Processing default case');
			return c.text('Request completed');
	}

	return c.text('Success');
};

export const dailyReport = async (env: Environment) => createAndProcessScheduledReport(env, 'ngày');
export const weeklyReport = async (env: Environment) => createAndProcessScheduledReport(env, 'tuần');
export const monthlyReport = async (env: Environment) => createAndProcessScheduledReport(env, 'tháng');
