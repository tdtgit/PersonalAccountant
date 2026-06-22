import { beforeEach, describe, expect, it, mock } from 'bun:test';

let openAiResponses: unknown[] = [];
const openAiResponsesCreate = mock(async () => {
	const response = openAiResponses.shift();
	if (response instanceof Error) throw response;
	return response;
});

const sendMessageMock = mock(async () => undefined);

let parsedEmail: any = null;
const parseEmailMock = mock(async () => parsedEmail);

let fetchHandler: typeof fetch = async () => new Response(null, { status: 404 });
const fetchMock = mock((input: RequestInfo | URL, init?: RequestInit) => fetchHandler(input, init));

mock.module('openai', () => ({
	default: class MockOpenAI {
		responses = {
			create: openAiResponsesCreate,
		};
	},
}));

mock.module('telegraf', () => ({
	Telegraf: class MockTelegraf {
		telegram = {
			sendMessage: sendMessageMock,
		};
	},
}));

mock.module('postal-mime', () => ({
	default: class MockPostalMime {
		parse = parseEmailMock;
	},
}));

const {
	buildMessageWithReplyContext,
	default: worker,
	formatTransactionDetails,
	normalize,
	stripTelegramMarkdown,
} = await import('../index');
const { createAndProcessScheduledReport, handleAssistantRequest, isManualTransactionText, verifyAssistantRequest } =
	await import('../handlers/assistant');
const { formatDate } = await import('../utils/date');
const { email, processTransaction, storeTransaction } = await import('../handlers/transactions');

const env = {
	TELEGRAM_CHAT_ID: '12345',
	TELEGRAM_BOT_TOKEN: 'telegram-token',
	TELEGRAM_BOT_SECRET_TOKEN: 'secret-token',
	AI_API_GATEWAY: 'https://gateway.example/openai',
	OPENAI_PROJECT_ID: 'project-id',
	OPENAI_API_KEY: 'openai-key',
	OPENAI_PROCESS_EMAIL_SYSTEM_PROMPT: 'Extract transaction JSON',
	OPENAI_PROCESS_EMAIL_USER_PROMPT: 'Process this email',
	OPENAI_PROCESS_EMAIL_MODEL: 'transaction-model',
	OPENAI_OCR_MODEL: 'ocr-model',
	OPENAI_ASSISTANT_MODEL: 'assistant-model',
	OPENAI_ASSISTANT_ROUTER_MODEL: 'router-model',
	OPENAI_ASSISTANT_RESPONSE_FORMAT_INSTRUCTIONS: 'Format for Telegram.',
	OPENAI_ASSISTANT_VECTORSTORE_ID: 'vector-store-id',
	OPENAI_ASSISTANT_SCHEDULED_PROMPT: 'Report for %DATETIME%',
};

const makeContext = ({ body, header = env.TELEGRAM_BOT_SECRET_TOKEN }: { body: unknown; header?: string | undefined }) => ({
	env,
	req: {
		header: mock(() => header),
		json: mock(async () => body),
	},
	text: (text: string, status = 200) => new Response(text, { status }),
});

beforeEach(() => {
	openAiResponses = [];
	parsedEmail = null;
	fetchHandler = async () => new Response(null, { status: 404 });
	fetchMock.mockClear();
	openAiResponsesCreate.mockClear();
	sendMessageMock.mockClear();
	parseEmailMock.mockClear();
	globalThis.fetch = fetchMock as unknown as typeof fetch;
});

describe('normalize', () => {
	it('escapes Telegram MarkdownV2 characters and removes source markers', () => {
		const input = 'Amount [100]_! from #shop.【12:3†source】';
		const output = normalize(input);

		expect(output).toBe('Amount \\[100\\]\\_\\! from \\#shop\\.');
	});

	it('escapes Telegram MarkdownV2 parentheses', () => {
		expect(normalize('Paid (AUD)')).toBe('Paid \\(AUD\\)');
	});

	it('preserves single-asterisk Telegram MarkdownV2 bold markers', () => {
		expect(normalize('*Tổng cộng:* 100 AUD')).toBe('*Tổng cộng:* 100 AUD');
	});

	it('strips Telegram Markdown markers for the plain-text fallback', () => {
		expect(stripTelegramMarkdown('*Tổng cộng:* 100 AUD (ước tính).【12:3†source】')).toBe('Tổng cộng: 100 AUD ước tính');
	});
});

