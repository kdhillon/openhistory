#!/usr/bin/env python3
"""
scripts/discover-categories.py

Discovers and validates Wikidata event-class QIDs for the pipeline.

HOW IT WORKS
------------
Wikipedia's category taxonomy is the editorial source of truth for what
types of historical events exist. This script bridges Wikipedia categories
to Wikidata P31 classes via the P301 property ("category's main topic"):

  Wikipedia "Category:Elections"
    → wikibase_item  → Q4273219  (Wikidata item for the category page)
    → P301           → Q40231    (the actual 'election' concept)
    → SPARQL COUNT   → 2,847 dated events with Wikipedia articles

This gives a principled, reproducible way to find and validate class QIDs
rather than guessing them manually.

MODES
-----
1. Validate (default):
   Tests every active entry in pipeline/categories.json and prints current counts.
   Use this to detect broken/changed QIDs and see coverage.

   python3 scripts/discover-categories.py

2. Discover:
   Walks Wikipedia subcategories of a root category, resolves each to a
   Wikidata class QID via P301, counts dated Wikipedia items, and reports
   candidates not yet in categories.json.

   python3 scripts/discover-categories.py --discover
   python3 scripts/discover-categories.py --discover --root "Category:Disasters"
   python3 scripts/discover-categories.py --discover --depth 2 --min-count 30

OUTPUT
------
Validate mode prints a table:
  label            | class_qid | count  | status
  conflicts        | Q180684   | 12,453 | OK
  trials           | (none)    |  —     | SKIPPED

Discover mode prints candidates:
  wiki_category              | class_qid | label            | count  | action
  Category:Famines           | Q168247   | famine           |    412 | already active
  Category:Sieges            | Q188055   | siege            |  1,204 | ADD →
  Category:Political scandals| Q1057954  | political scandal|     87 | review

After discovering new candidates, add them to pipeline/categories.json manually.
"""

import argparse
import json
import time
from pathlib import Path

import requests

ROOT_DIR = Path(__file__).parent.parent
CATEGORIES_FILE = ROOT_DIR / "pipeline" / "categories.json"

WIKIPEDIA_API = "https://en.wikipedia.org/w/api.php"
WIKIDATA_API  = "https://www.wikidata.org/w/api.php"
WDQS_ENDPOINT = "https://query.wikidata.org/sparql"
USER_AGENT    = "OurStory-pipeline/0.2 (discover-categories)"

SESSION = requests.Session()
SESSION.headers.update({"User-Agent": USER_AGENT})

MAX_YEAR = 2015  # match the pipeline default


# ---------------------------------------------------------------------------
# Wikidata API helpers
# ---------------------------------------------------------------------------

def get_labels(qids: list[str]) -> dict[str, str]:
    """Batch-fetch English labels for Wikidata QIDs."""
    result: dict[str, str] = {}
    for i in range(0, len(qids), 50):
        batch = qids[i : i + 50]
        r = SESSION.get(WIKIDATA_API, params={
            "action": "wbgetentities", "ids": "|".join(batch),
            "props": "labels", "languages": "en", "format": "json",
        }, timeout=15)
        r.raise_for_status()
        for qid, entity in r.json().get("entities", {}).items():
            label = entity.get("labels", {}).get("en", {}).get("value")
            if label:
                result[qid] = label
        if i + 50 < len(qids):
            time.sleep(0.5)
    return result


def get_p301(category_item_qids: list[str]) -> dict[str, str | None]:
    """
    For a list of Wikidata QIDs that represent Wikipedia category pages,
    return {category_qid: main_topic_qid} via P301.
    """
    result: dict[str, str | None] = {}
    for i in range(0, len(category_item_qids), 50):
        batch = category_item_qids[i : i + 50]
        r = SESSION.get(WIKIDATA_API, params={
            "action": "wbgetentities", "ids": "|".join(batch),
            "props": "claims", "format": "json",
        }, timeout=15)
        r.raise_for_status()
        for qid, entity in r.json().get("entities", {}).items():
            topic = None
            for stmt in entity.get("claims", {}).get("P301", []):
                snak = stmt.get("mainsnak", {})
                if snak.get("snaktype") == "value":
                    val = snak["datavalue"]["value"]
                    if isinstance(val, dict) and val.get("id"):
                        topic = val["id"]
                        break
            result[qid] = topic
        if i + 50 < len(category_item_qids):
            time.sleep(0.5)
    return result


