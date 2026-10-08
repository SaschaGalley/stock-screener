-- Every depot check, kept: what it suggested on which day, so the page can
-- measure later what came of each step against the index. The rows carry the
-- depot's positions and weights — the same class of data as `trades`; see
-- CLAUDE.md before reading them.
CREATE TABLE IF NOT EXISTS depot_checks (
  id           bigserial   PRIMARY KEY,
  source       text        NOT NULL,
  generated_at timestamptz NOT NULL,
  data         jsonb       NOT NULL,
  UNIQUE (source, generated_at)
);
