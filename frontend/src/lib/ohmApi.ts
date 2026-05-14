/**
 * OpenHistoricalMap API client.
 *
 * The actual API calls happen server-side because OHM does not send CORS
 * headers for /api/0.6/. The browser holds the OAuth2 token (in localStorage)
 * and forwards it to our backend, which proxies the request to OHM.
 */

const API_BASE = import.meta.env.VITE_API_URL ? `${import.meta.env.VITE_API_URL}/api` : '/api';

const OHM_TOKEN_KEY = 'ohm_access_token';

export function getOhmToken(): string | null {
  return localStorage.getItem(OHM_TOKEN_KEY);
}

export function setOhmToken(token: string): void {
  localStorage.setItem(OHM_TOKEN_KEY, token);
}

export function clearOhmToken(): void {
  localStorage.removeItem(OHM_TOKEN_KEY);
}

/** Check URL hash for ohm_token= (set after OAuth redirect) and store it. */
export function extractOhmTokenFromHash(): string | null {
  const hash = window.location.hash;
  const match = hash.match(/ohm_token=([^&]+)/);
  if (match) {
    const token = match[1];
    setOhmToken(token);
    // Clean the hash
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    return token;
  }
  return null;
}

interface CreateLabelParams {
  token: string;
  name: string;
  lat: number;
  lon: number;
  startDate: string;
  endDate?: string | null;
  wikidataQid?: string | null;
  wikipediaTitle?: string | null;
}

interface CreateLabelResult {
  nodeId: number;
  changesetId: number;
}

export interface UpdateElementParams {
  token: string;
  osmType: 'relation' | 'node' | 'way';
  osmId: number;
  setTags: Record<string, string>;
  comment?: string;
}

export interface UpdateElementResult {
  changesetId: number;
  osmType: 'relation' | 'node' | 'way';
  osmId: number;
  newVersion: number | null;
}

/**
 * Add or update tags on an existing OHM element (relation/node/way).
 * Used by the territory mapping modal to push wikidata/wikipedia tags onto
 * an element that's missing them.
 */
export async function updateOhmElement(params: UpdateElementParams): Promise<UpdateElementResult> {
  const { token, osmType, osmId, setTags, comment } = params;
  const res = await fetch(`${API_BASE}/ohm/update-element`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      accessToken: token,
      osmType,
      osmId,
      setTags,
      comment,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OHM update failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return res.json();
}

export interface UpdateElementsParams {
  token: string;
  comment?: string;
  edits: Array<{
    osmType: 'relation' | 'node' | 'way';
    osmId: number;
    setTags: Record<string, string>;
  }>;
}

export interface UpdateElementsResult {
  changesetId: number;
  count: number;
  results: Array<{
    osmType: 'relation' | 'node' | 'way';
    osmId: number;
    newVersion: number | null;
  }>;
}

/**
 * Bundle multiple OHM tag edits into a single OSM changeset. Used by the
 * pending-changes panel to publish all queued edits at once, avoiding
 * changeset-list spam on OHM.
 */
export async function updateOhmElements(params: UpdateElementsParams): Promise<UpdateElementsResult> {
  const { token, comment, edits } = params;
  const res = await fetch(`${API_BASE}/ohm/update-elements`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessToken: token, comment, edits }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OHM batch update failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return res.json();
}

/**
 * Create a place=country node on OHM via our backend proxy.
 * Backend uses the user's OAuth Bearer token to authenticate to OHM.
 */
export async function createOhmLabel(params: CreateLabelParams): Promise<CreateLabelResult> {
  const { token, name, lat, lon, startDate, endDate, wikidataQid, wikipediaTitle } = params;

  const res = await fetch(`${API_BASE}/ohm/create-label`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      accessToken: token,
      name,
      lat,
      lon,
      startDate,
      endDate,
      wikidataQid,
      wikipediaTitle,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Create label failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return res.json();
}
