-- Research run by hand in a chat app and pasted back: the preview of a
-- report, the check of my own theses, a question across several stocks.
-- (The company brief keeps its place among the Perplexity documents, where
-- every analysis reads it.)
--
-- The prompt is kept beside the answer: what was asked is half of what an
-- answer means, and the questions will change.
CREATE TABLE IF NOT EXISTS research_reports (
  id          bigserial   PRIMARY KEY,
  kind        text        NOT NULL,   -- earnings | thesis | theme
  symbols     text[]      NOT NULL DEFAULT '{}',
  question    text,
  tool        text        NOT NULL,
  prompt      text        NOT NULL,
  raw         text        NOT NULL,
  -- The parsed answer; null when the tool wrote prose instead of JSON.
  data        jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);
CREATE INDEX IF NOT EXISTS research_reports_symbols_idx ON research_reports USING gin (symbols);
CREATE INDEX IF NOT EXISTS research_reports_created_idx ON research_reports (created_at DESC) WHERE deleted_at IS NULL;
