-- Every trade from umsatz, the owner's bookkeeping, so the journal can ask
-- what each purchase and sale was for.
--
-- These are real holdings: read them in aggregate only (counts, kinds,
-- date buckets), never as rows — see CLAUDE.md.
--
-- umsatz is the record; this is a copy, refreshed whole on every sync. A
-- trade that disappears there is marked, not deleted, because a journal
-- entry may still point at it.
CREATE TABLE IF NOT EXISTS trades (
  id            bigserial   PRIMARY KEY,
  source        text        NOT NULL DEFAULT 'umsatz',
  external_id   text        NOT NULL,
  day           date        NOT NULL,
  isin          text        NOT NULL,
  -- The ticker in this app, when a stored stock carries the ISIN; the
  -- source's own symbol otherwise.
  symbol        text,
  source_symbol text,
  name          text        NOT NULL,
  asset_type    text        NOT NULL,
  kind          text        NOT NULL,   -- buy | sell | savings-plan | spin-off
  quantity      double precision NOT NULL,
  price         double precision NOT NULL,
  currency      text        NOT NULL,
  fee           double precision NOT NULL DEFAULT 0,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  removed_at    timestamptz,
  -- Marked as needing no reason, by hand.
  dismissed_at  timestamptz,
  UNIQUE (source, external_id)
);
CREATE INDEX IF NOT EXISTS trades_day_idx ON trades (day DESC);

-- Which trades an entry gives the reason for: one reason may cover a purchase
-- made in three tranches.
ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS trade_ids bigint[] NOT NULL DEFAULT '{}';
