#!/usr/bin/env python3
"""
scripts/backfill-event-categories.py

Reclassifies events with empty categories by walking the Wikidata P279
(subclass-of) hierarchy up to max_depth levels from each event's stored
p31_qids, until a known event-category root is reached.

This is more scalable than manually adding every P31 variant to
WIKIDATA_TO_CATEGORY because it automatically resolves any subclass chain,
e.g.  cricket season → sport season → sporting event → sport (Q349).

Usage:
    source .env
    python3 scripts/backfill-event-categories.py [--dry-run] [--max-depth N] [--all]

Options:
    --dry-run     Print what would change without writing to DB
    --max-depth N BFS depth limit (default: 2; keep low to avoid false positives via long chains)
    --all         Also reclassify events that already have a category
                  (useful after adding new category roots)
"""

import argparse
import os
import time

import psycopg2
import psycopg2.extras
import requests

# ── Category root QIDs ──────────────────────────────────────────────────────
# Maps a Wikidata QID (and all its subclasses) → our event category string.
# Priority order matters: first match wins when multiple roots hit.
# Add roots here when new categories are introduced.

CATEGORY_ROOTS: list[tuple[str, str]] = [
    # Higher-priority / more specific first
    ("Q178561",  "battle"),      # battle
    ("Q831663",  "battle"),      # naval battle
    ("Q180684",  "battle"),      # military conflict (broader)
    ("Q645883",  "war"),         # military operation
    ("Q198",     "war"),         # war
    ("Q40231",   "politics"),    # election
    ("Q131569",  "politics"),    # treaty
    ("Q45382",   "politics"),    # coup d'état
    ("Q49775",   "politics"),    # social movement
    ("Q10931",   "politics"),    # revolution
    ("Q1656682", "politics"),    # political event
    ("Q82821",   "religion"),    # council (religious)
    ("Q45469",   "religion"),    # canonization
    ("Q191760",  "religion"),    # beatification
    ("Q213363",  "religion"),    # pilgrimage
    ("Q625017",  "religion"),    # religious persecution
    ("Q3839081", "disaster"),    # natural disaster
    ("Q44512",   "disaster"),    # epidemic
    ("Q168247",  "disaster"),    # famine
    ("Q2401485", "exploration"), # expedition
    ("Q2678658", "science"),     # scientific discovery
    ("Q11862829","science"),     # scientific experiment
    ("Q752783",  "science"),     # spaceflight
    ("Q349",     "sport"),       # sport  ← root for everything sporting
    ("Q16510064","sport"),       # sporting event
    ("Q5389",    "sport"),       # Olympic Games
    ("Q27020041","sport"),       # sports season
    ("Q959583",  "culture"),     # cultural event
    ("Q464980",  "culture"),     # art exhibition
    ("Q188686",  "culture"),     # world's fair
    ("Q17633526","culture"),     # occurrence (founding-type events, broad fallback)
]

ROOT_QID_TO_CAT: dict[str, str] = {qid: cat for qid, cat in CATEGORY_ROOTS}
ROOT_QIDS: set[str] = set(ROOT_QID_TO_CAT)

# P31 QIDs too broad/ambiguous for BFS — two uses:
#   1. Events whose P31s are entirely within this set are skipped upfront.
#   2. During BFS, these nodes act as traversal barriers (we do not walk through them),
#      preventing long chains like "Japanese era → historical period → ... → religion".
SKIP_P31: set[str] = {
    "Q11514315",  # historical period
    "Q3024240",   # historical country
    "Q48349",     # empire (generic, not sovereign empire)
    "Q6256",      # country (modern sovereign state)
    "Q3624078",   # sovereign state
    "Q17544377",  # historical state
    "Q1292119",   # dynasty
    "Q11042",     # empire (alt)
    "Q50068795",  # sovereign state (alt)
    "Q1089515",   # state
    "Q185363",    # era
    "Q17524420",  # aspect of history
    "Q18340514",  # events in a specific year or time period
    "Q150958",    # Japanese imperial era (nengō)
    "Q685414",    # historical period of Japan
    "Q1647544",   # era (generic)
    "Q2554170",   # historical era
    "Q7432",      # species (prevents biology → taxonomy chains)
    "Q35120",     # entity (too broad)
    "Q58778",     # system
    "Q7239",      # organism
    "Q215380",    # musical group (avoid culture via association)
    "Q5",         # human (individual people)
    "Q16686022",  # historical event (too broad)
    "Q1190554",   # occurrence (too broad)
    "Q3241045",   # phase / stage (too broad)
    "Q18536594",  # sports competition (handled via direct roots)
    "Q43229",     # organization (too broad)
    "Q7188",      # government (too broad)
    "Q273120",    # protest — Wikidata incorrectly P279->Q180684 (military conflict)
    "Q11033",     # mass media (too broad)
    "Q1002697",   # periodical (too broad)
    "Q340169",    # communications media (too broad)
}

