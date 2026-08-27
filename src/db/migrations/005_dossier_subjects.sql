-- The dossier ledger now tracks two kinds of subject, not one.
--
-- Distill keeps sectors as entities in their own right, with their own rolling
-- dossiers and their own switch, and a stock's context is its company dossier
-- plus the dossiers of the sectors it sits in. Those switches obey exactly the
-- same rules as a company's — follow the watchlist, idempotent, off deletes
-- nothing — so they belong in this ledger rather than in a parallel one.
--
-- `symbol` becomes `subject` because it is no longer always a symbol: a sector
-- row holds a handle (`information_technology`). Keeping the old name would
-- have made every sector row a small lie in a table whose whole job is to say
-- what is true upstream.
ALTER TABLE distill_dossiers RENAME COLUMN symbol TO subject;

ALTER TABLE distill_dossiers
  ADD COLUMN kind text NOT NULL DEFAULT 'company'
    CHECK (kind IN ('company', 'sector'));

-- A ticker and a sector handle could in principle collide as text, and the two
-- resolve to different entities, so the kind is part of the identity.
ALTER TABLE distill_dossiers DROP CONSTRAINT distill_dossiers_pkey;
ALTER TABLE distill_dossiers ADD PRIMARY KEY (base_url, kind, subject);