describe('formatTransactionDetails', () => {
	it('returns a transaction error message when error exists', () => {
		expect(formatTransactionDetails({ error: 'Invalid payload' })).toBe('Transaction error: Invalid payload');
	});

	it('falls back to N/A when fields are missing', () => {
		const result = formatTransactionDetails({ message: 'Paid 100k' });

		expect(result).toContain('Paid 100k');
		expect(result).toContain('*Từ:* N/A');
		expect(result).toContain('*Ngày:* N/A');
	});
});

describe('buildMessageWithReplyContext', () => {
	it('uses the current Telegram text when there is no reply', () => {
		expect(buildMessageWithReplyContext({ text: 'Tháng này tốn bao nhiêu?' })).toBe('Tháng này tốn bao nhiêu?');
	});

	it('uses a caption as the current Telegram message', () => {
		expect(buildMessageWithReplyContext({ caption: 'Hoa don cafe' })).toBe('Hoa don cafe');
	});

	it('uses the fallback text when provided', () => {
		expect(buildMessageWithReplyContext({ text: 'ignored' }, 'Override question')).toBe('Override question');
	});

	it('includes the replied Telegram message as context', () => {
		const result = buildMessageWithReplyContext({
			text: 'Cái này là gì?',
			reply_to_message: { text: 'Bạn đã tiêu 120.000 VNĐ ở Highlands.' },
		});

		expect(result).toContain('Previous Telegram message:\nBạn đã tiêu 120.000 VNĐ ở Highlands.');
		expect(result).toContain('Current user message:\nCái này là gì?');
	});
});

describe('isManualTransactionText', () => {
	it('identifies manual transaction add commands with amounts', () => {
		expect(isManualTransactionText('Add vào giao dịch ngày 21/06/2026: Đóng tiền khám bệnh cho Coca: 540,000đ')).toBe(true);
		expect(isManualTransactionText('Thêm giao dịch ăn trưa 80k')).toBe(true);
		expect(isManualTransactionText('Tháng này tốn bao nhiêu?')).toBe(false);
		expect(isManualTransactionText('Thêm giao dịch này giúp mình nhé')).toBe(false);
	});
});

describe('formatDate', () => {
	it('formats supported report periods', () => {
		expect(formatDate('ngày')).toMatch(/^\d{1,2}\/\d{1,2}\/\d{4}$/);
		expect(formatDate('tuần')).toMatch(/^ từ \d{1,2}\/\d{1,2}\/\d{4} đến \d{1,2}\/\d{1,2}\/\d{4}$/);
		expect(formatDate('tháng')).toMatch(/^\d{1,2}\/\d{4}$/);
	});

	it('formats the default timestamp used by OCR prompts', () => {
		expect(formatDate()).toContain(' vào lúc ');
	});
});

describe('verifyAssistantRequest', () => {
	it('rejects requests without the Telegram secret token', async () => {
		const result = await verifyAssistantRequest(
			makeContext({
				body: { message: { from: { id: env.TELEGRAM_CHAT_ID } } },
				header: '',
			}),
		);

		expect(result).toBeInstanceOf(Response);
		expect(result.status).toBe(401);
		expect(await result.text()).toBe('Unauthorized');
	});

	it('rejects requests from a different Telegram chat and notifies the configured chat', async () => {
		const result = await verifyAssistantRequest(
			makeContext({
				body: { message: { from: { id: '999' }, text: 'hello' } },
			}),
		);

		expect(result).toBeInstanceOf(Response);
		expect(await result.text()).toBe('Unauthorized user');
		expect(sendMessageMock).toHaveBeenCalledWith(
			env.TELEGRAM_CHAT_ID,
			expect.stringContaining('Bạn là người dùng không xác định'),
			expect.objectContaining({ parse_mode: 'MarkdownV2' }),
		);
	});

	it('returns the Telegram message for an authorized request', async () => {
		const message = { from: { id: env.TELEGRAM_CHAT_ID }, text: 'Tháng này sao rồi?' };

		await expect(verifyAssistantRequest(makeContext({ body: { message } }))).resolves.toBe(message);
	});
});

