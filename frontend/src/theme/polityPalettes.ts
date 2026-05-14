import { CATEGORY_COLORS } from './categories';
import type { PolityType } from '../types';

export type PaletteId = 'polity-type' | 'muted-classic' | 'saturated-retro' | 'retro' | 'earth-tones' | 'none';

export const POLITY_PALETTES: Record<PaletteId, { label: string; colors: string[]; fillOpacity: number }> = {
  // Pastels and earth tones are quieter — they read better at higher opacity.
  // Saturated/default palettes are already vivid, so keep them airy.
  'polity-type':     { label: 'By polity type (default)', colors: [],                                                                                                  fillOpacity: 0.22 },
  'muted-classic':   { label: 'Muted classic',            colors: ['#F2B5A8', '#F4D58D', '#BFD8B8', '#A8C6DF', '#D5BCE0', '#F0C292', '#A8D6CD'],                       fillOpacity: 0.6 },
  'saturated-retro': { label: 'Saturated retro',          colors: ['#C9536E', '#ED7B2F', '#D9A92E', '#2A9D8F', '#2E86C1', '#9B5DE5', '#5BB377'],                       fillOpacity: 0.4 },
  'retro':           { label: 'Retro',                    colors: ['#C9536E', '#ED7B2F', '#D9A92E', '#2A9D8F', '#2E86C1', '#9B5DE5', '#5BB377'],                       fillOpacity: 0.25 },
  'earth-tones':     { label: 'Earth tones',              colors: ['#C97B63', '#D9A05B', '#B4A269', '#8FA6A0', '#7C95B1', '#B58FA8', '#7B8B5C'],                       fillOpacity: 0.6 },
  // Blank fill — keeps borders + labels but renders no polygon coloring.
  // fillOpacity: 0 turns the baked rgba alpha to zero, so the ohm-fills layer
  // is effectively invisible while ohm-borders / ohm-polygon-borders stay.
  'none':            { label: 'None (borders only)',      colors: [],                                                                                                  fillOpacity: 0 },
};

export const DEFAULT_PALETTE_ID: PaletteId = 'saturated-retro';

// FNV-1a 32-bit hash. Deterministic, fast, well-distributed for short strings.
// Same input always produces the same output, so the same polity title always
// maps to the same palette index across reloads.
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function getPolityColor(polityKey: string, polityType: PolityType | undefined, paletteId: PaletteId): string {
  if (paletteId === 'polity-type') {
    return CATEGORY_COLORS[polityType ?? 'other'] ?? CATEGORY_COLORS.other;
  }
  const colors = POLITY_PALETTES[paletteId].colors;
  if (colors.length === 0) return CATEGORY_COLORS.other;
  const idx = fnv1a(polityKey || '') % colors.length;
  return colors[idx];
}

export function isValidPaletteId(id: string | null | undefined): id is PaletteId {
  return typeof id === 'string' && id in POLITY_PALETTES;
}

// ---------------------------------------------------------------------------
// Parent-cascade color resolution
// ---------------------------------------------------------------------------

export type ParentEntry = {
  qid: string;
  yearStart?: number | null;
  yearEnd?: number | null;
  source: string;
};

export type PolityForColor = {
  qid: string;
  polityType?: PolityType;
  parents?: ParentEntry[];
  /** Optional override for the color-hash input. Defaults to qid. Pass the
   *  polity title here to keep color stable across QID/title swaps and to
   *  match the existing name-hashed rendering. */
  polityKey?: string;
  /** Capital city name — used by the capital-cascade fallback. When a polity has
   *  no parent of its own but another polity active at the same year shares its
   *  capital, the cascade follows that sibling's chain instead. */
  capitalName?: string | null;
  yearStart?: number | null;
  yearEnd?: number | null;
};

export type ParentResolver = (qid: string) => PolityForColor | null;
/** Find another polity active at `year` whose capital matches `capitalName`.
 *  Used as a fallback when the polity has no direct parent in Wikidata
 *  (e.g. "Fascist Italy" has no `part-of Kingdom of Italy` link, but both
 *  have Rome as capital — so we let it inherit the Kingdom's color). */
export type CapitalSiblingResolver = (capitalName: string, year: number, excludeQid: string) => PolityForColor | null;

const SOURCE_RANK: Record<string, number> = { P150: 0, P361: 1, P131: 2, P127: 3 };

function sourceRank(source: string): number {
  if (source.startsWith('P31:')) return 4;
  return SOURCE_RANK[source] ?? 9;
}

/** Highest-priority parent active at `year`, or null. */
export function activeParentAt(parents: ParentEntry[] | undefined, year: number): ParentEntry | null {
  if (!parents || parents.length === 0) return null;
  const active = parents.filter(p =>
    (p.yearStart == null || p.yearStart <= year) &&
    (p.yearEnd == null || p.yearEnd >= year)
  );
  if (active.length === 0) return null;
  active.sort((a, b) => sourceRank(a.source) - sourceRank(b.source));
  return active[0];
}

/** Resolve a polity's effective color at a given year, walking up its parent chain.
 *  When a polity has no direct parent active at this year, falls back to the
 *  capital-sibling cascade: any other polity active at this year sharing the
 *  same capital is treated as a sibling and we follow its cascade instead.
 *  Cycle-safe; ultimate fallback is the polity's own QID/title hash. */
export function getPolityColorAtYear(
  polity: PolityForColor,
  year: number,
  paletteId: PaletteId,
  resolve: ParentResolver,
  findCapitalSibling?: CapitalSiblingResolver,
  seen: Set<string> = new Set(),
): string {
  if (seen.has(polity.qid)) {
    return getPolityColor(polity.polityKey ?? polity.qid, polity.polityType, paletteId);
  }
  seen.add(polity.qid);
  const parent = activeParentAt(polity.parents, year);
  if (parent) {
    const parentPolity = resolve(parent.qid);
    if (parentPolity) {
      return getPolityColorAtYear(parentPolity, year, paletteId, resolve, findCapitalSibling, seen);
    }
  }
  // Capital-sibling fallback: same capital active at this year → follow its chain.
  if (findCapitalSibling && polity.capitalName) {
    const sibling = findCapitalSibling(polity.capitalName, year, polity.qid);
    if (sibling && !seen.has(sibling.qid)) {
      return getPolityColorAtYear(sibling, year, paletteId, resolve, findCapitalSibling, seen);
    }
  }
  return getPolityColor(polity.polityKey ?? polity.qid, polity.polityType, paletteId);
}
