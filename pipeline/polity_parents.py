"""Fetch polity parent links from Wikidata.

Five child-side signals per polity:
  - P150 (parent has P150 -> child)        highest priority
  - P361 (child has P361 -> parent)
  - P131 (child has P131 -> parent)
  - P17  (child has P17  -> parent)
  - P127 (child has P127 -> parent)

Key rules (data-driven, no hardcoded umbrella list):
  1. Both child AND parent must be polities in our DB (registry filter).
     This automatically drops noise like Sweden -> EU (EU is not a polity in our DB)
     and the coin/village/person noise that historically made P17 unusable.
  2. Each parent-link's year range is the INTERSECTION of:
        - parent's own lifetime (from our polities row)
        - child's own lifetime (from our polities row)
        - the statement's pq:P580 / pq:P582 qualifiers, when present
     This eliminates the "no time qualifier -> null/null = always active" bug
     that made Hamburg appear "Part of HRE" at 1820.
  3. Multiple parents per child are supported via the JSONB array shape;
     each entry carries its own year range and provenance.

P31 reverse-class and any hardcoded umbrella list are intentionally excluded —
the registry filter plus parent-lifetime intersection makes them unnecessary.
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import TypedDict


WD_ENDPOINT = "https://query.wikidata.org/sparql"
WD_HEADERS = {
    "User-Agent": "openhistory/0.1 (https://openhistory.app)",
    "Accept": "application/sparql-results+json",
}

# Source priority (lower number = wins on dedupe within a (child, parent) pair).
SOURCE_RANK: dict[str, int] = {"P150": 0, "P361": 1, "P131": 2, "P17": 3, "P127": 4}


class ParentEntry(TypedDict):
    qid: str
    yearStart: int | None
    yearEnd: int | None
    source: str


def _source_rank(src: str) -> int:
    return SOURCE_RANK.get(src, 9)


def _sparql(query: str, retries: int = 2) -> list[dict]:
    """POST a SPARQL query, return bindings. Retries on 429/5xx with exponential backoff."""
    data = urllib.parse.urlencode({"query": query}).encode()
    last_err: Exception | None = None
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(WD_ENDPOINT + "?format=json", data=data, headers=WD_HEADERS)
            with urllib.request.urlopen(req, timeout=90) as r:
                return json.loads(r.read())["results"]["bindings"]
        except urllib.error.HTTPError as e:
            last_err = e
            if e.code in (429, 500, 502, 503, 504) and attempt < retries:
                time.sleep(2 ** attempt)
                continue
            raise
        except urllib.error.URLError as e:
            last_err = e
            if attempt < retries:
                time.sleep(2 ** attempt)
                continue
            raise
    assert last_err is not None
    raise last_err


def _year(iso: str | None) -> int | None:
    """Parse an ISO-ish date string from Wikidata into a year int. Handles BCE (-NNNN)."""
    if not iso:
        return None
    s = iso[:5] if iso.startswith("-") else iso[:4]
    try:
        return int(s)
    except ValueError:
        return None


def _min_or_none(values: list[int | None]) -> int | None:
    non_none = [v for v in values if v is not None]
    return min(non_none) if non_none else None


def _max_or_none(values: list[int | None]) -> int | None:
    non_none = [v for v in values if v is not None]
    return max(non_none) if non_none else None


def _query_child_side(qids: list[str]) -> list[dict]:
    """For a chunk of CHILD QIDs, fetch parent links via four directions.

    Returns bindings with: child, parent, source, startTime?, endTime?,
                          childInception?, childDissolved?.
    """
    values = " ".join(f"wd:{q}" for q in qids)
    q = f"""
    SELECT DISTINCT ?child ?parent ?source ?startTime ?endTime ?childInception ?childDissolved WHERE {{
      VALUES ?child {{ {values} }}
      {{
        ?parent p:P150 ?s. ?s ps:P150 ?child. BIND("P150" AS ?source)
        OPTIONAL {{ ?s pq:P580 ?startTime. }} OPTIONAL {{ ?s pq:P582 ?endTime. }}
      }} UNION {{
        ?child p:P361 ?s. ?s ps:P361 ?parent. BIND("P361" AS ?source)
        OPTIONAL {{ ?s pq:P580 ?startTime. }} OPTIONAL {{ ?s pq:P582 ?endTime. }}
      }} UNION {{
        ?child p:P131 ?s. ?s ps:P131 ?parent. BIND("P131" AS ?source)
        OPTIONAL {{ ?s pq:P580 ?startTime. }} OPTIONAL {{ ?s pq:P582 ?endTime. }}
      }} UNION {{
        ?child p:P17 ?s. ?s ps:P17 ?parent. BIND("P17" AS ?source)
        OPTIONAL {{ ?s pq:P580 ?startTime. }} OPTIONAL {{ ?s pq:P582 ?endTime. }}
      }} UNION {{
        ?child p:P127 ?s. ?s ps:P127 ?parent. BIND("P127" AS ?source)
        OPTIONAL {{ ?s pq:P580 ?startTime. }} OPTIONAL {{ ?s pq:P582 ?endTime. }}
      }}
      OPTIONAL {{ ?child wdt:P571 ?childInception. }}
      OPTIONAL {{ ?child wdt:P576 ?childDissolved. }}
    }}
    """
    return _sparql(q)


def fetch_parents(
    qids: list[str],
    polity_meta: dict[str, dict] | None = None,
    chunk_size: int = 100,
) -> dict[str, list[ParentEntry]]:
    """
    Fetch parent links per child QID.

    Args:
      qids: child QIDs to query. (For bulk backfill, pass all polities; for a single
            manual import, pass [qid] — same logic.)
      polity_meta: { qid: { "year_start": int|None, "year_end": int|None, ... } }
                   Must contain entries for every polity QID we want to recognize as
                   a valid parent. When None, no registry filter is applied and only
                   Wikidata inception/dissolution bound the year ranges.
      chunk_size: child QIDs per SPARQL call.

    Returns:
      { child_qid: [ParentEntry, ...] } -- one entry per (child, parent) pair.
      Each entry's year range is the intersection of parent's lifetime, child's
      lifetime, and the statement's time qualifiers (if any).
    """
    qids_set = set(qids)
    if polity_meta is None:
        # No registry: every child is allowed, no parent filter, only Wikidata bounds.
        registry: set[str] | None = None
        meta: dict[str, dict] = {}
    else:
        registry = set(polity_meta.keys())
        meta = polity_meta

    # child -> parent -> ParentEntry (deduped; highest source priority wins; same priority widens)
    best: dict[str, dict[str, ParentEntry]] = {}

    def offer(
        child: str,
        parent: str,
        source: str,
        stmt_start: int | None,
        stmt_end: int | None,
        child_inception: int | None,
        child_dissolved: int | None,
    ) -> None:
        if child == parent:
            return
        if child not in qids_set:
            return  # never store links for QIDs we weren't asked about
        if registry is not None and parent not in registry:
            return  # parent must be a polity in our DB (drops Sweden -> EU)

        parent_meta = meta.get(parent, {})
        child_meta = meta.get(child, {})

        parent_start = parent_meta.get("year_start")
        parent_end = parent_meta.get("year_end")
        # Fall back to Wikidata inception/dissolution when our DB has no dates.
        child_start = child_meta.get("year_start") or child_inception
        child_end = child_meta.get("year_end") or child_dissolved

        # Intersect: year_start = max of all starts; year_end = min of all ends.
        year_start = _max_or_none([parent_start, child_start, stmt_start])
        year_end = _min_or_none([parent_end, child_end, stmt_end])
        if year_start is not None and year_end is not None and year_start > year_end:
            return  # impossible window — parent and child lifetimes don't overlap

        entry: ParentEntry = {
            "qid": parent,
            "yearStart": year_start,
            "yearEnd": year_end,
            "source": source,
        }

        slot = best.setdefault(child, {})
        existing = slot.get(parent)
        if existing is None:
            slot[parent] = entry
            return
        r_new = _source_rank(source)
        r_old = _source_rank(existing["source"])
        if r_new < r_old:
            slot[parent] = entry
        elif r_new == r_old:
            # Same priority — widen the kept range.
            existing["yearStart"] = _min_or_none([existing["yearStart"], year_start])
            existing["yearEnd"] = _max_or_none([existing["yearEnd"], year_end])

    for i in range(0, len(qids), chunk_size):
        chunk = qids[i:i + chunk_size]
        rows = _query_child_side(chunk)
        for r in rows:
            child = r["child"]["value"].rsplit("/", 1)[-1]
            parent = r["parent"]["value"].rsplit("/", 1)[-1]
            source = r["source"]["value"]
            stmt_start = _year(r.get("startTime", {}).get("value"))
            stmt_end = _year(r.get("endTime", {}).get("value"))
            child_inception = _year(r.get("childInception", {}).get("value"))
            child_dissolved = _year(r.get("childDissolved", {}).get("value"))
            offer(child, parent, source, stmt_start, stmt_end, child_inception, child_dissolved)

    return {child: list(slot.values()) for child, slot in best.items()}
