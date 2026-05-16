#!/usr/bin/env python3
"""Bulk-populate polities.parents from Wikidata.

Usage:
  source .env && python3 scripts/backfill-polity-parents.py [--limit N] [--dry-run]
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

# Ensure project root is on sys.path so `pipeline.polity_parents` resolves
# whether the script is launched from the project root or elsewhere.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import psycopg2
import psycopg2.extras

from pipeline.polity_parents import fetch_parents


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=None, help="Only process the first N polities (for testing).")
    parser.add_argument("--dry-run", action="store_true", help="Print diff counts without writing.")
    parser.add_argument("--only-empty", action="store_true",
                        help="Only process polities whose parents column is NULL or []. "
                             "Polities with any existing parent entry (manual OR Wikidata) are skipped.")
    args = parser.parse_args()

    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        print("ERROR: DATABASE_URL not set. Run `source .env` first.", file=sys.stderr)
        return 1

    conn = psycopg2.connect(dsn)
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    # Load the polity meta we need for filtering and year-range intersection.
    # We need the full registry for the parent filter even when --limit is used.
    cur.execute("""
        SELECT wikidata_qid, year_start, year_end, parents
        FROM polities
        WHERE wikidata_qid IS NOT NULL
        ORDER BY wikidata_qid
    """)
    all_rows = cur.fetchall()
    print(f"Loaded {len(all_rows)} polities from DB.", file=sys.stderr)

    polity_meta: dict[str, dict] = {
        r["wikidata_qid"]: {"year_start": r["year_start"], "year_end": r["year_end"]}
        for r in all_rows
    }
    existing = {r["wikidata_qid"]: (r["parents"] or []) for r in all_rows}

    # `qids` are the children we'll FETCH parents for. With --limit, only that subset
    # is queried; the parent filter still recognizes the full polity registry.
    candidate_rows = all_rows
    if args.only_empty:
        candidate_rows = [r for r in all_rows if not (r["parents"] or [])]
        print(f"--only-empty: filtered to {len(candidate_rows)} polities with no existing parents.",
              file=sys.stderr)
    qids = [r["wikidata_qid"] for r in (candidate_rows[: args.limit] if args.limit else candidate_rows)]
    print(f"Fetching parents for {len(qids)} children from Wikidata...", file=sys.stderr)
    fetched = fetch_parents(qids, polity_meta=polity_meta)
    print(f"Wikidata returned parent links for {len(fetched)} children.", file=sys.stderr)

    # Preserve manual entries across backfills. The InfoPanel "Part of" picker
    # appends `{source: 'manual'}` rows to polities.parents; those reflect a
    # user's curated correction and must not be clobbered by a Wikidata refresh.
    # We strip Wikidata-derived rows from `old`, replace them with the freshly
    # fetched set, then re-append any preserved manual rows on top.
    added = changed = removed = unchanged = 0
    updates: list[tuple[str, list[dict]]] = []
    preserved_manuals_total = 0
    for qid in qids:
        wd_parents = fetched.get(qid, [])
        old_parents = existing.get(qid, [])
        manual_parents = [p for p in old_parents if isinstance(p, dict) and p.get("source") == "manual"]
        old_wd_only = [p for p in old_parents if not (isinstance(p, dict) and p.get("source") == "manual")]
        new_parents = wd_parents + manual_parents
        preserved_manuals_total += len(manual_parents)
        if json.dumps(wd_parents, sort_keys=True) == json.dumps(old_wd_only, sort_keys=True):
            unchanged += 1
            continue
        if not old_wd_only and wd_parents:
            added += 1
        elif old_wd_only and not wd_parents:
            removed += 1
        else:
            changed += 1
        updates.append((qid, new_parents))

    print(
        f"Diff: +{added} added, ~{changed} changed, -{removed} removed, ={unchanged} unchanged "
        f"(total {len(qids)}); preserved {preserved_manuals_total} manual entries",
        file=sys.stderr,
    )

    if args.dry_run:
        print("--dry-run: no writes performed.", file=sys.stderr)
        return 0

    if not updates:
        print("Nothing to write.", file=sys.stderr)
        return 0

    print(f"Writing {len(updates)} updates...", file=sys.stderr)
    for qid, new_parents in updates:
        cur.execute(
            "UPDATE polities SET parents = %s WHERE wikidata_qid = %s",
            (json.dumps(new_parents), qid),
        )
    conn.commit()
    print("Done.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