describe('handleAssistantRequest', () => {
	it('detects add-transaction text without waiting for the router function call', async () => {
		const uploadedRequests: Array<{ url: string; init?: RequestInit }> = [];
		fetchHandler = async (input, init) => {
			const url = String(input);
			uploadedRequests.push({ url, init });
			if (url.endsWith('/files')) return Response.json({ id: 'file-manual-text-123' });
			if (url.endsWith('/vector_stores/vector-store-id/files')) {
				return Response.json({ id: 'vector-file-manual-text-123' });
			}
			return new Response(null, { status: 404 });
		};
		openAiResponses = [
			{
				output_text: JSON.stringify({
					result: 'success',
					message: 'Đóng tiền khám bệnh cho Coca: 540,000đ',
					bank_name: 'Manual',
					datetime: '2026-06-21',
				}),
			},
		];

		const response = await handleAssistantRequest(
			makeContext({
				body: {
					message: {
						from: { id: env.TELEGRAM_CHAT_ID },
						message_id: 76,
						text: 'Add vào giao dịch ngày 21/06/2026: Đóng tiền khám bệnh cho Coca: 540,000đ',
					},
				},
			}),
		);

		expect(await response.text()).toBe('Success');
		expect(openAiResponsesCreate).toHaveBeenCalledTimes(1);
		expect(openAiResponsesCreate.mock.calls[0][0]).toMatchObject({
			model: 'transaction-model',
			input: 'Process this email\n\nAdd vào giao dịch ngày 21/06/2026: Đóng tiền khám bệnh cho Coca: 540,000đ',
			store: false,
		});
		expect(uploadedRequests.map((request) => request.url)).toEqual([
			'https://gateway.example/openai/files',
			'https://gateway.example/openai/vector_stores/vector-store-id/files',
		]);
		expect(sendMessageMock).toHaveBeenCalledWith(
			env.TELEGRAM_CHAT_ID,
			expect.stringContaining('Đóng tiền khám bệnh cho Coca: 540,000đ'),
			expect.objectContaining({ parse_mode: 'MarkdownV2' }),
		);
	});

	it('returns Hono and Cloudflare runtime metadata at the root route', async () => {
		const response = await worker.fetch(new Request('https://worker.example/'), env);

		await expect(response.json()).resolves.toMatchObject({
			ok: true,
			service: 'PersonalAccountant',
			runtime: 'Cloudflare Workers',
			framework: 'Hono',
		});
	});

	it('falls back to assistantQuestion when the router returns no function call', async () => {
		openAiResponses = [{ output: [] }, { output_text: 'Bạn đã tiêu 100.000 VNĐ hôm nay.' }];

		const response = await handleAssistantRequest(
			makeContext({
				body: {
					message: {
						from: { id: env.TELEGRAM_CHAT_ID },
						message_id: 77,
						text: 'Hôm nay tiêu gì?',
					},
				},
			}),
		);

		expect(await response.text()).toBe('Success');
		expect(openAiResponsesCreate).toHaveBeenCalledTimes(2);
		expect(openAiResponsesCreate.mock.calls[0][0]).toMatchObject({
			model: 'router-model',
			input: [{ role: 'user', content: 'Hôm nay tiêu gì?' }],
		});
		expect(openAiResponsesCreate.mock.calls[1][0]).toMatchObject({
			model: 'assistant-model',
			input: 'Hôm nay tiêu gì?',
			tools: [{ type: 'file_search', vector_store_ids: [env.OPENAI_ASSISTANT_VECTORSTORE_ID] }],
		});
		expect(openAiResponsesCreate.mock.calls[1][0].instructions).toContain('Format for Telegram.');
		expect(sendMessageMock).toHaveBeenCalledWith(
			env.TELEGRAM_CHAT_ID,
			expect.stringContaining('Bạn đã tiêu 100\\.000 VNĐ hôm nay\\.'),
			expect.objectContaining({ reply_to_message_id: 77, parse_mode: 'MarkdownV2' }),
		);
	});

	it('processes a manual transaction function call', async () => {
		const uploadedRequests: Array<{ url: string; init?: RequestInit }> = [];
		fetchHandler = async (input, init) => {
			const url = String(input);
			uploadedRequests.push({ url, init });
			if (url.endsWith('/files')) {
				return Response.json({ id: 'file-123' });
			}
			if (url.endsWith('/vector_stores/vector-store-id/files')) {
				return Response.json({ id: 'vector-file-123' });
			}
			return new Response(null, { status: 404 });
		};
		openAiResponses = [
			{
				output: [
					{
						type: 'function_call',
						name: 'assistantManualTransaction',
						arguments: JSON.stringify({ transaction: 'Cafe 50k' }),
					},
				],
			},
			{
				output_text: JSON.stringify({
					result: 'success',
					message: 'Cafe 50k',
					bank_name: 'Manual',
					datetime: '2026-06-20 10:00',
				}),
			},
		];

		const response = await handleAssistantRequest(
			makeContext({
				body: {
					message: {
						from: { id: env.TELEGRAM_CHAT_ID },
						message_id: 78,
						text: 'Ghi nhận Cafe 50k',
					},
				},
			}),
		);

		expect(await response.text()).toBe('Success');
		expect(openAiResponsesCreate).toHaveBeenCalledTimes(2);
		expect(openAiResponsesCreate.mock.calls[1][0]).toMatchObject({
			input: 'Process this email\n\nCafe 50k',
			store: false,
		});
		expect(uploadedRequests.map((request) => request.url)).toEqual([
			'https://gateway.example/openai/files',
			'https://gateway.example/openai/vector_stores/vector-store-id/files',
		]);
		expect(sendMessageMock).toHaveBeenCalledWith(
			env.TELEGRAM_CHAT_ID,
			expect.stringContaining('Cafe 50k'),
			expect.objectContaining({ parse_mode: 'MarkdownV2' }),
		);
	});

	it('processes an OCR image message when Telegram text is absent', async () => {
		const fetchUrls: string[] = [];
		fetchHandler = async (input) => {
			const url = String(input);
			fetchUrls.push(url);
			if (url.includes('/getFile?file_id=large-photo')) {
				return Response.json({ result: { file_path: 'receipts/receipt.jpg' } });
			}
			if (url.includes('/file/bottelegram-token/receipts/receipt.jpg')) {
				return new Response(new Uint8Array([1, 2, 3]).buffer);
			}
			if (url.endsWith('/files')) {
				return Response.json({ id: 'file-ocr-123' });
			}
			if (url.endsWith('/vector_stores/vector-store-id/files')) {
				return Response.json({ id: 'vector-file-ocr-123' });
			}
			return new Response(null, { status: 404 });
		};
		openAiResponses = [
			{ output_text: 'Receipt text: Coffee 75k' },
			{
				output_text: JSON.stringify({
					result: 'success',
					message: 'Coffee 75k',
					bank_name: 'Receipt',
					datetime: '2026-06-20 11:00',
				}),
			},
		];

		const response = await handleAssistantRequest(
			makeContext({
				body: {
					message: {
						from: { id: env.TELEGRAM_CHAT_ID },
						message_id: 79,
						photo: [{ file_id: 'small-photo' }, { file_id: 'large-photo' }],
					},
				},
			}),
		);

		expect(await response.text()).toBe('Success');
		expect(fetchUrls.slice(0, 2)).toEqual([
			'https://api.telegram.org/bottelegram-token/getFile?file_id=large-photo',
			'https://api.telegram.org/file/bottelegram-token/receipts/receipt.jpg',
		]);
		expect(openAiResponsesCreate.mock.calls[0][0].input[0].content[1]).toMatchObject({
			type: 'input_image',
			image_url: expect.stringContaining('data:image/jpg;base64,'),
		});
		expect(openAiResponsesCreate.mock.calls[1][0]).toMatchObject({
			input: 'Process this email\n\nReceipt text: Coffee 75k',
			store: false,
		});
		expect(sendMessageMock).toHaveBeenCalledWith(
			env.TELEGRAM_CHAT_ID,
			expect.stringContaining('Coffee 75k'),
			expect.objectContaining({ parse_mode: 'MarkdownV2' }),
		);
	});
});

