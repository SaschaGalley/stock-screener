-- What the funds hold in full: the issuer's own list of every position (Amundi,
-- iShares, SPDR, Vanguard, Xtrackers; `src/data/fund-composition.ts`) as it
-- came, once per distinct answer.
-- Yahoo's `topHoldings` (`fund_holdings`) stops at the ten largest, which in a
-- broad fund leaves out nearly every stock a depot holds besides. Keyed by the
-- fund's ISIN, which every issuer files under; `issuer` 'none' records that
-- none of them knew the fund, so it is not asked again every time.
CREATE TABLE IF NOT EXISTS fund_compositions (
  id           bigserial   PRIMARY KEY,
  isin         text        NOT NULL,
  issuer       text        NOT NULL,
  fetched_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  content_hash bytea       NOT NULL,
  data         jsonb       NOT NULL,
  UNIQUE (isin, issuer, content_hash)
);
CREATE INDEX IF NOT EXISTS fund_compositions_isin_idx ON fund_compositions (isin, last_seen_at DESC);
