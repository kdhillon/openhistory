-- Migration 021: add aliases to polities
--
-- Wikidata items have an `aliases.en[]` field — alternate names such as
-- "Persia" for "Iran" (Q794), or "Qajar dynasty" for "Qajar Iran". Storing
-- them lets us:
--   - match OHM territory names (e.g. "Qajar Iran") to our polities even
--     when our `name` column holds a different Wikidata label
--   - improve substring search in mapping modals and global search
--
-- TEXT[] keeps the schema simple. Trigram/GIN indexing can be added later
-- if search latency becomes an issue.

ALTER TABLE polities
  ADD COLUMN IF NOT EXISTS aliases TEXT[] NOT NULL DEFAULT '{}';
