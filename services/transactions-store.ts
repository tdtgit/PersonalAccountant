import { resolveRate } from './fx';
import { normalizeCurrency, toMinorUnits, toVndMinorUnits } from '../utils/money';
import type { Environment, TransactionDetails, TransactionRow } from '../types';

const DEFAULT_DUPLICATE_WINDOW_MINUTES = 15;

/**
 * Parses the extractor's `dd/MM/yyyy hh:mm:ss` datetime (local Asia/Bangkok
 * time) into a sortable ISO8601 UTC string. Falls back to now when the value is
 * missing or unparseable, so a bad date never blocks recording a transaction.
 */
export const parseOccurredAt = (value?: string | null, now: Date = new Date()) => {
    const raw = (value || '').trim();
    if (!raw) return now.toISOString();

    const local = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[\sT]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (local) {
        const [, day, month, year, hour = '0', minute = '0', second = '0'] = local;
        // Asia/Bangkok is UTC+7 year-round, so a fixed offset is exact here.
        const utc = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour) - 7, Number(minute), Number(second));
        if (Number.isFinite(utc)) return new Date(utc).toISOString();
    }

    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? now.toISOString() : parsed.toISOString();
};

const normalizeDirection = (value?: string | null) => (String(value || '').toLowerCase() === 'credit' ? 'credit' : 'debit');

const normalizeSourceKind = (value?: string | null) => (String(value || '').toLowerCase() === 'merchant' ? 'merchant' : 'bank');

/** Every (currency, minor amount) pair a transaction can be recognised by. */
const amountKeys = (row: Pick<TransactionRow, 'currency' | 'amount_minor' | 'original_currency' | 'original_amount_minor'>) => {
    const keys = new Set<string>([`${row.currency}:${row.amount_minor}`]);
    if (row.original_currency && row.original_amount_minor !== null && row.original_amount_minor !== undefined) {
        keys.add(`${row.original_currency}:${row.original_amount_minor}`);
    }
    return keys;
};

/** Maps extractor output onto a table row. Returns null when there is no usable amount. */
export const buildTransactionRow = (details: TransactionDetails, source: 'email' | 'manual' | 'ocr'): TransactionRow | null => {
    const currency = normalizeCurrency(details.currency) || 'VND';
    const amountMinor = toMinorUnits(details.amount, currency);
    if (amountMinor === null) return null;

    const originalCurrency = normalizeCurrency(details.original_currency);
    const originalAmountMinor = originalCurrency ? toMinorUnits(details.original_amount, originalCurrency) : null;

    return {
        id: crypto.randomUUID(),
        occurred_at: parseOccurredAt(details.datetime),
        amount_minor: amountMinor,
        currency,
        original_amount_minor: originalAmountMinor,
        original_currency: originalAmountMinor === null ? null : originalCurrency,
        amount_vnd_minor: currency === 'VND' ? amountMinor : null,
        fx_rate: null,
        fx_rate_as_of: null,
        bank_name: (details.bank_name || '').trim(),
        category: details.category?.trim() || null,
        direction: normalizeDirection(details.direction),
        source,
        source_kind: normalizeSourceKind(details.source_kind),
        message: details.message || '',
        plain_data: details.plain_data || details.message || '',
        duplicate_of: null,
        needs_review: 0,
        created_at: new Date().toISOString(),
    };
};

/**
 * Looks for an existing transaction that is the same real-world payment seen
 * from the other side — a merchant receipt and the matching bank debit, which
 * arrive minutes apart under different senders.
 *
 * A debit paired with a credit is a transfer between the user's own accounts,
 * not a duplicate, so direction must match.
 */
export const findCrossSourceDuplicate = async (env: Environment, row: TransactionRow, windowMinutes: number) => {
    const occurredAt = new Date(row.occurred_at).getTime();
    const from = new Date(occurredAt - windowMinutes * 60_000).toISOString();
    const to = new Date(occurredAt + windowMinutes * 60_000).toISOString();

    const { results } = await env.DB.prepare(
        `SELECT id, currency, amount_minor, original_currency, original_amount_minor
         FROM transactions
         WHERE occurred_at BETWEEN ? AND ?
           AND direction = ?
           AND source_kind != ?
           AND duplicate_of IS NULL
         ORDER BY occurred_at ASC`,
    ).bind(from, to, row.direction, row.source_kind).all<TransactionRow>();

    const incoming = amountKeys(row);
    const settledKey = `${row.currency}:${row.amount_minor}`;

    for (const candidate of results) {
        const candidateKeys = amountKeys(candidate);
        const overlap = [...incoming].filter((key) => candidateKeys.has(key));
        if (overlap.length === 0) continue;

        // Matching only on the pre-conversion amount is the weaker signal, so
        // flag it for review rather than silently folding the rows together.
        const matchedOnSettledAmount = overlap.includes(settledKey) && candidate.currency === row.currency;
        return { id: candidate.id, needsReview: matchedOnSettledAmount ? 0 : 1 };
    }

    return null;
};

/**
 * Writes a transaction to D1. Exact repeats (webhook or delivery retries) are
 * dropped by the UNIQUE constraint; the same payment arriving from a second
 * sender is kept but linked, so totals count it once without losing detail.
 */
export const saveTransaction = async (env: Environment, details: TransactionDetails, source: 'email' | 'manual' | 'ocr' = 'email') => {
    const row = buildTransactionRow(details, source);
    if (!row) {
        console.warn('🗄️ Skipping D1 write: no usable amount in extracted transaction');
        return null;
    }

    if (row.currency !== 'VND') {
        const rate = await resolveRate(env, row.currency, row.occurred_at.slice(0, 10));
        if (rate) {
            row.amount_vnd_minor = toVndMinorUnits(row.amount_minor, row.currency, rate.rate_to_vnd);
            row.fx_rate = rate.rate_to_vnd;
            row.fx_rate_as_of = rate.as_of;
        }
    }

    const windowMinutes = Number(env.TRANSACTION_DUPLICATE_WINDOW_MINUTES) || DEFAULT_DUPLICATE_WINDOW_MINUTES;
    const duplicate = await findCrossSourceDuplicate(env, row, windowMinutes);
    if (duplicate) {
        row.duplicate_of = duplicate.id;
        row.needs_review = duplicate.needsReview;
        console.info(`🗄️ Linked transaction to existing ${duplicate.id} (needs_review=${duplicate.needsReview})`);
    }

    const result = await env.DB.prepare(
        `INSERT INTO transactions (
            id, occurred_at, amount_minor, currency, original_amount_minor, original_currency,
            amount_vnd_minor, fx_rate, fx_rate_as_of, bank_name, category, direction,
            source, source_kind, message, plain_data, duplicate_of, needs_review, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (occurred_at, amount_minor, currency, bank_name) DO NOTHING`,
    ).bind(
        row.id, row.occurred_at, row.amount_minor, row.currency, row.original_amount_minor, row.original_currency,
        row.amount_vnd_minor, row.fx_rate, row.fx_rate_as_of, row.bank_name, row.category, row.direction,
        row.source, row.source_kind, row.message, row.plain_data, row.duplicate_of, row.needs_review, row.created_at,
    ).run();

    if (!result.meta?.changes) {
        console.info('🗄️ Transaction already recorded, skipping duplicate insert');
        return null;
    }

    console.info(`🗄️ Stored transaction ${row.id} in D1`);
    return row;
};
