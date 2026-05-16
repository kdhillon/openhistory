#!/usr/bin/env python3
"""
DRY-RUN suggestions for tightening year-only Wikidata battle dates.

For one year at a time:
  1. Pull every event in our DB where category='battle', year_start=Y, and
     month_start IS NULL (i.e. we only know the year).
  2. Fetch each battle's current Wikidata P585 (point in time) statement.
     Skip if it's already at month- or day-precision — someone else may have
     improved it since our last pipeline run.
  3. Send the Wikipedia summary to Claude and ask for the most precise date
     it can extract, along with a verbatim quote supporting the answer.
  4. Write suggestions + a skipped list to a JSON file for human review.

NO Wikidata writes happen. Output is a review artifact only.

Usage:
    source .env                            # DATABASE_URL + ANTHROPIC_API_KEY
    python3 scripts/suggest-battle-dates.py --year 1815
    python3 scripts/suggest-battle-dates.py --year 1815 --limit 20
    python3 scripts/suggest-battle-dates.py --year 1815 --out review-1815.json
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path

import psycopg2
import psycopg2.extras
import requests
from anthropic import Anthropic

WIKIDATA_API = "https://www.wikidata.org/w/api.php"
USER_AGENT = "OpenHistoryDateSuggester/0.1 (https://openhistory.app)"

# Wikidata time-precision codes — https://www.wikidata.org/wiki/Help:Dates
PRECISION_DAY = 11
PRECISION_MONTH = 10
PRECISION_YEAR = 9

MODEL = "claude-haiku-4-5-20251001"  # cheap + plenty smart enough for date extraction


def fetch_intro_extract(wikipedia_url: str) -> str | None:
    """Fetch the plain-text Wikipedia intro section, preserving parentheticals.

    The REST /page/summary endpoint (which our pipeline stores) strips
    parentheticals like "(4 April – 15 June 1800)" — exactly the date ranges
    we need. The MediaWiki `prop=extracts&exintro=1` endpoint preserves them.
    """
    from urllib.parse import unquote
    title = unquote(wikipedia_url.rsplit("/", 1)[-1])
    if not title:
        return None
    r = requests.get(
        "https://en.wikipedia.org/w/api.php",
        params={
            "action": "query",
            "format": "json",
            "prop": "extracts",
            "exintro": 1,
            "explaintext": 1,
            "redirects": 1,
            "titles": title,
        },
        headers={"User-Agent": USER_AGENT},
        timeout=20,
    )
    r.raise_for_status()
    pages = r.json().get("query", {}).get("pages", {})
    if not pages:
        return None
    page = next(iter(pages.values()))
    return page.get("extract") or None


def fetch_existing_date_precision(qid: str) -> dict:
    """Return the best date-precision Wikidata already has across P585/P580/P582.

    Returns: {"max_precision": int | None, "claims": {"P585": prec, "P580": prec, "P582": prec}}
      max_precision = the most precise existing claim (higher = more precise).
      Used to skip events that already have month/day precision anywhere.
    """
    r = requests.get(
        WIKIDATA_API,
        params={"action": "wbgetentities", "ids": qid, "props": "claims", "format": "json"},
        headers={"User-Agent": USER_AGENT},
        timeout=20,
    )
    r.raise_for_status()
    claims = (r.json().get("entities", {}).get(qid, {}).get("claims", {}))
    result: dict = {"P585": None, "P580": None, "P582": None}
    for prop in ("P585", "P580", "P582"):
        statements = claims.get(prop)
        if not statements:
            continue
        # Take the highest-precision value across multiple statements (rare)
        best = None
        for st in statements:
            v = st.get("mainsnak", {}).get("datavalue", {}).get("value", {})
            p = v.get("precision")
            if p is not None and (best is None or p > best):
                best = p
        result[prop] = best
    precisions = [p for p in result.values() if p is not None]
    return {
        "max_precision": max(precisions) if precisions else None,
        "claims": result,
    }


def suggest_date(client: Anthropic, title: str, summary: str, year: int) -> dict:
    """Ask Claude to extract dates from the summary ONLY if they are explicitly stated.

    Output keys:
      kind:      "point" (single-day → P585), "range" (multi-day → P580/P582), or "none"
      start, end: "YYYY-MM-DD" / "YYYY-MM" / null. For "point", start == end.
      start_precision, end_precision: "day" | "month" | "year"
      source:    verbatim phrase from the summary that names the dates
    """
    prompt = f"""You are extracting dates from a Wikipedia summary for a Wikidata cleanup. The "{title}" event is currently dated only to the year {year}.

