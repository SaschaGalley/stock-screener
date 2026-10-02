-- Every backtest run, kept.
--
-- `app_state` held the newest result under `backtest.result`, and each run
-- overwrote the last. The backtest now runs every month on its own, and how
-- its numbers move from month to month — a month-end added, a filing restated,
-- the universe grown — is worth as much as any one of them. The result as the
-- page reads it, whole; the columns are what a list of runs shows without
-- opening each.
CREATE TABLE IF NOT EXISTS backtest_runs (
  id           bigserial   PRIMARY KEY,
  generated_at timestamptz NOT NULL,
  trigger      text        NOT NULL DEFAULT 'cli',
  universe     text,
  months       integer,
  companies    integer,
  result       jsonb       NOT NULL
);
CREATE INDEX IF NOT EXISTS backtest_runs_generated_idx ON backtest_runs (generated_at DESC);

-- The one result there is so far, as the first run.
INSERT INTO backtest_runs (generated_at, trigger, universe, months, companies, result)
SELECT (value::jsonb ->> 'generatedAt')::timestamptz, 'cli',
       COALESCE(value::jsonb ->> 'universe', 'S&P 500'),
       (value::jsonb ->> 'months')::integer, (value::jsonb ->> 'companies')::integer, value::jsonb
  FROM app_state
 WHERE key = 'backtest.result'
   AND NOT EXISTS (SELECT 1 FROM backtest_runs);
