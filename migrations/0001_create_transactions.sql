-- Structured transaction store.
-- Written in parallel with the existing vector store upload; queries still run
-- against the vector store until the read path is switched over.

CREATE TABLE IF NOT EXISTS transactions (
    id                    TEXT PRIMARY KEY,
    occurred_at           TEXT NOT NULL,              -- ISO8601 UTC, sortable
    amount_minor          INTEGER NOT NULL,           -- amount that hit the account, in minor units
    currency              TEXT NOT NULL,
    original_amount_minor INTEGER,                    -- merchant-side amount when the bank converted it
    original_currency     TEXT,
    amount_vnd_minor      INTEGER,                    -- frozen at ingest, NULL until the rate is known
    fx_rate               REAL,
    fx_rate_as_of         TEXT,
    bank_name             TEXT NOT NULL DEFAULT '',   -- '' not NULL: NULLs defeat the UNIQUE constraint
    category              TEXT,
    direction             TEXT NOT NULL DEFAULT 'debit' CHECK (direction IN ('debit', 'credit')),
    source                TEXT NOT NULL CHECK (source IN ('email', 'manual', 'ocr')),
    source_kind           TEXT NOT NULL DEFAULT 'bank' CHECK (source_kind IN ('bank', 'merchant')),
    message               TEXT NOT NULL,
    plain_data            TEXT NOT NULL,
    duplicate_of          TEXT REFERENCES transactions (id),  -- NULL = counts toward totals
    needs_review          INTEGER NOT NULL DEFAULT 0,
    created_at            TEXT NOT NULL,
    UNIQUE (occurred_at, amount_minor, currency, bank_name)
);

CREATE INDEX IF NOT EXISTS idx_transactions_occurred_at ON transactions (occurred_at);
CREATE INDEX IF NOT EXISTS idx_transactions_category ON transactions (category, occurred_at);
CREATE INDEX IF NOT EXISTS idx_transactions_duplicate_of ON transactions (duplicate_of);
CREATE INDEX IF NOT EXISTS idx_transactions_pending_fx ON transactions (currency, amount_vnd_minor);

-- Full-text index over the free-text columns. External content table: rows live
-- in `transactions`, this holds only the index.
CREATE VIRTUAL TABLE IF NOT EXISTS transactions_fts USING fts5 (
    message,
    plain_data,
    content='transactions',
    content_rowid='rowid',
    tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS transactions_fts_insert AFTER INSERT ON transactions BEGIN
    INSERT INTO transactions_fts (rowid, message, plain_data)
    VALUES (new.rowid, new.message, new.plain_data);
END;

CREATE TRIGGER IF NOT EXISTS transactions_fts_delete AFTER DELETE ON transactions BEGIN
    INSERT INTO transactions_fts (transactions_fts, rowid, message, plain_data)
    VALUES ('delete', old.rowid, old.message, old.plain_data);
END;

CREATE TRIGGER IF NOT EXISTS transactions_fts_update AFTER UPDATE ON transactions BEGIN
    INSERT INTO transactions_fts (transactions_fts, rowid, message, plain_data)
    VALUES ('delete', old.rowid, old.message, old.plain_data);
    INSERT INTO transactions_fts (rowid, message, plain_data)
    VALUES (new.rowid, new.message, new.plain_data);
END;

-- Daily exchange rates, keyed by the source's own date so historical rates stay
-- auditable and backfill can use the rate for a transaction's own day.
CREATE TABLE IF NOT EXISTS fx_rates (
    currency    TEXT NOT NULL,
    as_of       TEXT NOT NULL,
    rate_to_vnd REAL NOT NULL,
    fetched_at  TEXT NOT NULL,
    PRIMARY KEY (currency, as_of)
);
