import { useEffect, useState } from 'react';

/**
 * User-level polity color overrides (per-browser, persisted in localStorage).
 *
 * Layered on top of the file-based POLITY_COLOR_OVERRIDES in
 * `theme/polityColorOverrides.ts`:
 *
 *   user (localStorage) → file (compiled-in) → hash (deterministic fallback)
 *
 * The file is the canonical, shareable set everyone gets by default;
 * localStorage entries are the user's own adjustments — set via the InfoPanel
 * color picker on the polity type chip. To promote a user-level override to
 * a shared default, copy the (polityKey → index) pair into
 * polityColorOverrides.ts and ship it.
 *
 * Same key + value shape as the file overrides:
 *   key   = polityKey (capital QID via cascade, else polity QID, else title)
 *   value = integer index into POLITY_PALETTES[paletteId].colors
 *
 * Both lookups happen synchronously inside getPolityColor (which is invoked
 * from MapView's expression-builder hot path), so we don't cache in module
 * scope — localStorage reads are cheap and a stale cache would silently
 * drop fresh edits.
 */

const STORAGE_KEY = 'oh_polity_color_overrides_user';
const CHANGE_EVENT = 'oh-user-color-overrides-changed';

function read(): Record<string, number> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function write(map: Record<string, number>): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  // Same-tab listeners — `storage` only fires cross-tab.
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

/** Get the user's override index for a polityKey, or undefined. */
export function getUserColorOverride(polityKey: string): number | undefined {
  if (!polityKey) return undefined;
  return read()[polityKey];
}

/** Pin a polity to a specific palette index. */
export function setUserColorOverride(polityKey: string, paletteIndex: number): void {
  const cur = read();
  cur[polityKey] = paletteIndex;
  write(cur);
}

/** Remove a user-level override (the polity falls back to file → hash). */
export function clearUserColorOverride(polityKey: string): void {
  const cur = read();
  if (!(polityKey in cur)) return;
  delete cur[polityKey];
  write(cur);
}

/** Reactive read for components that need to redraw on override changes. */
export function useUserColorOverrides(): Record<string, number> {
  const [map, setMap] = useState<Record<string, number>>(() => read());
  useEffect(() => {
    const sync = () => setMap(read());
    window.addEventListener(CHANGE_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(CHANGE_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);
  return map;
}
