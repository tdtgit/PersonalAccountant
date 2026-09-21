import { describe, expect, it } from 'bun:test';

const { currencyDecimals, fromMinorUnits, normalizeCurrency, toMinorUnits, toVndMinorUnits } = await import('../utils/money');
const { buildTransactionRow, findCrossSourceDuplicate, parseOccurredAt, saveTransaction } = await import('../services/transactions-store');
const { storeTransactionRecord } = await import('../handlers/transactions');

type Stub = { sql: RegExp; rows?: any[]; first?: any; changes?: number };

/** Minimal D1 stand-in: matches queued stubs against the SQL text. */
const makeDb = (stubs: Stub[]) => {
    const statements: { sql: string; args: unknown[] }[] = [];

    const db = {
        statements,
        prepare(sql: string) {
            return {
                bind: (...args: unknown[]) => {
                    statements.push({ sql, args });
                    const stub = stubs.find((candidate) => candidate.sql.test(sql));
                    return {
                        all: async () => ({ results: stub?.rows ?? [] }),
                        first: async () => stub?.first ?? null,
                        run: async () => ({ meta: { changes: stub?.changes ?? 1 } }),
                    };
                },
            };
        },
    };

    return db as any;
};

const details = {
    bank_name: 'VCB',
    datetime: '21/09/2026 14:30:00',
    amount: '120.000',
    currency: 'VNĐ',
    message: 'Ăn trưa 120.000 VNĐ',
    plain_data: 'Thanh toán ăn trưa tại quán gần văn phòng',
};

describe('money helpers', () => {
    it('treats VND as a zero-decimal currency', () => {
        expect(currencyDecimals('VND')).toBe(0);
        expect(currencyDecimals('VNĐ')).toBe(0);
        expect(currencyDecimals('USD')).toBe(2);
    });

    it('normalizes the Vietnamese currency spelling', () => {
        expect(normalizeCurrency('vnđ')).toBe('VND');
        expect(normalizeCurrency(' usd ')).toBe('USD');
        expect(normalizeCurrency(null)).toBe('');
    });

    it('converts human-formatted amounts into minor units', () => {
        expect(toMinorUnits('4.320.000', 'VND')).toBe(4320000);
        expect(toMinorUnits('8,99', 'USD')).toBe(899);
        expect(toMinorUnits('1,234.56', 'USD')).toBe(123456);
        expect(toMinorUnits('', 'USD')).toBeNull();
        expect(toMinorUnits('abc', 'USD')).toBeNull();
    });

    it('round-trips minor units and converts to đồng', () => {
        expect(fromMinorUnits(899, 'USD')).toBeCloseTo(8.99);
        expect(toVndMinorUnits(10000, 'USD', 25400)).toBe(2540000);
    });
});

describe('parseOccurredAt', () => {
    it('reads dd/MM/yyyy hh:mm:ss as Asia/Bangkok time', () => {
        expect(parseOccurredAt('21/09/2026 14:30:00')).toBe('2026-09-21T07:30:00.000Z');
    });

    it('accepts a date without a time', () => {
        expect(parseOccurredAt('01/02/2026')).toBe('2026-01-31T17:00:00.000Z');
    });

    it('falls back to now when the value is missing or unparseable', () => {
        const now = new Date('2026-09-21T00:00:00.000Z');
        expect(parseOccurredAt('', now)).toBe(now.toISOString());
        expect(parseOccurredAt('not a date', now)).toBe(now.toISOString());
    });
});

describe('buildTransactionRow', () => {
    it('maps extracted details onto a row', () => {
        const row = buildTransactionRow(details, 'email')!;
        expect(row.currency).toBe('VND');
        expect(row.amount_minor).toBe(120000);
        expect(row.amount_vnd_minor).toBe(120000);
        expect(row.direction).toBe('debit');
        expect(row.source_kind).toBe('bank');
        expect(row.bank_name).toBe('VCB');
        expect(row.duplicate_of).toBeNull();
    });

    it('keeps the merchant-side amount when the bank settled in another currency', () => {
        const row = buildTransactionRow({
            ...details,
            amount: '2.540.000',
            currency: 'VNĐ',
            original_amount: '100.00',
            original_currency: 'USD',
        }, 'email')!;

        expect(row.amount_minor).toBe(2540000);
        expect(row.original_amount_minor).toBe(10000);
        expect(row.original_currency).toBe('USD');
    });

    it('returns null when there is no usable amount', () => {
        expect(buildTransactionRow({ ...details, amount: undefined }, 'email')).toBeNull();
    });

    it('defaults an empty bank name to the empty string so dedup still applies', () => {
        const row = buildTransactionRow({ ...details, bank_name: undefined }, 'manual')!;
        expect(row.bank_name).toBe('');
    });
});