Summary:
{summary[:3500]}

Your job: ONLY return a date if the summary **literally names** the month or day. DO NOT guess, infer, or extrapolate.

ACCEPT (literal):
- "fought on 22 May 1812" → point, 1812-05-22 (day)
- "in June 1818" → point, 1818-06 (month)
- "from 25 October to 8 November 1806" → range, 1806-10-25 to 1806-11-08 (day)
- "in October and November 1808" → range, 1808-10 to 1808-11 (month)
- "between May and October 1811" → range, 1811-05 to 1811-10 (month)

REJECT (inferred or vague) — return kind="none":
- "in late 1811" — no month named → REJECT
- "in early 1820" — no month named → REJECT
- "during the spring and summer of 1806" — seasons aren't months → REJECT
- "a ten-day bombardment ending January 17" — start date inferred → REJECT
- "occurred on 20 and 29 June 1812" — two discrete dates, not a range → REJECT
- "on 2 August … on the next day, Stuart sent a cutting-out party" — follow-up action might not be part of the event → REJECT

Acceptable hedging — month qualifiers stay at month precision:
- "in early June 1814" → point, 1814-06 (month) — the "early" is a hint, the month is stated
- "in mid-March 1809" → point, 1809-03 (month) — same

Wikidata properties:
- A single-day or single-month event → P585 (point in time), kind="point", start = end.
- A multi-day or multi-month span → P580 (start) + P582 (end), kind="range".

Respond with strict JSON only, no commentary:
{{
  "kind": "point" | "range" | "none",
  "start": "YYYY-MM-DD" or "YYYY-MM" or null,
  "end":   "YYYY-MM-DD" or "YYYY-MM" or null,
  "start_precision": "day" | "month" | "year",
  "end_precision":   "day" | "month" | "year",
  "source": "<exact phrase from the summary that names the dates>" or null
}}

