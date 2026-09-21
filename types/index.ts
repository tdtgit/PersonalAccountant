export type Environment = Env & {
    readonly TELEGRAM_CHAT_ID: string;
    readonly TELEGRAM_BOT_TOKEN: string;
    readonly TELEGRAM_BOT_SECRET_TOKEN: string;

    readonly AI_API_GATEWAY: string;

    readonly OPENAI_PROJECT_ID: string;
    readonly OPENAI_API_KEY: string;

    readonly OPENAI_ASSISTANT_VECTORSTORE_ID: string;

    /** Minutes either side of a transaction to look for the same payment from another sender. */
    readonly TRANSACTION_DUPLICATE_WINDOW_MINUTES?: string;

    readonly DB: D1Database;
};

/** Shape returned by the extraction prompt. */
export type TransactionDetails = {
    bank_name?: string;
    datetime?: string;
    amount?: string;
    currency?: string;
    original_amount?: string;
    original_currency?: string;
    category?: string;
    direction?: string;
    source_kind?: string;
    message?: string;
    plain_data?: string;
    result?: string;
    error?: string;
};

export type TransactionRow = {
    id: string;
    occurred_at: string;
    amount_minor: number;
    currency: string;
    original_amount_minor: number | null;
    original_currency: string | null;
    amount_vnd_minor: number | null;
    fx_rate: number | null;
    fx_rate_as_of: string | null;
    bank_name: string;
    category: string | null;
    direction: 'debit' | 'credit';
    source: 'email' | 'manual' | 'ocr';
    source_kind: 'bank' | 'merchant';
    message: string;
    plain_data: string;
    duplicate_of: string | null;
    needs_review: number;
    created_at: string;
};
