-- Market series at the date they describe.
--
-- `macro_observations` records what a refresh read, stamped with the moment it
-- read it — once per stock refreshed, so a night wrote the same ten-year yield
-- a hundred times, a few seconds apart, and never said which day the yield was
-- for. FRED publishes most series a day or more behind, the OECD's monthly
-- government yields a quarter behind. This keeps each series by the date it is
-- for, with its full history back to 1990 fetched once, so "what was the rate
-- on that day" is a lookup rather than a guess.
CREATE TABLE IF NOT EXISTS macro_series (
  series     text             NOT NULL,
  day        date             NOT NULL,
  value      double precision NOT NULL,
  fetched_at timestamptz      NOT NULL DEFAULT now(),
  PRIMARY KEY (series, day)
);
