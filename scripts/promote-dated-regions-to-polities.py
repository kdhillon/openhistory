#!/usr/bin/env python3
"""Promote orphan dated regions in `locations` into `polities`.

Background: when an event references a historical political entity (Lower Canada,
Congress Poland, Captaincy General of Venezuela, etc.), the event-import pipeline
inserts that entity into the `locations` table classified as `region`. The
`polities` pipeline, however, only fetches entities matching a curated list of
P31 classes — so these entities never get a polity row, and the InfoPanel /
parent-cascade can't recognize them as historical states.

This script finds orphan locations (no matching polity) that are typed as
`region` AND have both founded_year and dissolved_year set — a strong signal
that the entity is a historical political entity, not a permanent geographic
region. For each match, it inserts a polity row with:
  - polity_type inferred from the name (kingdom / empire / republic / etc.)
    via `classify_polity_type_from_name`; defaults to 'other'
  - year_start / year_end from the location row
  - p31_qids carried over verbatim
  - pipeline_run = 'promote-dated-regions'

Usage:
  source .env && python3 scripts/promote-dated-regions-to-polities.py [--dry-run] [--limit N]
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import uuid
from pathlib import Path

# Make `pipeline.*` importable when this script is launched from the repo root.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import psycopg2
import psycopg2.extras

from pipeline.extract import classify_polity_type_from_name


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=None, help="Only promote the first N orphans (for testing).")
    parser.add_argument("--dry-run", action="store_true", help="Print what would be promoted without writing.")
    args = parser.parse_args()

    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        print("ERROR: DATABASE_URL not set. Run `source .env` first.", file=sys.stderr)
        return 1

    conn = psycopg2.connect(dsn)
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    # Find orphan locations that are dated regions (founded AND dissolved set).
    # These are almost certainly historical political entities; we promote them.
    sql = """
        SELECT l.wikidata_qid, l.slug, l.name, l.wikipedia_title, l.wikipedia_summary, l.wikipedia_url,
               l.founded_year AS year_start, l.dissolved_year AS year_end, l.founded_is_fuzzy AS date_is_fuzzy,
               l.lng, l.lat, l.p31_qids
        FROM locations l
        LEFT JOIN polities p ON p.wikidata_qid = l.wikidata_qid
        WHERE p.wikidata_qid IS NULL
          AND l.location_type = 'region'
          AND l.founded_year IS NOT NULL
          AND l.dissolved_year IS NOT NULL
        ORDER BY l.founded_year
    """
    if args.limit:
        sql += f" LIMIT {int(args.limit)}"
    cur.execute(sql)
    orphans = cur.fetchall()
    print(f"Found {len(orphans)} orphan dated regions to promote.", file=sys.stderr)

    if args.dry_run:
        for row in orphans:
            ptype = classify_polity_type_from_name(row["name"]) or "other"
            print(f"  {row['wikidata_qid']:12s} {row['name']:50s}  {row['year_start']}–{row['year_end']}  -> polity_type={ptype}")
        print(f"\n--dry-run: no writes performed.", file=sys.stderr)
        return 0

    # Insert each as a polity. Use ON CONFLICT DO NOTHING — if someone else
    # imports the same QID concurrently we don't want to clobber their data.
    insert_sql = """
        INSERT INTO polities (
            id, wikidata_qid, slug, name, polity_type,
            wikipedia_title, wikipedia_summary, wikipedia_url,
            year_start, year_end, date_is_fuzzy,
            lng, lat, p31_qids,
            data_version, pipeline_run
        ) VALUES (
            %(id)s, %(wikidata_qid)s, %(slug)s, %(name)s, %(polity_type)s,
            %(wikipedia_title)s, %(wikipedia_summary)s, %(wikipedia_url)s,
            %(year_start)s, %(year_end)s, %(date_is_fuzzy)s,
            %(lng)s, %(lat)s, %(p31_qids)s,
            %(data_version)s, %(pipeline_run)s
        )
        ON CONFLICT (wikidata_qid) DO NOTHING
        RETURNING wikidata_qid, name, polity_type
    """

    inserted = 0
    skipped = 0
    for row in orphans:
        ptype = classify_polity_type_from_name(row["name"]) or "other"
        params = {
            "id": str(uuid.uuid4()),
            "wikidata_qid": row["wikidata_qid"],
            "slug": row["slug"],
            "name": row["name"],
            "polity_type": ptype,
            "wikipedia_title": row["wikipedia_title"],
            "wikipedia_summary": row["wikipedia_summary"],
            "wikipedia_url": row["wikipedia_url"],
            "year_start": row["year_start"],
            "year_end": row["year_end"],
            "date_is_fuzzy": row["date_is_fuzzy"] or False,
            "lng": row["lng"],
            "lat": row["lat"],
            "p31_qids": row["p31_qids"],
            "data_version": 2,
            "pipeline_run": "promote-dated-regions",
        }
        cur.execute(insert_sql, params)
        result = cur.fetchone()
        if result:
            inserted += 1
        else:
            skipped += 1

    conn.commit()
    print(f"Inserted {inserted}, skipped (already existed) {skipped}.", file=sys.stderr)
    print(f"\nNext steps: run `python3 scripts/backfill-polity-parents.py` then `python3 scripts/export_geojson.py`.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
