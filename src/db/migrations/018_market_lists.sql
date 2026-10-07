-- Yahoo's market lists as they were fetched: the day's gainers and losers,
-- the most traded, the trending tickers, the predefined screens. Yahoo keeps
-- no history of them — yesterday's gainers are gone once today's arrive — so
-- each answer is kept as it came, once per distinct content.
CREATE TABLE IF NOT EXISTS market_lists (
  id           bigserial   PRIMARY KEY,
  list         text        NOT NULL,
  fetched_at   timestamptz NOT NULL DEFAULT now(),
  content_hash bytea       NOT NULL,
  data         jsonb       NOT NULL,
  UNIQUE (list, content_hash)
);
CREATE INDEX IF NOT EXISTS market_lists_time_idx ON market_lists (list, fetched_at DESC);