# ---------------------------------------------------------------------------
# Wikipedia API helpers
# ---------------------------------------------------------------------------

def get_wikibase_items(category_titles: list[str]) -> dict[str, str]:
    """
    For a list of Wikipedia category titles, return {title: wikibase_item_qid}.
    """
    result: dict[str, str] = {}
    for i in range(0, len(category_titles), 50):
        batch = category_titles[i : i + 50]
        r = SESSION.get(WIKIPEDIA_API, params={
            "action": "query", "titles": "|".join(batch),
            "prop": "pageprops", "ppprop": "wikibase_item", "format": "json",
        }, timeout=15)
        r.raise_for_status()
        for page in r.json()["query"]["pages"].values():
            qid = page.get("pageprops", {}).get("wikibase_item")
            if qid and not page.get("missing"):
                result[page["title"]] = qid
        if i + 50 < len(category_titles):
            time.sleep(0.3)
    return result


def get_subcategories(cat_title: str, limit: int = 50) -> list[str]:
    """Return direct subcategory titles for a Wikipedia category."""
    r = SESSION.get(WIKIPEDIA_API, params={
        "action": "query", "list": "categorymembers",
        "cmtitle": cat_title, "cmtype": "subcat",
        "cmlimit": limit, "format": "json",
    }, timeout=15)
    r.raise_for_status()
    return [m["title"] for m in r.json()["query"]["categorymembers"]]


# ---------------------------------------------------------------------------
# SPARQL helpers
# ---------------------------------------------------------------------------

def sparql_count(class_qid: str, max_year: int = MAX_YEAR, timeout: int = 25) -> int:
    """
    COUNT of distinct Wikidata items that are:
      - P31/P279* of class_qid
      - have a date (P585, P580, or P571) ≤ max_year
      - have an English Wikipedia article

    Returns -1 on timeout or error.
    """
    query = f"""
    SELECT (COUNT(DISTINCT ?item) AS ?n) WHERE {{
      ?item wdt:P31/wdt:P279* wd:{class_qid} .
      {{
        ?item wdt:P585 ?d . FILTER(YEAR(?d) <= {max_year})
      }} UNION {{
        ?item wdt:P580 ?d . FILTER(YEAR(?d) <= {max_year})
      }} UNION {{
        ?item wdt:P571 ?d . FILTER(YEAR(?d) <= {max_year})
      }}
      ?a schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> .
    }}
    """
    try:
        resp = SESSION.get(
            WDQS_ENDPOINT,
            params={"query": query, "format": "json"},
            headers={"Accept": "application/sparql-results+json"},
            timeout=timeout,
        )
        resp.raise_for_status()
        bindings = resp.json()["results"]["bindings"]
        if bindings:
            return int(bindings[0]["n"]["value"])
    except Exception:
        pass
    return -1


# ---------------------------------------------------------------------------
# Wikipedia → Wikidata class resolution
# ---------------------------------------------------------------------------

def resolve_category_to_class(cat_title: str) -> str | None:
    """
    Resolve a Wikipedia category title to a Wikidata event-class QID via:
      Wikipedia category title
        → wikibase_item (Wikidata item for the category page)
        → P301 (category's main topic = the event class)
    """
    items = get_wikibase_items([cat_title])
    if cat_title not in items:
        return None
    category_item_qid = items[cat_title]
    p301 = get_p301([category_item_qid])
    return p301.get(category_item_qid)


# ---------------------------------------------------------------------------
# Validate mode
# ---------------------------------------------------------------------------

