-- The journal: what I thought, read, bought and sold, and why — in my words.
--
-- Not tied to one stock: "they could win the AI race" is about three of them,
-- and a note on rates is about none. `symbols` holds the tickers as written,
-- not ids, because a note may name a stock that is not on the list.
--
-- `day` is when it happened, not when it was typed: a purchase from last spring
-- is entered today with last spring's date, and its performance since is read
-- from that day's close.
CREATE TABLE IF NOT EXISTS journal_entries (
  id          bigserial   PRIMARY KEY,
  day         date        NOT NULL DEFAULT current_date,
  kind        text        NOT NULL DEFAULT 'note',   -- note | buy | sell
  symbols     text[]      NOT NULL DEFAULT '{}',
  body        text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);
CREATE INDEX IF NOT EXISTS journal_entries_day_idx ON journal_entries (day DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS journal_entries_symbols_idx ON journal_entries USING gin (symbols);

-- Every earlier wording of an entry. The journal is there to learn from, and
-- a reason rewritten after the fact is hindsight: what counts is what was
-- written at the time, so an edit keeps the version it replaces.
CREATE TABLE IF NOT EXISTS journal_revisions (
  id        bigserial   PRIMARY KEY,
  entry_id  bigint      NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  day       date        NOT NULL,
  kind      text        NOT NULL,
  symbols   text[]      NOT NULL,
  body      text        NOT NULL,
  -- When this wording was current until.
  saved_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS journal_revisions_entry_idx ON journal_revisions (entry_id, saved_at);