describe('scheduled reports', () => {
	it('creates a scheduled report and sends it to Telegram', async () => {
		openAiResponses = [{ output_text: 'Report body' }];

		await expect(createAndProcessScheduledReport(env, 'ngày')).resolves.toBe('⏰ Scheduled process completed');

		expect(openAiResponsesCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				input: expect.stringContaining('Report for '),
				tools: [{ type: 'file_search', vector_store_ids: [env.OPENAI_ASSISTANT_VECTORSTORE_ID] }],
			}),
		);
		expect(openAiResponsesCreate.mock.calls[0][0].input).not.toContain('%DATETIME%');
		expect(sendMessageMock).toHaveBeenCalledWith(
			env.TELEGRAM_CHAT_ID,
			expect.stringContaining('Báo cáo ngày tới rồi đêi'),
			expect.objectContaining({ parse_mode: 'MarkdownV2' }),
		);
	});

	it('dispatches Worker scheduled events by cron expression', async () => {
		openAiResponses = [{ output_text: 'Daily report' }, { output_text: 'Weekly report' }, { output_text: 'Monthly report' }];

		await worker.scheduled({ cron: '0 15 * * *' }, env);
		await worker.scheduled({ cron: '58 16 * * 1' }, env);
		await worker.scheduled({ cron: '0 15 1 * *' }, env);

		expect(openAiResponsesCreate).toHaveBeenCalledTimes(3);
		expect(sendMessageMock.mock.calls[0][1]).toContain('Báo cáo ngày');
		expect(sendMessageMock.mock.calls[1][1]).toContain('Báo cáo tuần');
		expect(sendMessageMock.mock.calls[2][1]).toContain('Báo cáo tháng');
	});
});

