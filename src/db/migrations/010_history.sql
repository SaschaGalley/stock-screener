-- Keep the raw history the app already fetches.
--
-- Every refresh downloaded a year of daily prices, every analyst action Yahoo
-- has on file and the latest insider trades — and kept a handful of derived
-- numbers from them: technical indicators, twelve monthly returns, six insider
-- totals. What is not stored today cannot be evaluated later, and neither Yahoo
-- nor Finnhub hands out the history again: a delisted stock's prices vanish,
-- an analyst's old target is overwritten by the new one.

-- Daily prices, keyed by ticker rather than symbol id so benchmarks, sector
-- ETFs and currencies sit in the same table as the stocks. `close` is Yahoo's
-- split-adjusted close, the basis market caps are built on; `adj_close` is
-- also dividend-adjusted, what a holder earned. A later split rewrites both on
-- the next refresh, and `price_events` keeps the split that explains it.
CREATE TABLE IF NOT EXISTS price_bars (
  ticker     text             NOT NULL,
  day        date             NOT NULL,
  open       double precision,
  high       double precision,
  low        double precision,
  close      double precision NOT NULL,
  adj_close  double precision,
  volume     double precision,
  updated_at timestamptz      NOT NULL DEFAULT now(),
  PRIMARY KEY (ticker, day)
);

CREATE TABLE IF NOT EXISTS price_events (
  ticker text             NOT NULL,
  day    date             NOT NULL,
  kind   text             NOT NULL CHECK (kind IN ('split', 'dividend')),
  -- A split's ratio of new shares to old; a dividend's amount per share.
  value  double precision NOT NULL,
  PRIMARY KEY (ticker, day, kind)
);

-- Every rating action and price target change Yahoo lists, back to 2012 for the
-- large caps. Appended, never replaced: this is the record an analyst-accuracy
-- evaluation needs — a target, its date, and the price a year later.
CREATE TABLE IF NOT EXISTS analyst_actions (
  symbol_id           integer          NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  graded_at           timestamptz      NOT NULL,
  firm                text             NOT NULL,
  action              text,
  from_grade          text,
  to_grade            text,
  price_target_action text,
  price_target        double precision,
  prior_price_target  double precision,
  first_seen_at       timestamptz      NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol_id, graded_at, firm)
);

-- Individual insider trades. Yahoo shows roughly the last two years, so what
-- is not kept falls off the end. Keyed by a hash of the row: a filer can trade
-- twice on one day.
CREATE TABLE IF NOT EXISTS insider_transactions (
  symbol_id     integer          NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  row_hash      text             NOT NULL,
  traded_on     date,
  filer         text,
  relation      text,
  description   text,
  shares        double precision,
  value         double precision,
  ownership     text,
  first_seen_at timestamptz      NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol_id, row_hash)
);
CREATE INDEX IF NOT EXISTS insider_transactions_day_idx ON insider_transactions (symbol_id, traded_on DESC);