# Also import the hardcoded map from extract.py as a fast first-pass
from pipeline.extract import WIKIDATA_TO_CATEGORY  # type: ignore

WIKIDATA_API = "https://www.wikidata.org/w/api.php"
SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "OpenHistory-backfill/1.0 (https://openhistory.app)"})


def fetch_p279_batch(qids: list[str]) -> dict[str, list[str]]:
    """Return {qid: [parent_qids]} via P279 claims."""
    params = {
        "action": "wbgetentities",
        "ids": "|".join(qids),
        "props": "claims",
        "format": "json",
    }
    try:
        resp = SESSION.get(WIKIDATA_API, params=params, timeout=20)
        resp.raise_for_status()
        entities = resp.json().get("entities", {})
        result: dict[str, list[str]] = {}
        for qid, entity in entities.items():
            if entity.get("missing"):
                result[qid] = []
                continue
            parents = []
            for stmt in entity.get("claims", {}).get("P279", []):
                snak = stmt.get("mainsnak", {})
                if snak.get("snaktype") == "value":
                    val = snak["datavalue"]["value"]
                    if isinstance(val, dict) and val.get("id"):
                        parents.append(val["id"])
            result[qid] = parents
        return result
    except Exception as e:
        print(f"  [warn] fetch_p279_batch failed: {e}")
        return {q: [] for q in qids}


def classify_via_bfs(p31_qids: list[str], max_depth: int) -> str | None:
    """
    Walk P279 from each P31 QID up to max_depth levels.
    Returns the first category found, or None if unresolvable.
    Skips events whose P31s are all in the broad/ambiguous SKIP_P31 set.
    """
    if not p31_qids:
        return None

    # Skip if all P31s are broad/ambiguous — leave for LLM
    if all(q in SKIP_P31 for q in p31_qids):
        return None

    # Fast path: direct lookup in hardcoded map
    for q in p31_qids:
        if q in WIKIDATA_TO_CATEGORY:
            cat = WIKIDATA_TO_CATEGORY[q]
            if cat:
                return cat

        if q in ROOT_QID_TO_CAT:
            return ROOT_QID_TO_CAT[q]

    # BFS
    p279_cache: dict[str, list[str]] = {}
    frontier = list(set(p31_qids))

    for _depth in range(max_depth):
        need = [q for q in frontier if q not in p279_cache]
        if need:
            for i in range(0, len(need), 50):
                p279_cache.update(fetch_p279_batch(need[i:i+50]))
                if i + 50 < len(need):
                    time.sleep(0.3)

        next_frontier: list[str] = []
        for q in frontier:
            for parent in p279_cache.get(q, []):
                if parent in ROOT_QID_TO_CAT:
                    return ROOT_QID_TO_CAT[parent]
                if parent in WIKIDATA_TO_CATEGORY and WIKIDATA_TO_CATEGORY[parent]:
                    return WIKIDATA_TO_CATEGORY[parent]
                # Don't traverse through broad/ambiguous nodes — they produce false positives
                if parent in SKIP_P31:
                    continue
                next_frontier.append(parent)

        if not next_frontier:
            break
        frontier = list(set(next_frontier))

    return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--max-depth", type=int, default=2)
    parser.add_argument("--all", action="store_true",
                        help="Reclassify events that already have a category too")
    args = parser.parse_args()

    db_url = os.environ["DATABASE_URL"]
    conn = psycopg2.connect(db_url)
    conn.autocommit = False
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    where = "" if args.all else "WHERE (categories = '{}' OR categories IS NULL)"
    cur.execute(f"SELECT id, title, p31_qids, categories FROM events {where} ORDER BY year_start")
    events = cur.fetchall()
    print(f"Checking {len(events)} event(s) with max_depth={args.max_depth} …")

    # Collect all unique unknown P31 QIDs upfront for batch efficiency
    # (but we still do per-event BFS since chains diverge)
    updated = 0
    skipped = 0
    failed = 0

    for i, row in enumerate(events):
        p31 = row["p31_qids"] or []
        if not p31:
            skipped += 1
            continue

        cat = classify_via_bfs(p31, args.max_depth)
        if not cat:
            failed += 1
            continue

        current = (row["categories"] or [])
        if current == [cat]:
            skipped += 1
            continue

        updated += 1
        if args.dry_run:
            print(f"  [dry] {row['title'][:60]:<60} {current} → [{cat}]")
        else:
            cur.execute(
                "UPDATE events SET categories = %s, manually_edited_at = NOW() WHERE id = %s",
                ([cat], str(row["id"])),
            )

        if (i + 1) % 50 == 0:
            print(f"  … {i+1}/{len(events)} processed ({updated} updated so far)")
            time.sleep(0.5)  # brief pause to respect Wikidata rate limits

    if not args.dry_run:
        conn.commit()
    conn.close()

    print(f"\nDone. Updated: {updated} | Skipped (no p31 or already correct): {skipped} | Unresolvable: {failed}")
    if args.dry_run:
        print("(dry run — no changes written)")


if __name__ == "__main__":
    main()
