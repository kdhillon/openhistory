-- Migration 010: add sovereign_qids to polities
-- Stores Wikidata P17 (country/suzerain) QIDs for each polity.
-- Used to display "Part of: [Holy Roman Empire]" in the info panel.

ALTER TABLE polities
  ADD COLUMN IF NOT EXISTS sovereign_qids TEXT[] NOT NULL DEFAULT '{}';
