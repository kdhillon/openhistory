"""Fetch polity parent links from Wikidata.

Five signals merged per child:
  - P150 (reverse: parent has P150 -> child)  highest priority
  - P361 (forward: child has P361 -> parent)
  - P131 (forward: located in admin entity)
  - P127 (forward: owned by)
  - P31 reverse-class (curated umbrella classes -> parent QID)

P17 (country) is intentionally excluded - it expresses category attribution
(every coin/village tagged with a country), not political hierarchy.
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

# Curated umbrella P31 classes: child entities with P31 = key are children of value.
# Grows as we encounter more umbrella unions.
UMBRELLA_CLASSES: dict[str, str] = {
    "Q1326279": "Q151624",   # state of the German Confederation -> German Confederation
    "Q713750":  "Q12548",    # state of the Holy Roman Empire -> HRE
    "Q1763527": "Q43287",    # state of the German Empire -> German Empire
}

# Source priority (lower number = wins on dedupe)
SOURCE_RANK: dict[str, int] = {"P150": 0, "P361": 1, "P131": 2, "P127": 3}


class ParentEntry(TypedDict):
    qid: str
    yearStart: int | None
    yearEnd: int | None
    source: str


def _source_rank(src: str) -> int:
    if src.startswith("P31:"):
        return 4
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


def _query_direct_properties(qids: list[str]) -> list[dict]:
    """One batched SPARQL UNION over P150 (in), P361/P131/P127 (out) for a chunk of child QIDs."""
    values = " ".join(f"wd:{q}" for q in qids)
    q = f"""
    SELECT DISTINCT ?child ?parent ?source ?startTime ?endTime ?inception ?dissolved WHERE {{
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
        ?child p:P127 ?s. ?s ps:P127 ?parent. BIND("P127" AS ?source)
        OPTIONAL {{ ?s pq:P580 ?startTime. }} OPTIONAL {{ ?s pq:P582 ?endTime. }}
      }}
      OPTIONAL {{ ?child wdt:P571 ?inception. }}
      OPTIONAL {{ ?child wdt:P576 ?dissolved. }}
    }}
    """
    return _sparql(q)


def _query_umbrella_class(class_qid: str) -> list[dict]:
    """Return all entities with P31 = class_qid plus their inception/dissolution."""
    q = f"""
    SELECT ?child ?inception ?dissolved WHERE {{
      ?child wdt:P31 wd:{class_qid}.
      OPTIONAL {{ ?child wdt:P571 ?inception. }}
      OPTIONAL {{ ?child wdt:P576 ?dissolved. }}
    }}
    """
    return _sparql(q)


def fetch_parents(
    qids: list[str],
    eligible_children: set[str] | None = None,
    chunk_size: int = 100,
) -> dict[str, list[ParentEntry]]:
    """
    Fetch parent links for the given child QIDs from Wikidata.

    Args:
      qids: list of child QIDs to query.
      eligible_children: if provided, only children whose QID is in this set are returned.
                         (Use the set of QIDs from your polities table to filter noise.)
      chunk_size: child QIDs per SPARQL call.

    Returns:
      { child_qid: [ParentEntry, ...] } -- deduped by (child, parent), highest-priority source wins.
    """
    # Results are always a subset of `qids`. Direct-property queries naturally satisfy this
    # via the SPARQL VALUES clause; the P31 class loop, however, would leak children we
    # never asked about, so we also gate by `qids` here. `eligible_children` is an additional
    # registry filter on top (e.g., "only known polities").
    qids_set = set(qids)
    eligible = eligible_children  # None = no extra filter
    # child_qid -> parent_qid -> (rank, ParentEntry)
    best: dict[str, dict[str, tuple[int, ParentEntry]]] = {}

    def offer(child: str, parent: str, source: str, ystart: int | None, yend: int | None) -> None:
        if child not in qids_set:
            return
        if eligible is not None and child not in eligible:
            return
        if child == parent:
            return
        rank = _source_rank(source)
        entry: ParentEntry = {"qid": parent, "yearStart": ystart, "yearEnd": yend, "source": source}
        slot = best.setdefault(child, {})
        cur = slot.get(parent)
        if cur is None or rank < cur[0]:
            slot[parent] = (rank, entry)

    # 1) Direct-property batches
    for i in range(0, len(qids), chunk_size):
        chunk = qids[i:i + chunk_size]
        rows = _query_direct_properties(chunk)
        for r in rows:
            child = r["child"]["value"].rsplit("/", 1)[-1]
            parent = r["parent"]["value"].rsplit("/", 1)[-1]
            source = r["source"]["value"]
            ystart = _year(r.get("startTime", {}).get("value")) or _year(r.get("inception", {}).get("value"))
            yend = _year(r.get("endTime", {}).get("value")) or _year(r.get("dissolved", {}).get("value"))
            offer(child, parent, source, ystart, yend)

    # 2) Umbrella-class queries (one per curated class, all members at once)
    for class_qid, parent_qid in UMBRELLA_CLASSES.items():
        rows = _query_umbrella_class(class_qid)
        for r in rows:
            child = r["child"]["value"].rsplit("/", 1)[-1]
            ystart = _year(r.get("inception", {}).get("value"))
            yend = _year(r.get("dissolved", {}).get("value"))
            offer(child, parent_qid, f"P31:{class_qid}", ystart, yend)

    return {child: [v[1] for v in slot.values()] for child, slot in best.items()}
