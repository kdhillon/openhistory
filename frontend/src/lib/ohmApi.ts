/**
 * Browser-side OpenHistoricalMap API client.
 *
 * All calls go directly from the browser to openhistoricalmap.org/api/0.6
 * to bypass Cloudflare's bot protection (which blocks server-side requests).
 * The OAuth2 token is passed as a Bearer header.
 */

const OHM_API = 'https://www.openhistoricalmap.org/api/0.6';

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

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
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

/**
 * Create a place=country node on OHM via direct browser requests.
 *
 * Steps: create changeset → create node → close changeset.
 * All requests go directly to openhistoricalmap.org from the browser.
 */
export async function createOhmLabel(params: CreateLabelParams): Promise<CreateLabelResult> {
  const { token, name, lat, lon, startDate, endDate, wikidataQid, wikipediaTitle } = params;

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'text/xml',
  };

  // Step 1: Create changeset
  const changesetXml =
    '<osm><changeset>' +
    '<tag k="comment" v="Add historical territory label via OpenHistory"/>' +
    '<tag k="created_by" v="OpenHistory/1.0"/>' +
    '</changeset></osm>';

  const csRes = await fetch(`${OHM_API}/changeset/create`, {
    method: 'PUT',
    headers,
    body: changesetXml,
  });
  if (!csRes.ok) {
    const text = await csRes.text();
    throw new Error(`Failed to create changeset (${csRes.status}): ${text.slice(0, 200)}`);
  }
  const changesetId = parseInt(await csRes.text(), 10);

  // Step 2: Create node
  const tags = [
    '<tag k="place" v="country"/>',
    `<tag k="name" v="${xmlEscape(name)}"/>`,
    `<tag k="name:en" v="${xmlEscape(name)}"/>`,
    `<tag k="start_date" v="${xmlEscape(startDate)}"/>`,
  ];
  if (endDate) {
    tags.push(`<tag k="end_date" v="${xmlEscape(endDate)}"/>`);
  }
  if (wikidataQid) {
    tags.push(`<tag k="wikidata" v="${xmlEscape(wikidataQid)}"/>`);
  }
  if (wikipediaTitle) {
    tags.push(`<tag k="wikipedia" v="en:${xmlEscape(wikipediaTitle)}"/>`);
  }

  const nodeXml =
    `<osm><node changeset="${changesetId}" lat="${lat}" lon="${lon}">` +
    tags.join('') +
    '</node></osm>';

  const nodeRes = await fetch(`${OHM_API}/node/create`, {
    method: 'PUT',
    headers,
    body: nodeXml,
  });
  if (!nodeRes.ok) {
    const text = await nodeRes.text();
    throw new Error(`Failed to create node (${nodeRes.status}): ${text.slice(0, 200)}`);
  }
  const nodeId = parseInt(await nodeRes.text(), 10);

  // Step 3: Close changeset (non-critical)
  try {
    await fetch(`${OHM_API}/changeset/${changesetId}/close`, {
      method: 'PUT',
      headers,
    });
  } catch {
    // Auto-closes after 1h, not critical
  }

  return { nodeId, changesetId };
}
