-- ─────────────────────────────────────────────────────────────────────────────
-- Initial schema.
--
-- One rule runs through the whole design: SNAPSHOTS ARE THE TRUTH, OBSERVATIONS
-- ARE A PROJECTION. The raw payload of every run lands in `snapshots` as JSONB;
-- the narrow `observations` rows are derived from it by walking the same zod
-- schema the app validates with. Because the projection is derived, it can be
-- dropped and rebuilt at any time — which is what makes a schema change cheap.
-- The file cache this replaced could only grow its history by bumping a version
-- number, and its reader discarded the entire series on a version mismatch.
-- Extending history must never cost history.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Dimensions ──────────────────────────────────────────────────────────────

CREATE TABLE symbols (
  id            smallserial PRIMARY KEY,
  symbol        text        NOT NULL UNIQUE,
  -- Current profile. Slow-moving identity, overwritten in place: nobody charts
  -- a company's headquarters. Sector/industry changes are worth a trail, so
  -- they are ALSO emitted as text observations.
  company_name  text,
  sector        text,
  industry      text,
  isin          text,
  wkn           text,
  website       text,
  currency      text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- The metric catalogue, generated from the `.describe()` strings already
-- attached to every field in src/types.ts. Seeded on boot; a new field in a zod
-- schema becomes a chartable metric without anyone editing a list by hand.
CREATE TABLE metrics (
  id          smallserial PRIMARY KEY,
  key         text NOT NULL UNIQUE,      -- 'metrics.composite.primary.median'
  domain      text NOT NULL,             -- financials | metrics | signals | peers | macro | verdict
  value_kind  text NOT NULL              -- number | boolean | enum
    CHECK (value_kind IN ('number', 'boolean', 'enum')),
  label       text,
  unit        text,                      -- currency | ratio | pct | score | count | date
  description text,
  cadence     text NOT NULL DEFAULT 'daily'
    CHECK (cadence IN ('daily', 'quarterly', 'annual'))
);
CREATE INDEX metrics_domain_idx ON metrics (domain);

-- ── Provenance ──────────────────────────────────────────────────────────────
-- Replaces job-runs.json. Every snapshot, observation and document points at
-- the run that produced it, so "which nightly pass produced this number?" is
-- answerable after the fact.

CREATE TABLE runs (
  id             bigserial PRIMARY KEY,
  trigger        text        NOT NULL CHECK (trigger IN ('cron', 'manual', 'api', 'cli', 'backfill')),
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  status         text        NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'ok', 'partial', 'failed', 'stopped')),
  current_symbol text,
  error          text
);
CREATE INDEX runs_started_idx ON runs (started_at DESC);

CREATE TABLE run_steps (
  id        bigserial PRIMARY KEY,
  run_id    bigint   NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq       integer  NOT NULL,
  symbol    text     NOT NULL,
  step      text     NOT NULL CHECK (step IN ('data', 'distill', 'analysis')),
  status    text     NOT NULL CHECK (status IN ('ok', 'skipped', 'failed')),
  detail    text,
  ms        integer  NOT NULL DEFAULT 0
);
CREATE INDEX run_steps_run_idx ON run_steps (run_id, seq);

-- ── Truth: the raw payload of every run ─────────────────────────────────────

CREATE TABLE snapshots (
  id           bigserial   PRIMARY KEY,
  symbol_id    smallint    NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  kind         text        NOT NULL,   -- financials | market_signals | metrics | sector_medians | news | technical_signals
  schema_ver   integer     NOT NULL,
  -- captured_at is when this exact content FIRST appeared; last_seen_at is when
  -- we last confirmed it. Freshness checks read last_seen_at (an unchanged
  -- payload is still current), history reads captured_at (it only moved when
  -- the numbers moved).
  captured_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  run_id       bigint      REFERENCES runs(id) ON DELETE SET NULL,
  content      jsonb       NOT NULL,
  content_hash bytea       NOT NULL,
  UNIQUE (symbol_id, kind, schema_ver, content_hash)
);
CREATE INDEX snapshots_latest_idx ON snapshots (symbol_id, kind, last_seen_at DESC);
CREATE INDEX snapshots_history_idx ON snapshots (symbol_id, kind, captured_at DESC);

-- ── Projection: the chart surface ───────────────────────────────────────────
-- Rebuildable from snapshots at any time. Written only by explicit refresh and
-- analysis runs, never by a read path — browsing the UI must not write history.

CREATE TABLE observations (
  symbol_id   smallint    NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  metric_id   smallint    NOT NULL REFERENCES metrics(id) ON DELETE CASCADE,
  observed_at timestamptz NOT NULL,
  value       double precision,
  value_text  text,        -- enums: 'safe', 'STRONG BUY', 'likely manipulator'
  run_id      bigint      REFERENCES runs(id) ON DELETE SET NULL,
  PRIMARY KEY (symbol_id, metric_id, observed_at)
);
-- BRIN is the right index for an append-mostly table with a naturally ordered
-- timestamp: a few dozen KB where a btree would be hundreds of MB.
CREATE INDEX observations_time_brin ON observations USING brin (observed_at);

