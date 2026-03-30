#!/usr/bin/env python3
"""
scripts/cleanup-creative-works.py

Removes events from the DB that are creative works (comics, comic strips,
fictional characters, etc.) rather than historical events.

These slipped in because their Wikidata P31 types weren't in the exclusion
list, so the LLM assigned them categories like "science".

Usage:
    source .env
    python3 scripts/cleanup-creative-works.py --dry-run   # preview
    python3 scripts/cleanup-creative-works.py             # delete
"""

import argparse
import os
import psycopg2
import psycopg2.extras

DATABASE_URL = os.environ["DATABASE_URL"]

# P31 QIDs that unambiguously identify creative works, not historical events.
# These are now also excluded in pipeline/extract.py to prevent future ingestion.
CREATIVE_WORK_P31: list[str] = [
    # Comics
    "Q1004",       # comics
    "Q14406742",   # comic book series
    "Q838795",     # comic strip
    "Q1760610",    # comics magazine
    "Q725377",     # comic book / graphic album
    "Q115378877",  # comics story arc
    "Q2831984",    # Tintin album
    "Q3297186",    # comics limited series
    "Q1114461",    # comics character / comics feature
    "Q867242",     # comics anthology (already in extract.py)
    "Q117467246",  # animated series (non-TV)
    # Fictional entities
    "Q95074",      # fictional human
    "Q15632617",   # fictional human (alt class)
    "Q2088357",    # fictional character
    "Q14897293",   # fictional entity
]


def main(dry_run: bool) -> None:
    conn = psycopg2.connect(DATABASE_URL)
    conn.autocommit = False
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    qid_array = "{" + ",".join(CREATIVE_WORK_P31) + "}"

    cur.execute(
        """
        SELECT id, wikidata_qid, title, p31_qids, categories, year_start
        FROM events
        WHERE p31_qids && %s::text[]
        ORDER BY title
        """,
        (qid_array,),
    )
    rows = cur.fetchall()

    print(f"Found {len(rows)} events to {'delete' if not dry_run else 'preview'}:\n")
    for row in rows:
        print(
            f"  [{row['year_start']}] {row['title']!r:50s} "
            f"p31={row['p31_qids']}  cats={row['categories']}"
        )

    if not rows:
        print("Nothing to do.")
        conn.close()
        return

    if dry_run:
        print(f"\n--dry-run: no changes made. Re-run without --dry-run to delete.")
        conn.close()
        return

    ids = [str(row["id"]) for row in rows]
    cur.execute("DELETE FROM events WHERE id = ANY(%s::uuid[])", (ids,))
    deleted = cur.rowcount
    conn.commit()
    print(f"\nDeleted {deleted} events.")
    conn.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    main(dry_run=args.dry_run)
