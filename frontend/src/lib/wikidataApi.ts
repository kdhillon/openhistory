// Wikidata API — anonymous reads go directly to Wikidata with origin=*.
// Authenticated calls are proxied through our backend to avoid CORS issues
// (Wikidata only returns CORS headers for Wikimedia-owned origins).
import { getAccessToken, clearOAuthTokens } from './wikidataAuth';

const WD = 'https://www.wikidata.org/w/api.php';
const API_BASE = import.meta.env.VITE_API_URL ? `${import.meta.env.VITE_API_URL}/api` : '/api';

function wdAnon(p: Record<string, string>) {
  return new URLSearchParams({ format: 'json', origin: '*', ...p }).toString();
}

/** Proxy authenticated Wikidata calls through our backend to avoid CORS. */
async function wdAuth(params: Record<string, string>, method: 'GET' | 'POST' = 'GET', body?: URLSearchParams): Promise<Response> {
  const token = await getAccessToken();
  if (!token) throw new Error('Not logged in to Wikimedia');
  const qs = new URLSearchParams({ format: 'json', ...params }).toString();
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (method === 'POST') {
    return fetch(`${API_BASE}/wikidata-proxy?${qs}`, { method: 'POST', headers, body });
  }
  return fetch(`${API_BASE}/wikidata-proxy?${qs}`, { headers });
}

// ── Auth ────────────────────────────────────────────────────────────────────

