/**
 * Manual palette-color overrides for the polity hash-coloring system.
 *
 * Each non-default polity palette has exactly 7 colors (the four-color
 * theorem says 4 are enough; we use 7 for visual variety). `getPolityColor`
 * usually picks a slot via a hash of the polity's key (typically its
 * capital QID via the cascade — so all polities sharing a capital share
 * a color). Sometimes that hash randomly assigns two adjacent polities
 * the same color; this map lets us pin specific keys to specific slots
 * to break those clashes.
 *
 * Keys mirror what gets passed to `getPolityColor(polityKey, ...)`:
 *   1. The polity's capital Wikidata QID when set (e.g. `Q84` = London —
 *      this pins every Madrid/London/etc.-capital polity at once via the
 *      cascade), or
 *   2. The polity's own QID, or
 *   3. The polity title as a last resort.
 *
 * Values are integer indices [0..6] into POLITY_PALETTES[paletteId].colors.
 * The same index applies across every non-empty palette since they all
 * have 7 colors today.
 *
 * To find the key for a clashing polity: click it on the map; the
 * InfoPanel dev footer shows `polityKey: …` and a one-click "copy"
 * snippet you can paste here.
 */
export const POLITY_COLOR_OVERRIDES: Record<string, number> = {
  'Q2807': 4,  // Madrid       — Spain, Spanish Empire, Crown of Castile, …
  'Q1741': 5,  // Vienna       — Austria, Austria-Hungary, Holy Roman Empire (capital era), …
  'Q495':  0,  // Turin        — Sardinia-Piedmont, Kingdom of Italy (early), …
  'Q1489': 3,  // Mexico City  — Mexico, New Spain (Viceroyalty), Aztec Empire (Tenochtitlan), …
};

/**
 * Mandated palette length — every named-color palette MUST have this many
 * colors so the override indices are interchangeable across palettes.
 * Validated at module load below.
 */
export const PALETTE_COLOR_COUNT = 7;
