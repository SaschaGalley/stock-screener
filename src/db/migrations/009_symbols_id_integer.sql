-- Reclaim the symbol id sequence, and widen the symbol id to integer.
--
-- The same failure as `metrics.id` in 002 and 003, one table over. Every
-- write went through `upsertSymbol`, an `INSERT … ON CONFLICT DO UPDATE`, and
-- Postgres draws the default id before it finds the conflict — so every
-- snapshot, news document and re-scored instant spent a value of a smallint
-- sequence, whether or not a row was created. Once the reference universe
-- multiplied the nightly writes, and each deploy re-scored the whole history,
-- the sequence reached 32767 with about six hundred symbols in the table, and
-- every write for every symbol failed with "nextval: reached maximum value of
-- sequence".
--
-- `upsertSymbol` and `markReference` no longer spend ids on symbols that
-- exist, so the first statement only undoes the damage: the sequence goes back
-- to the highest id in use. The rest removes the ceiling that made a leak
-- fatal, as 003 did for metrics, while it is cheap: the largest table that
-- refers to a symbol, `observations`, is under a million rows.
SELECT setval(
  'symbols_id_seq',
  GREATEST((SELECT COALESCE(MAX(id), 0) FROM symbols), 1),
  true
);

-- Every referencing column moves with the key, so the joins keep their indexes.
ALTER TABLE observations        ALTER COLUMN symbol_id TYPE integer;
ALTER TABLE snapshots           ALTER COLUMN symbol_id TYPE integer;
ALTER TABLE fundamental_periods ALTER COLUMN symbol_id TYPE integer;
ALTER TABLE documents           ALTER COLUMN symbol_id TYPE integer;
ALTER TABLE filings             ALTER COLUMN symbol_id TYPE integer;
ALTER TABLE distill_entities    ALTER COLUMN symbol_id TYPE integer;
ALTER TABLE verdict_changes     ALTER COLUMN symbol_id TYPE integer;
ALTER TABLE verdict_announced   ALTER COLUMN symbol_id TYPE integer;
ALTER TABLE symbols             ALTER COLUMN id        TYPE integer;

-- The sequence keeps its own type and ceiling, which a column-type change does
-- not touch.
ALTER SEQUENCE symbols_id_seq AS integer MAXVALUE 2147483647;