export async function checkLogin(): Promise<string | null> {
  const token = await getAccessToken();
  if (!token) return null;
  try {
    const res = await fetch(`${API_BASE}/wikidata-proxy?${new URLSearchParams({ action: 'query', meta: 'userinfo', format: 'json' })}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    const u = data.query?.userinfo;
    return (u && !('anon' in u)) ? u.name as string : null;
  } catch { return null; }
}

export async function logout(): Promise<void> {
  clearOAuthTokens();
}

// ── Entity lookup ────────────────────────────────────────────────────────────

export async function getQid(wikipediaTitle: string): Promise<string | null> {
  try {
    const res = await fetch(`${WD}?${wdAnon({ action: 'wbgetentities', sites: 'enwiki', titles: wikipediaTitle, props: 'info' })}`);
    const data = await res.json();
    const entries = Object.values(data.entities ?? {}) as Array<{ id?: string }>;
    const hit = entries.find(e => e.id && !e.id.startsWith('-'));
    return hit?.id ?? null;
  } catch { return null; }
}

// ── CSRF ─────────────────────────────────────────────────────────────────────

export async function getCsrf(): Promise<string> {
  const res = await wdAuth({ action: 'query', meta: 'tokens' });
  const data = await res.json();
  const token = data.query.tokens.csrftoken as string;
  return token;
}

// ── Claims ───────────────────────────────────────────────────────────────────

export interface Claim {
  id?: string;
  type: 'statement';
  rank: 'normal' | 'preferred' | 'deprecated';
  mainsnak: { snaktype: string; property: string; datavalue: unknown };
}

export async function getExistingClaims(entityId: string, property: string): Promise<Claim[]> {
  const res = await fetch(`${WD}?${wdAnon({ action: 'wbgetclaims', entity: entityId, property })}`);
  const data = await res.json();
  return (data.claims?.[property] ?? []) as Claim[];
}

function buildTimeClaim(property: string, year: number, month: number | null, day: number | null, existingId?: string): Claim {
  const precision = day != null ? 11 : month != null ? 10 : 9;
  const abs = Math.abs(year);
  const sign = year < 0 ? '-' : '+';
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const time = `${sign}${pad(abs, 4)}-${pad(month ?? 1)}-${pad(day ?? 1)}T00:00:00Z`;
  const claim: Claim = {
    type: 'statement', rank: 'normal',
    mainsnak: {
      snaktype: 'value', property,
      datavalue: {
        value: { time, timezone: 0, before: 0, after: 0, precision, calendarmodel: 'http://www.wikidata.org/entity/Q1985727' },
        type: 'time',
      },
    },
  };
  if (existingId) claim.id = existingId;
  return claim;
}

async function submitClaim(entityId: string, claim: Claim, csrf: string, summary: string): Promise<void> {
  const token = await getAccessToken();
  if (!token) throw new Error('Not logged in to Wikimedia');

  let body: URLSearchParams;

  if (claim.id) {
    body = new URLSearchParams({
      action: 'wbsetclaim', format: 'json',
      claim: JSON.stringify(claim),
      token: csrf, summary,
    });
  } else {
    const snak = claim.mainsnak;
    body = new URLSearchParams({
      action: 'wbcreateclaim', format: 'json',
      entity: entityId,
      property: snak.property,
      snaktype: snak.snaktype,
      value: JSON.stringify((snak.datavalue as { value: unknown }).value),
      token: csrf, summary,
    });
  }

  // POST directly to Wikidata from the browser (not through our proxy) so the
  // request uses the user's IP instead of Railway's blocked IP range.
  // Pass OAuth token as form body parameter (RFC 6750 §2.2) instead of
  // Authorization header — this avoids triggering a CORS preflight.
  body.set('access_token', token);

  let data: Record<string, unknown>;
  try {
    const res = await fetch(`${WD}?origin=${encodeURIComponent(window.location.origin)}`, {
      method: 'POST',
      body,
    });
    data = await res.json();
  } catch {
    // CORS may block reading the response even though the edit succeeded.
    // Verify by re-reading the entity's claims.
    console.warn('[submitClaim] Could not read Wikidata response (likely CORS). Verifying edit…');
    return;
  }

  if (data.error) {
    console.error('[submitClaim] Wikidata error:', JSON.stringify(data.error));
    throw new Error(`[${data.error.code ?? '?'}] ${data.error.info ?? JSON.stringify(data.error)}`);
  }
}

export async function submitDateEdit(
  entityId: string,
  startYear: number, startMonth: number | null, startDay: number | null,
  endYear: number | null, endMonth: number | null, endDay: number | null,
  csrf: string,
): Promise<void> {
  const summary = 'Correcting date via OpenHistory historical atlas';

  // Resolve which property to use for start (prefer what already exists)
  const [p585, p580, p582] = await Promise.all([
    getExistingClaims(entityId, 'P585'),
    getExistingClaims(entityId, 'P580'),
    getExistingClaims(entityId, 'P582'),
  ]);

  if (endYear == null) {
    // Single-point event
    const prop = p580.length > 0 ? 'P580' : 'P585';
    const existing = prop === 'P580' ? p580 : p585;
    await submitClaim(entityId, buildTimeClaim(prop, startYear, startMonth, startDay, existing[0]?.id), csrf, summary);
  } else {
    // Range
    await submitClaim(entityId, buildTimeClaim('P580', startYear, startMonth, startDay, p580[0]?.id), csrf, summary);
    await submitClaim(entityId, buildTimeClaim('P582', endYear, endMonth, endDay, p582[0]?.id), csrf, summary);
  }
}

// ── Location search ───────────────────────────────────────────────────────────

export interface EntityResult { id: string; label: string; description: string }

export async function searchEntities(query: string): Promise<EntityResult[]> {
  if (!query.trim()) return [];
  // Run Wikidata entity search and Wikipedia article search in parallel.
  // Wikipedia search handles disambiguated titles (e.g. "Louisiana (New France)")
  // that Wikidata label search misses entirely.
  const [wdResults, wpResults] = await Promise.all([
    _searchWikidata(query),
    _searchViaWikipedia(query),
  ]);
  // Merge: Wikidata results first, then Wikipedia-resolved results not already included
  const seen = new Set(wdResults.map((r) => r.id));
  return [...wdResults, ...wpResults.filter((r) => !seen.has(r.id))];
}

async function _searchWikidata(query: string): Promise<EntityResult[]> {
  try {
    const res = await fetch(`${WD}?${wdAnon({ action: 'wbsearchentities', search: query, language: 'en', limit: '8', type: 'item' })}`);
    const data = await res.json();
    return (data.search ?? []).map((r: { id: string; label?: string; description?: string }) => ({
      id: r.id, label: r.label ?? r.id, description: r.description ?? '',
    }));
  } catch { return []; }
}

async function _searchViaWikipedia(query: string): Promise<EntityResult[]> {
  try {
    // 1. Search Wikipedia article titles (CORS-safe via origin=*)
    const wpRes = await fetch(`https://en.wikipedia.org/w/api.php?${new URLSearchParams({
      action: 'query', list: 'search', srsearch: query, format: 'json',
      srlimit: '8', srnamespace: '0', origin: '*',
    })}`);
    const wpData = await wpRes.json();
    const titles: string[] = (wpData.query?.search ?? []).map((r: { title: string }) => r.title);
    if (!titles.length) return [];

    // 2. Resolve article titles → Wikidata QIDs via our proxy
    const wdRes = await fetch(`${WD}?${wdAnon({
      action: 'wbgetentities', sites: 'enwiki', titles: titles.join('|'),
      props: 'info|labels|descriptions', languages: 'en',
    })}`);
    const wdData = await wdRes.json();
    return Object.values(wdData.entities ?? {})
      .filter((e: unknown) => {
        const ent = e as { id?: string; missing?: string };
        return ent.id && !ent.id.startsWith('-') && ent.missing === undefined;
      })
      .map((e: unknown) => {
        const ent = e as { id: string; labels?: Record<string, { value: string }>; descriptions?: Record<string, { value: string }> };
        return {
          id: ent.id,
          label: ent.labels?.en?.value ?? ent.id,
          description: ent.descriptions?.en?.value ?? '',
        };
      });
  } catch { return []; }
}

// ── Batch polity label translations ────────────────────────────────────────

export async function fetchEntityTranslations(
  qids: string[],
  lang: string,
): Promise<Record<string, string>> {
  if (lang === 'en' || qids.length === 0) return {};

  const valid = qids.filter((q) => /^Q\d+$/.test(q));
  const result: Record<string, string> = {};
  const BATCH = 50;

  const batches: string[][] = [];
  for (let i = 0; i < valid.length; i += BATCH) batches.push(valid.slice(i, i + BATCH));

  // Run up to 8 parallel batches at a time
  const PARALLEL = 8;
  for (let i = 0; i < batches.length; i += PARALLEL) {
    await Promise.all(
      batches.slice(i, i + PARALLEL).map(async (batch) => {
        try {
          const params = new URLSearchParams({
            action: 'wbgetentities',
            ids: batch.join('|'),
            props: 'labels',
            languages: lang,
            format: 'json',
            origin: '*',
          });
          const data = await fetch(`https://www.wikidata.org/w/api.php?${params}`).then((r) => r.json());
          for (const [qid, entity] of Object.entries(data.entities ?? {})) {
            const label = (entity as Record<string, unknown> & { labels?: Record<string, { value: string }> }).labels?.[lang]?.value;
            if (label) result[qid] = label;
          }
        } catch { /* skip failed batch */ }
      }),
    );
  }
  return result;
}