def run_validate(args):
    cats = json.loads(CATEGORIES_FILE.read_text())["categories"]

    print(f"\n{'='*75}")
    print(f"  Validating {len(cats)} entries in pipeline/categories.json")
    print(f"  Max year: {args.max_year}")
    print(f"{'='*75}")
    print(f"\n{'Label':<26} {'QID':<12} {'Count':>7}  {'Status'}")
    print(f"{'-'*26} {'-'*12} {'-'*7}  {'-'*20}")

    total_active = 0
    total_count  = 0

    for cat in cats:
        label     = cat["label"]
        qid       = cat.get("class_qid")
        active    = cat.get("active", True)

        if not active:
            print(f"{label:<26} {'(none)':<12} {'—':>7}  SKIPPED — {cat.get('notes','')[:40]}")
            continue

        if not qid:
            print(f"{label:<26} {'(none)':<12} {'—':>7}  NO QID")
            continue

        count = sparql_count(qid, max_year=args.max_year)
        time.sleep(1.0)

        if count == -1:
            status = "TIMEOUT/ERROR"
        elif count == 0:
            status = "BROKEN — 0 results"
        elif count < 20:
            status = f"LOW ({count})"
        else:
            status = "OK"

        count_str = str(count) if count >= 0 else "ERR"
        print(f"{label:<26} {qid:<12} {count_str:>7}  {status}")

        if count > 0:
            total_active += 1
            total_count  += count

    print(f"\n  {total_active} active categories, ~{total_count:,} total dated Wikipedia events")
    print(f"\nUpdate pipeline/categories.json to add/remove/fix entries.")


# ---------------------------------------------------------------------------
# Discover mode
# ---------------------------------------------------------------------------

# Skip meta/navigation subcategories that don't represent event types
_SKIP_KEYWORDS = [
    "by country", "by continent", "by location", "by year", "by century",
    "by decade", "by period", "by region", "by war", "by type", "stubs",
    "templates", "lists of", "timelines", "historiography", "navboxes",
    "people", "organizations", "biographies", "redirects", "films",
    "books", "articles", "categories", "images",
]


def should_skip(cat_title: str) -> bool:
    lower = cat_title.lower()
    return any(kw in lower for kw in _SKIP_KEYWORDS)


def walk_subcategories(root: str, depth: int) -> list[str]:
    """Recursively collect subcategory titles up to `depth` levels."""
    if depth == 0:
        return [root]

    print(f"    Walking: {root}...", flush=True)
    subcats = get_subcategories(root)
    time.sleep(0.5)

    results = []
    for sub in subcats:
        if should_skip(sub):
            continue
        if depth > 1:
            results.extend(walk_subcategories(sub, depth - 1))
        else:
            results.append(sub)

    return results if results else [root]


