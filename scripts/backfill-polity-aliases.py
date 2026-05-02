"""
Backfill `aliases` for existing polities by re-fetching their Wikidata
entities and pulling `aliases.en[]`.

Usage:
    source .env
    python3 scripts/backfill-polity-aliases.py [--limit N] [--dry-run]

Batches Wikidata API calls (50 IDs at a time, the wbgetentities limit) and
updates rows in chunks. Skips polities that already have aliases unless
--force is passed.
"""

import argparse
import json
import os
import sys
import time
import urllib.parse
import urllib.request

import psycopg2
import psycopg2.extras

DATABASE_URL = os.environ["DATABASE_URL"]
WD_API = "https://www.wikidata.org/w/api.php"
USER_AGENT = "OpenHistory/1.0 (https://openhistory.app)"
BATCH = 50


def fetch_aliases_for_qids(qids: list[str]) -> dict[str, list[str]]:
    """Return {qid: [alias1, alias2, ...]} for the given QIDs."""
    if not qids:
        return {}
    params = {
        "action": "wbgetentities",
        "ids": "|".join(qids),
        "props": "aliases",
        "languages": "en",
        "format": "json",
    }
    url = f"{WD_API}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=20) as r:
        data = json.loads(r.read())

    out: dict[str, list[str]] = {}
    for qid, entity in (data.get("entities") or {}).items():
        if entity.get("missing"):
            out[qid] = []
            continue
        aliases = entity.get("aliases", {}).get("en", []) or []
        out[qid] = [a.get("value") for a in aliases if isinstance(a, dict) and a.get("value")]
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--force", action="store_true",
                        help="Refetch even for polities that already have aliases")
    args = parser.parse_args()

    conn = psycopg2.connect(DATABASE_URL)
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        where = "wikidata_qid IS NOT NULL"
        if not args.force:
            where += " AND (aliases IS NULL OR cardinality(aliases) = 0)"
        sql = f"SELECT id, wikidata_qid, name FROM polities WHERE {where} ORDER BY name"
        if args.limit:
            sql += f" LIMIT {args.limit}"
        cur.execute(sql)
        rows = cur.fetchall()

        total = len(rows)
        print(f"Fetching aliases for {total} polities...")

        updated = 0
        for i in range(0, total, BATCH):
            batch = rows[i : i + BATCH]
            qids = [r["wikidata_qid"] for r in batch]
            try:
                aliases_map = fetch_aliases_for_qids(qids)
            except Exception as e:
                print(f"  [batch {i}-{i+BATCH}] fetch failed: {e}", file=sys.stderr)
                continue

            for r in batch:
                qid = r["wikidata_qid"]
                aliases = aliases_map.get(qid, [])
                if args.dry_run:
                    if aliases:
                        print(f"  {r['name']} ({qid}) → {aliases}")
                    continue
                cur.execute(
                    "UPDATE polities SET aliases = %s WHERE id = %s",
                    (aliases, r["id"]),
                )
                if aliases:
                    updated += 1

            if not args.dry_run:
                conn.commit()
            print(f"  Processed {min(i + BATCH, total)}/{total}", file=sys.stderr)
            time.sleep(0.1)  # gentle on Wikidata

        print(f"Done. {updated} polities now have aliases.")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
