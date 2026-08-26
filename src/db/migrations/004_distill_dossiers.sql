-- What we have told Distill to keep building dossiers for.
--
-- Distill only builds a dossier while its entity switch is on, and each one
-- costs money per day, so the switch follows the watchlist instead of being set
-- by hand. This table is the ledger of that mirroring: desired state, last
-- confirmed state, and why a symbol is not in sync.
--
-- Keyed by the symbol as *text*, deliberately not by symbols(id) with a cascade
-- the way distill_entities is. Deleting a stock is precisely the moment the
-- switch has to be turned OFF upstream, and a cascading row would erase that
-- intent before the call had a chance to land. The row therefore outlives the
-- symbol and is retired only once Distill has confirmed `enabled: false`.
--
-- base_url is part of the key for the same reason it is in distill_entities:
-- entity ids are per-installation, so a switch set against one deployment says
-- nothing about another.
CREATE TABLE distill_dossiers (
  base_url     text        NOT NULL,
  symbol       text        NOT NULL,

  -- The entity the switch is set on. Nullable on purpose: a symbol the registry
  -- does not know yet still gets a row, so the next sync can see "we already
  -- looked, and when" instead of searching for it again on every config save.
  entity_id    text,

  -- What the watchlist says should be true upstream.
  desired      boolean     NOT NULL,
  -- What Distill last confirmed. NULL until a call has succeeded once, which is
  -- what distinguishes "never switched on" from "switched off".
  applied      boolean,

  --   synced     applied = desired, confirmed by Distill
  --   pending    a call is owed — either never made or the last one failed
  --   unresolved no entity id: the registry does not know this symbol (yet)
  --   ineligible 409, this entity type may not host a dossier — permanent
  --   forbidden  403, the key lacks `dossiers:write` — until it is re-issued
  state        text        NOT NULL
                 CHECK (state IN ('synced', 'pending', 'unresolved', 'ineligible', 'forbidden')),
  detail       text,

  attempts     integer     NOT NULL DEFAULT 0,
  attempted_at timestamptz,
  synced_at    timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (base_url, symbol)
);

-- The sync reads the whole ledger for one deployment; the partial index keeps
-- the "what is still owed?" question cheap as the ledger grows.
CREATE INDEX distill_dossiers_pending_idx
  ON distill_dossiers (base_url) WHERE state <> 'synced';
