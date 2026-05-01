/**
 * Strip common polity-type words from a name to produce a base search term.
 *
 * Examples:
 *   "Kingdom of Benin"    → "Benin"
 *   "Benin Empire"        → "Benin"
 *   "Republic of France"  → "France"
 *   "Ottoman Empire"      → "Ottoman"
 *   "Qing Dynasty"        → "Qing"
 *   "Roman Republic"      → "Roman"
 *
 * Used to seed the search box in the OHM/territory mapping modals so that
 * "Kingdom of Benin" surfaces "Benin Empire" instead of returning no matches.
 */

// Words we want to strip when they appear as either a prefix ("X of …") or a
// trailing word (" … X"). Keep this list focused on words that uniquely
// identify a polity TYPE — never general placenames.
const POLITY_TYPE_WORDS = [
  'Kingdom',
  'Empire',
  'Republic',
  'Sultanate',
  'Caliphate',
  'Principality',
  'Duchy',
  'Grand Duchy',
  'Khanate',
  'Tsardom',
  'Emirate',
  'County',
  'Confederation',
  'Confederacy',
  'Federation',
  'Dynasty',
  'State',
  'Imperial',
  'Free State',
  'People\'s Republic',
  'Provisional Government',
  'Commonwealth',
  'Viceroyalty',
  'Protectorate',
  'Mandate',
  'Colony',
  'Papacy',
  'Holy',
  'Tribe',
  'Nation',
];

/** Build alternation pattern for matching any of the polity-type words. */
const TYPE_PATTERN = POLITY_TYPE_WORDS
  .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))  // escape regex specials
  .join('|');

const PREFIX_RE = new RegExp(`^(?:${TYPE_PATTERN})\\s+(?:of\\s+)?`, 'i');
const SUFFIX_RE = new RegExp(`\\s+(?:${TYPE_PATTERN})$`, 'i');

export function stripPolityTypeWords(name: string): string {
  if (!name) return name;
  let result = name.trim();
  // Strip iteratively in case of nested patterns ("Kingdom of the Holy Empire")
  for (let i = 0; i < 3; i++) {
    const before = result;
    result = result.replace(PREFIX_RE, '').replace(SUFFIX_RE, '').trim();
    if (result === before) break;
  }
  // Also strip a leading "the " left behind (e.g. "Kingdom of the Franks" → "the Franks")
  result = result.replace(/^the\s+/i, '').trim();
  return result || name;  // never return empty
}
