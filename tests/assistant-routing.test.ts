import { describe, expect, it } from 'bun:test';
import { buildManualTransactionInput } from '../handlers/assistant';

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
