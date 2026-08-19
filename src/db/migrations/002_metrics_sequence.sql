-- Reclaim the metric id sequence.
--
-- `metrics.id` is a smallserial, so its sequence stops at 32767 — and the
-- catalogue sync upserted all 421 metrics on every boot. `ON CONFLICT DO
-- UPDATE` still calls nextval() for each row it considers, whether or not it
-- inserts one, so a restart burned 421 values regardless of anything changing.
-- Roughly seventy-seven restarts exhausted it, and the next boot failed with
-- "nextval: reached maximum value of sequence".
--
-- The sync no longer consumes ids for metrics that already exist (see
-- syncCatalog), so this only has to undo the damage: point the sequence back
-- at the highest id actually in use. The column stays smallint, which after
-- this leaves room for tens of thousands of genuinely new metric definitions —
-- a limit reached by adding fields to the schemas, not by restarting.
SELECT setval(
  'metrics_id_seq',
  GREATEST((SELECT COALESCE(MAX(id), 0) FROM metrics), 1),
  true
);
