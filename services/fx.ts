import { toVndMinorUnits } from '../utils/money';
import type { Environment } from '../types';

export type FxRate = {
    currency: string;
    as_of: string;
    rate_to_vnd: number;
};

const RATE_SOURCES = [
    (currency: string) => `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/${currency}.min.json`,
    (currency: string) => `https://latest.currency-api.pages.dev/v1/currencies/${currency}.min.json`,
];

/**
 * Fetches the current VND rate for a currency. The upstream dataset is updated
 * once a day and carries its own `date`, which we keep as `as_of` so stored
 * rates stay auditable.
 */
export const fetchRate = async (currency: string): Promise<FxRate | null> => {
    const normalizedCurrency = currency.toLowerCase();

    for (const buildUrl of RATE_SOURCES) {
        try {
            const response = await fetch(buildUrl(normalizedCurrency));
            if (!response.ok) continue;

            const data = await response.json() as Record<string, unknown>;
            const rate = (data[normalizedCurrency] as Record<string, number> | undefined)?.vnd;
            if (!Number.isFinite(rate)) continue;

            return {
                currency: currency.toUpperCase(),
                as_of: typeof data.date === 'string' ? data.date : new Date().toISOString().slice(0, 10),
                rate_to_vnd: rate as number,
            };
        } catch (error) {
            console.warn(`⚠️ Failed to fetch ${currency.toUpperCase()} rate`, error);
        }
    }

    return null;
};

export const saveRate = async (env: Environment, rate: FxRate) => {
    await env.DB.prepare(
        `INSERT INTO fx_rates (currency, as_of, rate_to_vnd, fetched_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (currency, as_of) DO UPDATE SET rate_to_vnd = excluded.rate_to_vnd, fetched_at = excluded.fetched_at`,
    ).bind(rate.currency, rate.as_of, rate.rate_to_vnd, new Date().toISOString()).run();
};

/**
 * Returns the stored rate closest to (and not after) `onDate`, falling back to
 * the most recent rate we hold. Returns null when the currency is unknown.
 */
export const lookupRate = async (env: Environment, currency: string, onDate?: string): Promise<FxRate | null> => {
    const normalizedCurrency = currency.toUpperCase();
    const targetDate = onDate || new Date().toISOString().slice(0, 10);

    const onOrBefore = await env.DB.prepare(
        `SELECT currency, as_of, rate_to_vnd FROM fx_rates
         WHERE currency = ? AND as_of <= ?
         ORDER BY as_of DESC LIMIT 1`,
    ).bind(normalizedCurrency, targetDate).first<FxRate>();
    if (onOrBefore) return onOrBefore;

    return await env.DB.prepare(
        `SELECT currency, as_of, rate_to_vnd FROM fx_rates
         WHERE currency = ?
         ORDER BY as_of ASC LIMIT 1`,
    ).bind(normalizedCurrency).first<FxRate>();
};

/**
 * Resolves a rate from the local table, fetching and caching it only when we
 * have nothing stored. Never throws: a missing rate leaves the transaction
 * unconverted for the backfill job rather than failing ingest.
 */
export const resolveRate = async (env: Environment, currency: string, onDate?: string): Promise<FxRate | null> => {
    try {
        const stored = await lookupRate(env, currency, onDate);
        if (stored) return stored;

        const fetched = await fetchRate(currency);
        if (!fetched) return null;

        await saveRate(env, fetched);
        return fetched;
    } catch (error) {
        console.warn(`⚠️ Could not resolve ${currency} rate`, error);
        return null;
    }
};

/**
 * Refreshes stored rates for every foreign currency seen in the ledger, then
 * fills in transactions that were recorded while no rate was available. Each
 * row is converted with the rate for its own date, not today's.
 */
export const backfillExchangeRates = async (env: Environment) => {
    const { results: currencies } = await env.DB.prepare(
        `SELECT DISTINCT currency FROM transactions WHERE currency != 'VND'
         UNION
         SELECT DISTINCT original_currency FROM transactions WHERE original_currency IS NOT NULL AND original_currency != 'VND'`,
    ).all<{ currency: string }>();

    for (const row of currencies) {
        if (!row.currency) continue;
        const rate = await fetchRate(row.currency);
        if (rate) await saveRate(env, rate);
    }

    const { results: pending } = await env.DB.prepare(
        `SELECT id, occurred_at, amount_minor, currency FROM transactions
         WHERE amount_vnd_minor IS NULL AND currency != 'VND'`,
    ).all<{ id: string; occurred_at: string; amount_minor: number; currency: string }>();

    let converted = 0;
    for (const transaction of pending) {
        const rate = await lookupRate(env, transaction.currency, transaction.occurred_at.slice(0, 10));
        if (!rate) continue;

        await env.DB.prepare(
            `UPDATE transactions SET amount_vnd_minor = ?, fx_rate = ?, fx_rate_as_of = ? WHERE id = ?`,
        ).bind(
            toVndMinorUnits(transaction.amount_minor, transaction.currency, rate.rate_to_vnd),
            rate.rate_to_vnd,
            rate.as_of,
            transaction.id,
        ).run();
        converted += 1;
    }

    console.info(`💱 Refreshed ${currencies.length} rate(s), backfilled ${converted} transaction(s)`);
    return { currencies: currencies.length, converted };
};