If unsure, return kind="none". A skipped event is better than a wrong one."""

    msg = client.messages.create(
        model=MODEL,
        max_tokens=500,
        messages=[{"role": "user", "content": prompt}],
    )
    text = msg.content[0].text.strip()
    # Strip ``` fences if Claude wraps the JSON
    if text.startswith("```"):
        text = text.split("\n", 1)[1].rsplit("```", 1)[0].strip()
        if text.lower().startswith("json"):
            text = text[4:].lstrip()
    # Extract just the first balanced {...} block — tolerates trailing prose
    start_idx = text.find("{")
    if start_idx == -1:
        raise ValueError(f"no JSON object in model response: {text[:200]}")
    depth = 0
    end_idx = -1
    in_string = False
    escape = False
    for i in range(start_idx, len(text)):
        ch = text[i]
        if in_string:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
        else:
            if ch == '"':
                in_string = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    end_idx = i
                    break
    if end_idx == -1:
        raise ValueError(f"unbalanced JSON in model response: {text[:200]}")
    return json.loads(text[start_idx : end_idx + 1])


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--year", type=int, required=True, help="Year to process (single year per run)")
    ap.add_argument("--limit", type=int, default=None, help="Cap number of battles processed")
    ap.add_argument("--out", type=str, default=None, help="Output JSON path (default: scripts/date-suggestions-<year>.json)")
    ap.add_argument("--sleep", type=float, default=0.2, help="Sleep seconds between batches (rate limiting)")
    args = ap.parse_args()

    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        sys.exit("DATABASE_URL not set — `source .env` first")
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        sys.exit("ANTHROPIC_API_KEY not set — `source .env` first")

    out_path = Path(args.out or f"scripts/date-suggestions-{args.year}.json")
    out_path.parent.mkdir(parents=True, exist_ok=True)

    conn = psycopg2.connect(db_url)
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    query = """
        SELECT wikidata_qid, title, wikipedia_url, wikipedia_summary, year_start, year_end
        FROM events
        WHERE 'battle' = ANY(categories)
          AND year_start = %s
          AND (year_end IS NULL OR year_end = year_start)
          AND month_start IS NULL
          AND wikidata_qid IS NOT NULL
          AND wikipedia_summary IS NOT NULL
          AND wikipedia_summary <> ''
        ORDER BY title
    """
    params: list = [args.year]
    if args.limit:
        query += " LIMIT %s"
        params.append(args.limit)
    cur.execute(query, params)
    rows = cur.fetchall()
    print(f"DB: {len(rows)} year-only battles in {args.year} with Wikipedia summaries.", flush=True)

    if not rows:
        print("Nothing to do.")
        return

    client = Anthropic(api_key=api_key)
    suggestions: list[dict] = []
    skipped: list[dict] = []

    for i, row in enumerate(rows, 1):
        qid = row["wikidata_qid"]
        title = row["title"]
        prefix = f"[{i}/{len(rows)}] {title} ({qid})"

        try:
            wd = fetch_existing_date_precision(qid)
        except Exception as e:
            print(f"{prefix}\n  ✗ Wikidata fetch failed: {e}", flush=True)
            skipped.append({"qid": qid, "title": title, "reason": f"wikidata fetch error: {e}"})
            continue

        max_prec = wd["max_precision"]
        if max_prec is None:
            print(f"{prefix}\n  · skipped: no date claim on Wikidata (no P585/P580/P582)", flush=True)
            skipped.append({"qid": qid, "title": title, "reason": "no P585/P580/P582 statement"})
            continue
        if max_prec > PRECISION_YEAR:
            label = {PRECISION_MONTH: "month", PRECISION_DAY: "day"}.get(max_prec, str(max_prec))
            present = ", ".join(f"{p}={v}" for p, v in wd["claims"].items() if v is not None)
            print(f"{prefix}\n  · skipped: Wikidata already has {label} precision ({present})", flush=True)
            skipped.append({"qid": qid, "title": title, "reason": f"already at {label} precision: {present}"})
            continue

        # Fetch the LIVE intro extract from MediaWiki — preserves parentheticals
        # like "(4 April – 15 June 1800)" that our DB-stored summary strips.
        try:
            intro = fetch_intro_extract(row["wikipedia_url"])
        except Exception as e:
            print(f"{prefix}\n  ✗ intro fetch failed: {e}", flush=True)
            skipped.append({"qid": qid, "title": title, "reason": f"intro fetch error: {e}"})
            continue
        text = intro or row["wikipedia_summary"]  # fall back if MediaWiki fails

        try:
            result = suggest_date(client, title, text, args.year)
        except Exception as e:
            print(f"{prefix}\n  ✗ LLM call failed: {e}", flush=True)
            skipped.append({"qid": qid, "title": title, "reason": f"LLM error: {e}"})
            continue

        kind = result.get("kind", "none")
        start = result.get("start")
        end = result.get("end")
        start_prec = result.get("start_precision", "year")
        end_prec = result.get("end_precision", "year")

        # Strict mode: skip unless Claude explicitly returns kind="point" or "range"
        # AND the precision actually improves on the year. "kind"="none" is the
        # rejection signal; we also defensively check the precision fields.
        if kind == "none" or not start:
            print(f"{prefix}\n  · skipped: summary doesn't name explicit dates", flush=True)
            skipped.append({"qid": qid, "title": title, "reason": "no explicit dates in summary"})
            continue
        if start_prec == "year" and end_prec == "year":
            print(f"{prefix}\n  · skipped: no precision improvement", flush=True)
            skipped.append({"qid": qid, "title": title, "reason": "no precision improvement"})
            continue

        edit_props = ["P585"] if kind == "point" else ["P580", "P582"]

        suggestions.append({
            "qid": qid,
            "title": title,
            "wikipedia_url": row["wikipedia_url"],
            "current_year": args.year,
            "kind": kind,
            "start": start,
            "end": end,
            "start_precision": start_prec,
            "end_precision": end_prec,
            "wikidata_properties": edit_props,
            "source_quote": result.get("source"),
        })
        if kind == "point":
            print(f"{prefix}\n  → {start} ({start_prec}) — {(result.get('source') or '')[:120]}", flush=True)
        else:
            print(f"{prefix}\n  → {start} → {end} ({start_prec}/{end_prec}) — {(result.get('source') or '')[:120]}", flush=True)

        if args.sleep:
            time.sleep(args.sleep)

    cur.close()
    conn.close()

    payload = {
        "year": args.year,
        "model": MODEL,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "total_candidates": len(rows),
        "suggestion_count": len(suggestions),
        "skipped_count": len(skipped),
        "suggestions": suggestions,
        "skipped": skipped,
    }
    out_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False))

    print(f"\n✓ {len(suggestions)} suggestion(s), {len(skipped)} skipped of {len(rows)} candidates")
    print(f"✓ Wrote {out_path}")
    print("\nDRY RUN — no Wikidata writes were made.")


if __name__ == "__main__":
    main()