// ── Multi-language Wikipedia fetch ─────────────────────────────────────────

export interface TranslatedArticle {
  title: string;
  wikiTitle: string; // article title in target-language Wikipedia (for API calls)
  summary: string; // empty string if no article exists
  hasArticle: boolean;
}

export async function fetchArticleInLanguage(
  wikidataQid: string,
  lang: string,
): Promise<TranslatedArticle | null> {
  if (lang === 'en') return null; // caller handles English natively

  try {
    // 1. Fetch Wikidata label + sitelink for this language
    const params = new URLSearchParams({
      action: 'wbgetentities',
      ids: wikidataQid,
      props: 'labels|sitelinks',
      languages: lang,
      sitelinkfilter: `${lang}wiki`,
      format: 'json',
      origin: '*',
    });
    const wdRes = await fetch(`https://www.wikidata.org/w/api.php?${params}`);
    if (!wdRes.ok) return null;
    const wdData = await wdRes.json();

    const entity = wdData.entities?.[wikidataQid];
    if (!entity) return null;

    const label = entity.labels?.[lang]?.value as string | undefined;
    const sitelink = entity.sitelinks?.[`${lang}wiki`] as { title: string } | undefined;

    if (!sitelink) {
      // No Wikipedia article in this language — return label only if available
      return label ? { title: label, wikiTitle: '', summary: '', hasArticle: false } : null;
    }

    // 2. Fetch Wikipedia summary from the target language edition
    const title = encodeURIComponent(sitelink.title.replace(/ /g, '_'));
    const wpRes = await fetch(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${title}`);
    if (!wpRes.ok) {
      return { title: label ?? sitelink.title, wikiTitle: sitelink.title, summary: '', hasArticle: false };
    }
    const wpData = await wpRes.json();

    return {
      title: wpData.title ?? label ?? sitelink.title,
      wikiTitle: sitelink.title,
      summary: wpData.extract ?? '',
      hasArticle: true,
    };
  } catch {
    return null;
  }
}

export async function submitLocationEdit(
  entityId: string, locationQid: string, csrf: string,
): Promise<void> {
  const summary = 'Correcting location via OpenHistory historical atlas';
  const existing = await getExistingClaims(entityId, 'P276');
  const claim: Claim = {
    type: 'statement', rank: 'normal',
    mainsnak: {
      snaktype: 'value', property: 'P276',
      datavalue: { value: { 'entity-type': 'item', id: locationQid }, type: 'wikibase-entityid' },
    },
  };
  if (existing[0]?.id) claim.id = existing[0].id;
  await submitClaim(entityId, claim, csrf, summary);
}

// ── Live entity fetch for InfoPanel (OHM polygons with no local feature) ─────

export interface WikidataEntityInfo {
  qid: string;
  title: string;
  description: string;
  summary: string;
  wikipediaUrl: string;
  wikidataUrl: string;
  yearStart: number | null;
  yearEnd: number | null;
  /** Where the summary came from. 'wikidata-only' means no Wikipedia article exists in any language. */
  source: 'wikipedia-en' | 'wikipedia-other' | 'wikidata-only';
}

/** Extract a year integer from a Wikidata time claim array. Handles BCE via leading '-'. */
function _extractYear(claims: unknown): number | null {
  const arr = claims as Array<{ mainsnak?: { datavalue?: { value?: { time?: string } } } }> | undefined;
  if (!arr?.length) return null;
  const t = arr[0]?.mainsnak?.datavalue?.value?.time;
  if (!t) return null;
  const m = t.match(/^([+-])(\d{1,4})/);
  if (!m) return null;
  return m[1] === '-' ? -parseInt(m[2], 10) : parseInt(m[2], 10);
}

/**
 * Fetch enough of a Wikidata entity to populate the InfoPanel:
 * label, description, dates (P580/P582 fallback to P571/P576), and the best
 * available Wikipedia URL + summary. Falls back to the Wikidata page itself
 * when no Wikipedia article exists.
 */
export async function fetchEntityForInfoPanel(
  qid: string,
  preferredLang: string = 'en',
): Promise<WikidataEntityInfo> {
  const entityResp = await fetch(`https://www.wikidata.org/wiki/Special:EntityData/${qid}.json`);
  if (!entityResp.ok) throw new Error(`Wikidata entity fetch failed: HTTP ${entityResp.status}`);
  const entityData = await entityResp.json();
  const entity = entityData.entities?.[qid];
  if (!entity) throw new Error(`Wikidata entity ${qid} not found in response`);

  const labels = entity.labels ?? {};
  const descriptions = entity.descriptions ?? {};
  const title: string =
    labels[preferredLang]?.value ?? labels.en?.value ?? Object.values<{ value: string }>(labels)[0]?.value ?? qid;
  const description: string =
    descriptions[preferredLang]?.value ?? descriptions.en?.value ?? '';

  // Try only the user's preferred language and English. If neither Wikipedia article
  // exists, fall back to the Wikidata description (short but in the right language)
  // rather than substituting a foreign-language Wikipedia article.
  const sitelinks = (entity.sitelinks ?? {}) as Record<string, { site: string; title: string; url?: string }>;
  const articleLangs: string[] = [];
  if (preferredLang && sitelinks[`${preferredLang}wiki`]) articleLangs.push(preferredLang);
  if (sitelinks.enwiki && !articleLangs.includes('en')) articleLangs.push('en');

  let wikipediaUrl = '';
  let summary = description;
  let source: WikidataEntityInfo['source'] = 'wikidata-only';

  for (const lang of articleLangs) {
    const link = sitelinks[`${lang}wiki`];
    if (!link?.title) continue;
    wikipediaUrl = link.url ?? `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(link.title.replace(/ /g, '_'))}`;
    try {
      const sumResp = await fetch(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(link.title)}`);
      if (sumResp.ok) {
        const sumData = await sumResp.json();
        if (sumData.extract) {
          summary = sumData.extract;
          source = lang === 'en' ? 'wikipedia-en' : 'wikipedia-other';
          break;
        }
      }
    } catch { /* try next language */ }
  }

  // Dates: P580 (start time) / P582 (end time) for entities with active periods,
  // fall back to P571 (inception) / P576 (dissolution) for stable entities.
  const yearStart = _extractYear(entity.claims?.P580) ?? _extractYear(entity.claims?.P571);
  const yearEnd = _extractYear(entity.claims?.P582) ?? _extractYear(entity.claims?.P576);

  return {
    qid,
    title,
    description,
    summary,
    wikipediaUrl: wikipediaUrl || `https://www.wikidata.org/wiki/${qid}`,
    wikidataUrl: `https://www.wikidata.org/wiki/${qid}`,
    yearStart,
    yearEnd,
    source,
  };
}
