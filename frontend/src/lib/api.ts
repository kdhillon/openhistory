/**
 * OurStory API client.
 *
 * In development, Vite proxies /api → http://localhost:8000
 * In production, /api should point to the same origin or a configured backend.
 */

const API_BASE = '/api';

export interface FeaturePatch {
  // Date fields — send null to clear
  year_start?: number | null;
  month_start?: number | null;
  day_start?: number | null;
  year_end?: number | null;
  month_end?: number | null;
  day_end?: number | null;
  // Location fields
  location_name?: string | null;
  location_wikidata_qid?: string | null;
}

/**
 * Persist a user correction to Postgres.
 * Returns the updated GeoJSON feature (with fresh coordinates from DB join).
 * Throws on network error or non-2xx response.
 */
export async function patchFeature(eventId: string, patch: FeaturePatch): Promise<GeoJSON.Feature> {
  const res = await fetch(`${API_BASE}/features/${eventId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API PATCH failed (${res.status}): ${text}`);
  }
  return res.json();
}

/**
 * Fetch all manually-edited events since the last GeoJSON generation.
 * Returns a FeatureCollection to merge over the static seed.geojson.
 */
export async function fetchOverrides(): Promise<GeoJSON.FeatureCollection> {
  const res = await fetch(`${API_BASE}/features/overrides`);
  if (!res.ok) throw new Error(`API GET overrides failed (${res.status})`);
  return res.json();
}
