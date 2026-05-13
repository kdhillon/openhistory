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
    sql = "SELECT wikidata_qid, parents FROM polities WHERE wikidata_qid IS NOT NULL ORDER BY wikidata_qid"
    if args.limit:
        sql += f" LIMIT {int(args.limit)}"
    cur.execute(sql)
    rows = cur.fetchall()
    print(f"Loaded {len(rows)} polities from DB.", file=sys.stderr)

    qids = [r["wikidata_qid"] for r in rows]
    eligible = set(qids)  # children must be in our registry
    existing = {r["wikidata_qid"]: (r["parents"] or []) for r in rows}

    print("Fetching from Wikidata...", file=sys.stderr)
    fetched = fetch_parents(qids, eligible_children=eligible)
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