-- ── Text output, deduplicated by content ────────────────────────────────────
-- The tables that answer "what did the model say back then, and what changed?".

CREATE TABLE documents (
  id           bigserial   PRIMARY KEY,
  symbol_id    smallint    REFERENCES symbols(id) ON DELETE CASCADE,
  kind         text        NOT NULL,   -- distill | perplexity | verdict | search_trace | news
  -- Distinguishes several living documents of one kind for one symbol: the
  -- analysis flag hash for a verdict, the model name for Perplexity.
  variant      text        NOT NULL DEFAULT '',
  -- Which schema produced this. Verdicts from older versions are still real
  -- history and are kept, but the app only *offers* current-version ones —
  -- v3 stored bullCase as prose where v4 onwards stores bullet points.
  schema_ver   integer     NOT NULL DEFAULT 0,
  produced_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  run_id       bigint      REFERENCES runs(id) ON DELETE SET NULL,
  model        text,
  -- content is always the readable text — that is what an LLM diffs across
  -- time. data keeps the structured original (LLMAnalysis, citations, traces).
  content      text        NOT NULL,
  data         jsonb,
  content_hash bytea       NOT NULL,
  cost_usd     numeric(12, 6),
  UNIQUE (symbol_id, kind, variant, content_hash)
);
CREATE INDEX documents_latest_idx ON documents (symbol_id, kind, variant, produced_at DESC);
CREATE INDEX documents_kind_time_idx ON documents (kind, produced_at DESC);

-- ── Fiscal axis ─────────────────────────────────────────────────────────────
-- Reported figures are indexed by the PERIOD they describe, not by the day we
-- read them. Keeping both means a restatement is visible as two rows for one
-- period rather than a silently changed number.

CREATE TABLE fundamental_periods (
  symbol_id   smallint    NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  period_type text        NOT NULL CHECK (period_type IN ('annual', 'quarter', 'estimate')),
  period_end  date        NOT NULL,
  metric_id   smallint    NOT NULL REFERENCES metrics(id) ON DELETE CASCADE,
  value       double precision,
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol_id, period_type, period_end, metric_id, observed_at)
);
CREATE INDEX fundamental_periods_lookup_idx
  ON fundamental_periods (symbol_id, period_type, period_end);

-- ── Global series ───────────────────────────────────────────────────────────
-- VIX, yield curve, HY spread, DXY, SPY return, FRED rates. These are not
-- per-symbol facts; the file cache stored them once per symbol, which meant 35
-- copies of the same number every night.

CREATE TABLE macro_observations (
  metric_id   smallint    NOT NULL REFERENCES metrics(id) ON DELETE CASCADE,
  observed_at timestamptz NOT NULL,
  value       double precision,
  value_text  text,
  run_id      bigint      REFERENCES runs(id) ON DELETE SET NULL,
  PRIMARY KEY (metric_id, observed_at)
);
CREATE INDEX macro_observations_time_brin ON macro_observations USING brin (observed_at);

-- ── Mappings and indexes that are not time series ───────────────────────────

-- Symbol → Distill entity UUID. A mapping, not a measurement: it is corrected
-- when the registry merges or renames an entity, never appended to.
CREATE TABLE distill_entities (
  symbol_id     smallint    NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  base_url      text        NOT NULL,   -- entity ids are per-installation
  entity_id     text        NOT NULL,
  ref           text,
  entity_type   text,
  display_name  text,
  -- Which identifier tier matched, and the value that did — the first thing to
  -- look at when a briefing turns out to belong to the wrong company.
  matched_on    text,
  matched_value text,
  query         text,
  resolved_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol_id, base_url)
);

-- EDGAR filings stay on disk — they are immutable documents and the bulk of the
-- old cache by two orders of magnitude. Only the index lives here.
CREATE TABLE filings (
  symbol_id        smallint    NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  accession_number text        NOT NULL,
  cik              text,
  entity_name      text,
  form             text        NOT NULL,
  filing_date      date        NOT NULL,
  primary_document text,
  description      text,
  local_file       text,       -- filename under $DATA_DIR/<SYMBOL>/submissions/
  fetched_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol_id, accession_number)
);
CREATE INDEX filings_symbol_date_idx ON filings (symbol_id, filing_date DESC);

-- Operational settings the admin page edits (was app-config.json). Single row;
-- the CHECK keeps it that way.
CREATE TABLE settings (
  id         boolean     PRIMARY KEY DEFAULT true CHECK (id),
  config     jsonb       NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
