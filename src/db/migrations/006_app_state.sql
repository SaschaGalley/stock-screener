-- Small facts the application keeps about itself, as opposed to settings the
-- user edits. The first is the fingerprint of the scoring code the stored score
-- series was computed with: when a deploy changes it, the server re-scores the
-- history on start instead of leaving the overview on the old code's numbers
-- while every detail page recomputes with the new.
CREATE TABLE IF NOT EXISTS app_state (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