describe('processTransaction', () => {
	it('parses transaction JSON from the OpenAI response', async () => {
		openAiResponses = [{ output_text: '```{"result":"success","message":"Paid 100k"}```' }];

		await expect(processTransaction('Bank email', env)).resolves.toEqual({
			result: 'success',
			message: 'Paid 100k',
		});
		expect(openAiResponsesCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				model: 'transaction-model',
				instructions: 'Extract transaction JSON',
				input: 'Process this email\n\nBank email',
				store: false,
			}),
		);
	});

	it('returns undefined for invalid JSON or non-transaction emails', async () => {
		openAiResponses = [{ output_text: 'not json' }, { output_text: JSON.stringify({ result: 'failed' }) }];

		await expect(processTransaction('Bad payload', env)).resolves.toBeUndefined();
		await expect(processTransaction('Newsletter', env)).resolves.toBeUndefined();
	});
});

describe('storeTransaction', () => {
	it('uploads the transaction file and attaches it to the assistant vector store', async () => {
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		fetchHandler = async (input, init) => {
			requests.push({ url: String(input), init });
			return requests.length === 1 ? Response.json({ id: 'file-123' }) : Response.json({ id: 'vector-file-123' });
		};

		await storeTransaction({ message: 'Paid 100k' }, env);

		expect(requests.map((request) => request.url)).toEqual([
			'https://gateway.example/openai/files',
			'https://gateway.example/openai/vector_stores/vector-store-id/files',
		]);
		expect(requests[0].init).toMatchObject({
			method: 'POST',
			headers: { Authorization: 'Bearer openai-key' },
		});
		expect(requests[1].init).toMatchObject({
			method: 'POST',
			headers: {
				Authorization: 'Bearer openai-key',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ file_id: 'file-123' }),
		});
	});

	it('throws when the upload fails', async () => {
		fetchHandler = async () => new Response(null, { status: 500, statusText: 'Server Error' });

		await expect(storeTransaction({ message: 'Paid 100k' }, env)).rejects.toThrow('Upload transaction file error: Server Error');
	});
});

