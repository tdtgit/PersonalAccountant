import { beforeEach, describe, expect, it, mock } from 'bun:test';

let openAiResponses: unknown[] = [];
const openAiResponsesCreate = mock(async () => {
	const response = openAiResponses.shift();
	if (response instanceof Error) throw response;
	return response;
});

const sendMessageMock = mock(async () => undefined);

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

const { buildManualTransactionInput, handleAssistantRequest } = await import('../handlers/assistant');

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
	fetchHandler = async () => new Response(null, { status: 404 });
	fetchMock.mockClear();
	openAiResponsesCreate.mockClear();
	sendMessageMock.mockClear();
	globalThis.fetch = fetchMock as unknown as typeof fetch;
});

describe('buildManualTransactionInput', () => {
	it('wraps natural-language transaction requests without keyword stripping', () => {
		expect(buildManualTransactionInput('Add vào giao dịch ngày 21/06/2026. "Đóng tiền khám bệnh cho Coca: 540,000đ"')).toBe(
			[
				'Manual transaction request from Telegram user.',
				'Parse the user message as a transaction to record. Extract the date, amount, currency, and description from the message when present.',
				'User message: Add vào giao dịch ngày 21/06/2026. "Đóng tiền khám bệnh cho Coca: 540,000đ"',
			].join('\n'),
		);
	});
});

describe('assistant router manual transaction intent', () => {
	it('lets the router model decide that natural language text should add a transaction', async () => {
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
				output: [
					{
						type: 'function_call',
						name: 'assistantManualTransaction',
						arguments: JSON.stringify({
							transaction: 'Tui đã thêm giao dịch khám bệnh cho Coca vào ngày 21/06/2026 chưa? Nếu chưa hãy note vào, số tiền là 540k',
						}),
					},
				],
			},
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
						text: 'Tui đã thêm giao dịch khám bệnh cho Coca vào ngày 21/06/2026 chưa? Nếu chưa hãy note vào, số tiền là 540k',
					},
				},
			}),
		);

		expect(await response.text()).toBe('Success');
		expect(openAiResponsesCreate).toHaveBeenCalledTimes(2);
		expect(openAiResponsesCreate.mock.calls[0][0]).toMatchObject({
			model: 'router-model',
			input: [
				{
					role: 'user',
					content: 'Tui đã thêm giao dịch khám bệnh cho Coca vào ngày 21/06/2026 chưa? Nếu chưa hãy note vào, số tiền là 540k',
				},
			],
		});
		expect(openAiResponsesCreate.mock.calls[0][0].instructions).toContain('Do not rely on fixed keywords only');
		expect(openAiResponsesCreate.mock.calls[1][0]).toMatchObject({
			model: 'transaction-model',
			input: [
				'Process this email',
				'',
				'Manual transaction request from Telegram user.',
				'Parse the user message as a transaction to record. Extract the date, amount, currency, and description from the message when present.',
				'User message: Tui đã thêm giao dịch khám bệnh cho Coca vào ngày 21/06/2026 chưa? Nếu chưa hãy note vào, số tiền là 540k',
			].join('\n'),
			store: false,
		});
		expect(uploadedRequests.map((request) => request.url)).toEqual([
			'https://gateway.example/openai/files',
			'https://gateway.example/openai/vector_stores/vector-store-id/files',
		]);
	});
});