describe('findCrossSourceDuplicate', () => {
    const row = buildTransactionRow({ ...details, source_kind: 'merchant' }, 'email')!;

    it('links a merchant receipt to the matching bank debit', async () => {
        const db = makeDb([{ sql: /FROM transactions/, rows: [{ id: 'bank-row', currency: 'VND', amount_minor: 120000, original_currency: null, original_amount_minor: null }] }]);
        expect(await findCrossSourceDuplicate({ DB: db } as any, row, 15)).toEqual({ id: 'bank-row', needsReview: 0 });
    });

    it('flags a match made only on the pre-conversion amount', async () => {
        const converted = buildTransactionRow({
            ...details,
            amount: '2.540.000',
            currency: 'VNĐ',
            original_amount: '100.00',
            original_currency: 'USD',
            source_kind: 'merchant',
        }, 'email')!;
        const db = makeDb([{ sql: /FROM transactions/, rows: [{ id: 'bank-row', currency: 'USD', amount_minor: 10000, original_currency: null, original_amount_minor: null }] }]);

        expect(await findCrossSourceDuplicate({ DB: db } as any, converted, 15)).toEqual({ id: 'bank-row', needsReview: 1 });
    });

    it('returns null when no candidate amount matches', async () => {
        const db = makeDb([{ sql: /FROM transactions/, rows: [{ id: 'other', currency: 'VND', amount_minor: 999, original_currency: null, original_amount_minor: null }] }]);
        expect(await findCrossSourceDuplicate({ DB: db } as any, row, 15)).toBeNull();
    });

    it('only considers the opposite source kind and the same direction', async () => {
        const db = makeDb([{ sql: /FROM transactions/, rows: [] }]);
        await findCrossSourceDuplicate({ DB: db } as any, row, 15);

        const [query] = db.statements;
        expect(query.sql).toContain('source_kind !=');
        expect(query.sql).toContain('direction =');
        expect(query.args).toContain('debit');
        expect(query.args).toContain('merchant');
    });
});

describe('saveTransaction', () => {
    it('stores a transaction and reports the inserted row', async () => {
        const db = makeDb([{ sql: /SELECT id, currency/, rows: [] }, { sql: /INSERT INTO transactions/, changes: 1 }]);
        const saved = await saveTransaction({ DB: db } as any, details, 'email');

        expect(saved?.amount_minor).toBe(120000);
        expect(db.statements.some(({ sql }) => sql.includes('ON CONFLICT'))).toBe(true);
    });

    it('reports nothing when the unique constraint drops an exact repeat', async () => {
        const db = makeDb([{ sql: /SELECT id, currency/, rows: [] }, { sql: /INSERT INTO transactions/, changes: 0 }]);
        expect(await saveTransaction({ DB: db } as any, details, 'email')).toBeNull();
    });

    it('skips the write when the amount could not be extracted', async () => {
        const db = makeDb([]);
        expect(await saveTransaction({ DB: db } as any, { ...details, amount: undefined }, 'email')).toBeNull();
        expect(db.statements).toHaveLength(0);
    });
});

describe('storeTransactionRecord', () => {
    it('skips quietly when no D1 binding is configured', async () => {
        expect(await storeTransactionRecord(details, {} as any, 'email')).toBeNull();
    });

    it('swallows D1 failures so the existing flow is unaffected', async () => {
        const db = { prepare: () => { throw new Error('D1 unavailable'); } };
        expect(await storeTransactionRecord(details, { DB: db } as any, 'email')).toBeNull();
    });
});
