-- What the funds held: Yahoo's `topHoldings` for each fund in the depot — the
-- ten largest positions, the sector split, shares against bonds and cash — as
-- it came, once per distinct answer. A fund's holdings drift slowly and Yahoo
-- keeps no history of them; kept here, a look-through can be read as of any
-- week it was fetched.
CREATE TABLE IF NOT EXISTS fund_holdings (
  id           bigserial   PRIMARY KEY,
  symbol       text        NOT NULL,
  fetched_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  content_hash bytea       NOT NULL,
  data         jsonb       NOT NULL,
  UNIQUE (symbol, content_hash)
);
CREATE INDEX IF NOT EXISTS fund_holdings_symbol_idx ON fund_holdings (symbol, last_seen_at DESC);
