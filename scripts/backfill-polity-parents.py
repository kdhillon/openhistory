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
    qids = [r["wikidata_qid"] for r in (all_rows[: args.limit] if args.limit else all_rows)]
    print(f"Fetching parents for {len(qids)} children from Wikidata...", file=sys.stderr)
    fetched = fetch_parents(qids, polity_meta=polity_meta)
    print(f"Wikidata returned parent links for {len(fetched)} children.", file=sys.stderr)

    added = changed = removed = unchanged = 0
    updates: list[tuple[str, list[dict]]] = []
    for qid in qids:
        new_parents = fetched.get(qid, [])
        old_parents = existing.get(qid, [])
        if json.dumps(new_parents, sort_keys=True) == json.dumps(old_parents, sort_keys=True):
            unchanged += 1
            continue
        if not old_parents and new_parents:
            added += 1
        elif old_parents and not new_parents:
            removed += 1
        else:
            changed += 1
        updates.append((qid, new_parents))

    print(
        f"Diff: +{added} added, ~{changed} changed, -{removed} removed, ={unchanged} unchanged "
        f"(total {len(qids)})",
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
