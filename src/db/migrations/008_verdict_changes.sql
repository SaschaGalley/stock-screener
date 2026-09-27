-- Verdict changes on the watchlist.
--
-- Every time a stock's published verdict moves from one band to another it is
-- recorded here, so the overview can say what changed overnight without anyone
-- comparing two days of the list by eye. The series already holds the verdict
-- at every instant; this is the list of moments it moved, which the series can
-- only answer by being read in full.
CREATE TABLE IF NOT EXISTS verdict_changes (
  id           bigserial   PRIMARY KEY,
  symbol_id    smallint    NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  at           timestamptz NOT NULL DEFAULT now(),
  from_verdict text        NOT NULL,
  to_verdict   text        NOT NULL,
  from_score   real,
  to_score     real,
  source       text        NOT NULL CHECK (source IN ('refresh', 'analysis'))
);
CREATE INDEX IF NOT EXISTS verdict_changes_at_idx ON verdict_changes (at DESC);

-- The verdict last announced per stock. A change is announced once it has held
-- through a later refresh, and only when it differs from what was announced
-- before: a score that sits on a band's edge and flips every night would
-- otherwise announce itself every night.
CREATE TABLE IF NOT EXISTS verdict_announced (
  symbol_id smallint    PRIMARY KEY REFERENCES symbols(id) ON DELETE CASCADE,
  verdict   text        NOT NULL,
  score     real,
  at        timestamptz NOT NULL DEFAULT now()
);