describe('email', () => {
	it('parses an incoming email, stores the transaction, and notifies Telegram', async () => {
		parsedEmail = {
			date: '2026-06-20T10:00:00.000Z',
			from: { address: 'bank@example.com', name: 'Bank' },
			subject: 'Card transaction',
			text: 'Paid 100k at store',
			html: '',
		};
		fetchHandler = async (input) => {
			const url = String(input);
			if (url.endsWith('/files')) return Response.json({ id: 'file-123' });
			if (url.endsWith('/vector_stores/vector-store-id/files')) {
				return Response.json({ id: 'vector-file-123' });
			}
			return new Response(null, { status: 404 });
		};
		openAiResponses = [
			{
				output_text: JSON.stringify({
					result: 'success',
					message: 'Paid 100k at store',
					bank_name: 'Bank',
					datetime: '2026-06-20 10:00',
				}),
			},
		];

		await expect(email({ raw: 'raw email' }, env)).resolves.toBe('📬 Email processed successfully');

		expect(parseEmailMock).toHaveBeenCalledTimes(1);
		expect(openAiResponsesCreate.mock.calls[0][0].input).toContain('Email sender: Bank');
		expect(openAiResponsesCreate.mock.calls[0][0].input).toContain('Paid 100k at store');
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(sendMessageMock).toHaveBeenCalledWith(
			env.TELEGRAM_CHAT_ID,
			expect.stringContaining('Paid 100k at store'),
			expect.objectContaining({ parse_mode: 'MarkdownV2' }),
		);
	});

	it('returns Not okay when the parsed email is not a transaction', async () => {
		parsedEmail = {
			date: '2026-06-20T10:00:00.000Z',
			from: { address: 'bank@example.com', name: 'Bank' },
			subject: 'Newsletter',
			text: 'No transaction here',
			html: '',
		};
		openAiResponses = [{ output_text: JSON.stringify({ result: 'failed' }) }];

		await expect(email({ raw: 'raw email' }, env)).resolves.toBe('Not okay');

		expect(fetchMock).not.toHaveBeenCalled();
		expect(sendMessageMock).not.toHaveBeenCalled();
	});
});

describe('sendTelegramMessage', () => {
	it('falls back to plain text when MarkdownV2 delivery fails', async () => {
		sendMessageMock
			.mockImplementationOnce(async () => {
				throw new Error('Markdown rejected');
			})
			.mockImplementationOnce(async () => undefined);
		openAiResponses = [{ output: [] }, { output_text: '*Tổng cộng:* 100 AUD (ước tính).' }];

		const response = await worker.fetch(
			new Request('https://worker.example/assistant', {
				method: 'POST',
				headers: { 'X-Telegram-Bot-Api-Secret-Token': env.TELEGRAM_BOT_SECRET_TOKEN },
				body: JSON.stringify({
					message: {
						from: { id: env.TELEGRAM_CHAT_ID },
						message_id: 88,
						text: 'Tong cong?',
					},
				}),
			}),
			env,
		);

		expect(await response.text()).toBe('Success');
		expect(sendMessageMock).toHaveBeenCalledTimes(2);
		expect(sendMessageMock.mock.calls[0][1]).toBe('*Tổng cộng:* 100 AUD \\(ước tính\\)\\.');
		expect(sendMessageMock.mock.calls[1][1]).toBe('Tổng cộng: 100 AUD ước tính');
	});
});
