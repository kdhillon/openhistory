#!/usr/bin/env python3
"""
scripts/backfill-by-year.py
---------------------------
Run `pipeline.run_local` one year at a time, tracking completed years in a
local JSON state file so reruns skip already-processed years.

Usage:
    source .env
    python3 scripts/backfill-by-year.py --start 1912 --count 5

State file: scripts/year-backfill-state.json (committed; safe to share).
"""

import argparse
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT  = Path(__file__).parent.parent
STATE_FILE = Path(__file__).parent / "year-backfill-state.json"


def load_state() -> dict:
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text())
    return {"runs": {}}


def save_state(state: dict) -> None:
    STATE_FILE.write_text(json.dumps(state, indent=2, sort_keys=True))


def count_events_for_year(db_url: str, year: int) -> int:
    res = subprocess.run(
        ["psql", db_url, "-tA", "-c", f"SELECT COUNT(*) FROM events WHERE year_start = {year}"],
        capture_output=True, text=True, check=True,
    )
    return int(res.stdout.strip())


def run_pipeline_for_year(year: int) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, "-m", "pipeline.run_local",
         "--min-year", str(year), "--max-year", str(year)],
        cwd=REPO_ROOT, capture_output=True, text=True,
    )


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--start", type=int, required=True,
                   help="Year to start at (inclusive, processed first)")
    p.add_argument("--count", type=int, required=True,
                   help="Number of years to process from --start")
    p.add_argument("--ascending", action="store_true",
                   help="Iterate forward (start, start+1, ...). Default is backwards.")
    p.add_argument("--force", action="store_true",
                   help="Re-run years already marked 'ok' in state")
    args = p.parse_args()

    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        sys.exit("DATABASE_URL not set; run `source .env` first")

    state = load_state()

    direction = 1 if args.ascending else -1
    for i in range(args.count):
        year = args.start + direction * i
        key = str(year)
        prior = state["runs"].get(key, {})

        # Retry partial / failed / never-run years. Only fully-successful 'ok'
        # runs are skipped (use --force to redo even those).
        if prior.get("status") == "ok" and not args.force:
            print(f"[{year}] already completed ({prior.get('added', '?')} added previously); skipping")
            continue
        if prior.get("status") == "partial" and not args.force:
            print(f"[{year}] previous run was partial ({prior.get('throttled_categories', '?')} category errors, "
                  f"+{prior.get('added', '?')} added); retrying")

        print(f"\n[{year}] counting existing events...", flush=True)
        try:
            before = count_events_for_year(db_url, year)
        except subprocess.CalledProcessError as e:
            print(f"[{year}] COUNT FAILED: {e.stderr.strip()[:200]}", flush=True)
            state["runs"][key] = {
                "status": "failed", "phase": "count",
                "error": (e.stderr or "")[-300:].strip(),
                "ran_at": datetime.now(timezone.utc).isoformat(),
            }
            save_state(state)
            continue

        print(f"[{year}] {before} events already in DB; running pipeline...", flush=True)
        result = run_pipeline_for_year(year)

        if result.returncode != 0:
            tail = (result.stderr or result.stdout or "")[-500:].strip()
            print(f"[{year}] PIPELINE FAILED (exit {result.returncode}): {tail[:200]}", flush=True)
            state["runs"][key] = {
                "status": "failed", "phase": "pipeline",
                "before": before,
                "error": tail,
                "ran_at": datetime.now(timezone.utc).isoformat(),
            }
            save_state(state)
            continue

        try:
            after = count_events_for_year(db_url, year)
        except subprocess.CalledProcessError as e:
            print(f"[{year}] post-count failed: {e.stderr.strip()[:200]}", flush=True)
            after = before  # best effort

        added = after - before

        # Scan the pipeline's output for per-category throttle / WDQS errors.
        # The pipeline catches these exceptions and continues, so a year can
        # exit 0 with 25/33 categories silently missing. Log them so we can
        # tell genuine `ok` years from partial throttled runs.
        combined = (result.stdout or "") + "\n" + (result.stderr or "")
        throttle_re = re.compile(r"^(?:\s*ERROR:|.*Too Many Requests|.*429\b|.*rate.limit)", re.I | re.M)
        throttle_lines = [m.group(0).strip() for m in throttle_re.finditer(combined)]
        n_throttled = len(throttle_lines)

        run_entry = {
            "status": "partial" if n_throttled > 0 else "ok",
            "before": before,
            "after": after,
            "added": added,
            "ran_at": datetime.now(timezone.utc).isoformat(),
        }
        if n_throttled > 0:
            run_entry["throttled_categories"] = n_throttled
            run_entry["warnings"] = throttle_lines[:5]  # sample first 5

        marker = "partial" if n_throttled > 0 else "done"
        warn_suffix = f"  [{n_throttled} category errors]" if n_throttled > 0 else ""
        print(f"[{year}] {marker}: {before} → {after} (+{added}){warn_suffix}", flush=True)
        state["runs"][key] = run_entry
        save_state(state)

    print("\n=== Summary ===")
    print(f"{'Year':<6} {'Status':<9} {'Before':>7} {'After':>7} {'Added':>7}  Notes")
    for i in range(args.count):
        year = args.start + direction * i
        r = state["runs"].get(str(year), {})
        status = r.get("status", "—")
        if status == "ok":
            print(f"{year:<6} {status:<9} {r['before']:>7} {r['after']:>7} {r['added']:>7}")
        elif status == "partial":
            print(f"{year:<6} {status:<9} {r['before']:>7} {r['after']:>7} {r['added']:>7}  "
                  f"{r.get('throttled_categories', '?')} category errors — retry later")
        elif status == "failed":
            print(f"{year:<6} {status:<9} {r.get('before', '—'):>7} {'—':>7} {'—':>7}  "
                  f"({r.get('phase', '?')}: {(r.get('error') or '')[:60]}…)")
        else:
            print(f"{year:<6} not run")


if __name__ == "__main__":
    main()
