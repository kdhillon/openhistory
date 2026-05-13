-- 022_polity_parents.sql
-- Adds a JSONB column for parent-polity linkage derived from Wikidata.
-- Shape: [{ "qid": "Qxxx", "yearStart": 1815, "yearEnd": 1866, "source": "P150" }, ...]
--
-- Populated by scripts/backfill-polity-parents.py via the pipeline/polity_parents
-- module, which queries Wikidata for P150/P361/P131/P127 + curated P31 reverse-class
-- signals. Idempotent.

ALTER TABLE polities ADD COLUMN IF NOT EXISTS parents JSONB;

CREATE INDEX IF NOT EXISTS polities_parents_gin ON polities USING GIN (parents);
