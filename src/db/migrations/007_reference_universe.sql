-- The reference universe.
--
-- A score is read against where the typical stock sits (calibration) and judged
-- by whether it ranked the stocks that went on to do better (evaluation). Both
-- need a population, and a watchlist of a few dozen stocks chosen by one person
-- is a sample of that person's taste, not of the market. Reference symbols are
-- refreshed on a rotation and scored on the numbers alone: they never appear in
-- the list, are never analysed and never reach Distill.
--
-- A flag on the symbol rather than a table of its own, because a reference
-- symbol the user then adds is the same stock with the same history. Adding it
-- clears the flag and keeps everything stored so far.
ALTER TABLE symbols ADD COLUMN IF NOT EXISTS reference boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS symbols_reference_idx ON symbols (reference) WHERE reference;

-- A reference refresh is a step of its own in the run log, so the night's
-- watchlist counts stay readable next to a hundred reference refreshes.
ALTER TABLE run_steps DROP CONSTRAINT IF EXISTS run_steps_step_check;
ALTER TABLE run_steps ADD CONSTRAINT run_steps_step_check
  CHECK (step IN ('data', 'distill', 'analysis', 'reference'));