def run_discover(args):
    # Load existing QIDs to detect duplicates
    existing = json.loads(CATEGORIES_FILE.read_text())["categories"]
    existing_qids   = {c["class_qid"] for c in existing if c.get("class_qid")}
    existing_active = {c["class_qid"] for c in existing if c.get("class_qid") and c.get("active")}

    root = args.root

    print(f"\n{'='*75}")
    print(f"  Discovering categories under: {root}")
    print(f"  Depth: {args.depth} | Min count: {args.min_count} | Max year: {args.max_year}")
    print(f"{'='*75}\n")

    # Step 1: walk Wikipedia category tree
    print("[1] Walking Wikipedia category tree...")
    candidates = walk_subcategories(root, args.depth)
    candidates = list(dict.fromkeys(candidates))  # deduplicate preserving order
    print(f"    Found {len(candidates)} subcategories to evaluate.\n")

    # Step 2: resolve each category to a Wikidata class QID via P301
    print("[2] Resolving Wikipedia categories → Wikidata class QIDs via P301...")
    wikibase_items = get_wikibase_items(candidates)
    time.sleep(0.5)

    cat_item_qids = list(wikibase_items.values())
    p301_map = get_p301(cat_item_qids)

    # Build: {wiki_category: class_qid}
    cat_to_class: dict[str, str] = {}
    for cat_title, item_qid in wikibase_items.items():
        class_qid = p301_map.get(item_qid)
        if class_qid:
            cat_to_class[cat_title] = class_qid

    # Resolve class QID labels
    all_class_qids = list(set(cat_to_class.values()))
    labels = get_labels(all_class_qids)

    print(f"    Resolved {len(cat_to_class)}/{len(candidates)} categories to Wikidata class QIDs.\n")

    # Step 3: SPARQL count for each unique class QID
    print("[3] Counting dated Wikipedia items per class (SPARQL)...")
    unique_classes = list(dict.fromkeys(cat_to_class.values()))
    counts: dict[str, int] = {}

    for qid in unique_classes:
        label_str = labels.get(qid, "?")
        print(f"    {qid} ({label_str})... ", end="", flush=True)
        n = sparql_count(qid, max_year=args.max_year)
        counts[qid] = n
        print(f"{n if n >= 0 else 'TIMEOUT'}")
        time.sleep(1.2)

    # Step 4: Print results
    print(f"\n{'='*75}")
    print(f"  {'Wiki Category':<42} {'QID':<12} {'Wikidata Label':<22} {'Count':>6}  Action")
    print(f"  {'-'*42} {'-'*12} {'-'*22} {'-'*6}  {'-'*20}")

    # Sort by count descending, then category name
    sorted_cats = sorted(
        cat_to_class.items(),
        key=lambda kv: -(counts.get(kv[1], -1)),
    )

    new_candidates = []
    for cat_title, class_qid in sorted_cats:
        count = counts.get(class_qid, -1)
        label_str = labels.get(class_qid, "?")

        if count < 0:
            action = "TIMEOUT — skip"
        elif count == 0:
            action = "0 results — skip"
        elif class_qid in existing_active:
            action = "already active"
        elif class_qid in existing_qids:
            action = "in JSON (inactive)"
        elif count >= args.min_count:
            action = "ADD →"
            new_candidates.append({
                "label": label_str.lower(),
                "class_qid": class_qid,
                "wiki_category": cat_title,
                "wikidata_label": label_str,
                "notes": None,
                "last_count": count,
                "active": True,
            })
        else:
            action = f"low ({count}) — skip"

        count_str = str(count) if count >= 0 else "ERR"
        short_cat = cat_title.replace("Category:", "")
        print(f"  {short_cat:<42} {class_qid:<12} {label_str:<22} {count_str:>6}  {action}")

    # Print unresolved (no P301)
    unresolved = [c for c in candidates if c not in cat_to_class]
    if unresolved:
        print(f"\n  No P301 found for {len(unresolved)} categories:")
        for c in unresolved:
            print(f"    {c}")

    # Print JSON for new candidates
    if new_candidates:
        print(f"\n{'='*75}")
        print(f"  {len(new_candidates)} new candidate(s). Add to pipeline/categories.json:\n")
        for nc in new_candidates:
            print(json.dumps(nc, indent=4))
            print(",")
    else:
        print(f"\n  No new candidates above min-count={args.min_count}.")

    print(f"\nDone. Edit pipeline/categories.json to add approved candidates.")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Discover and validate Wikidata event-class QIDs for the pipeline",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "--discover", action="store_true",
        help="Walk Wikipedia categories to find new class QIDs (default: validate existing)",
    )
    parser.add_argument(
        "--root", default="Category:Events",
        help="Wikipedia root category to walk in discover mode (default: Category:Events)",
    )
    parser.add_argument(
        "--depth", type=int, default=1,
        help="How many levels of subcategories to walk (default: 1)",
    )
    parser.add_argument(
        "--min-count", type=int, default=50,
        help="Minimum SPARQL count for a class to be a candidate (default: 50)",
    )
    parser.add_argument(
        "--max-year", type=int, default=MAX_YEAR,
        help=f"Exclude events after this year (default: {MAX_YEAR})",
    )
    args = parser.parse_args()

    if args.discover:
        run_discover(args)
    else:
        run_validate(args)


if __name__ == "__main__":
    main()
