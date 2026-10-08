-- The market briefs the depot check asks Perplexity for: where markets stand,
-- which sectors lead, what moves them, what could go wrong. Every answer is
-- kept, the raw text beside the parsed one, so a parser fix can read it again
-- and last month's picture of the market can be set beside today's.
CREATE TABLE IF NOT EXISTS market_briefs (
  id          bigserial        PRIMARY KEY,
  fetched_at  timestamptz      NOT NULL DEFAULT now(),
  model       text             NOT NULL,
  prompt_hash text             NOT NULL,
  data        jsonb            NOT NULL,
  raw         text,
  cost_usd    double precision
);
CREATE INDEX IF NOT EXISTS market_briefs_time_idx ON market_briefs (fetched_at DESC);
