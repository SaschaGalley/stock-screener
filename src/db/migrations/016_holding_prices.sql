-- Each asset's price in euros as umsatz values it, one row per day it was
-- seen: what the depot view weighs positions with. The stocks the model
-- scores have prices of their own in `price_bars`, but the depot also holds
-- ETFs, crypto and metals, and its value should be the one the bookkeeping
-- shows. Kept, not replaced: a sync adds the day it reads.
--
-- Real holdings, as `trades` — see CLAUDE.md.
CREATE TABLE IF NOT EXISTS holding_prices (
  source     text             NOT NULL DEFAULT 'umsatz',
  isin       text             NOT NULL,
  day        date             NOT NULL,
  price_eur  double precision NOT NULL,
  fetched_at timestamptz      NOT NULL DEFAULT now(),
  PRIMARY KEY (source, isin, day)
);
