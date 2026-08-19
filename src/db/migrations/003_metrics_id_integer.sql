-- Widen the metric id from smallint to integer.
--
-- 002 stopped the catalogue sync from spending ids it did not need and put the
-- sequence back where it belonged, which was enough to boot again. This removes
-- the ceiling that made a mistake fatal in the first place: a smallserial caps
-- at 32767, and reaching it does not degrade anything gracefully — it refuses
-- to start the process.
--
-- Done now because it is cheap now. `observations` holds 28k rows and under
-- 3 MB, so the rewrite is seconds; it records 421 metrics per symbol per day,
-- so a year of one watchlist is several million rows and this same change
-- becomes an outage rather than a migration.
--
-- The three referencing columns move together: a foreign key across mismatched
-- integer widths still works but stops an index being used for the join, which
-- is not a trade worth making on the table that grows fastest.
ALTER TABLE observations        ALTER COLUMN metric_id TYPE integer;
ALTER TABLE fundamental_periods ALTER COLUMN metric_id TYPE integer;
ALTER TABLE macro_observations  ALTER COLUMN metric_id TYPE integer;
ALTER TABLE metrics             ALTER COLUMN id        TYPE integer;

-- The sequence keeps its own type and ceiling, which a column-type change does
-- not touch. Without this the column would be wide and the generator still not.
ALTER SEQUENCE metrics_id_seq AS integer MAXVALUE 2147483647;
