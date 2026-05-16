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
  // Fetch the CSRF token via the SAME direct-to-Wikidata path that
  // submitClaim uses (access_token in the form body, no Authorization
  // header, origin= the page origin). MediaWiki CSRF tokens are
  // session-bound — fetching via the backend proxy would issue a token
  // for the proxy's session, and the subsequent direct-submit would
  // reject it as `badtoken`.
  const token = await getAccessToken();
  if (!token) throw new Error('Not logged in to Wikimedia');
  const body = new URLSearchParams({
    action: 'query', meta: 'tokens', format: 'json',
    access_token: token,
  });
  const res = await fetch(`${WD}?origin=${encodeURIComponent(window.location.origin)}`, {
    method: 'POST',
    body,
  });
  const data = await res.json();
  return data.query.tokens.csrftoken as string;
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

// In-memory cache for batch translation results keyed by `${qid}|${lang}`.
// Backed by localStorage so map polity-centroid labels appear instantly on
// reload without re-hitting Wikidata. Empty string ⇒ "confirmed no label
// in this language" — also cached so we never refetch known-misses.
const _batchTranslationCache = new Map<string, string>();
const _lsHydratedLangs = new Set<string>();

function _lsKey(lang: string): string { return `oh_wd_labels_${lang}`; }

function _hydrateFromLocalStorage(lang: string): void {
  if (_lsHydratedLangs.has(lang)) return;
  _lsHydratedLangs.add(lang);
  try {
    const raw = localStorage.getItem(_lsKey(lang));
    if (!raw) return;
    const obj = JSON.parse(raw) as Record<string, string>;
    for (const [qid, label] of Object.entries(obj)) {
      _batchTranslationCache.set(`${qid}|${lang}`, label);
    }
  } catch { /* corrupt entry — ignore */ }
}

function _persistToLocalStorage(lang: string): void {
  try {
    const out: Record<string, string> = {};
    const suffix = `|${lang}`;
    for (const [key, val] of _batchTranslationCache.entries()) {
      if (key.endsWith(suffix)) out[key.slice(0, -suffix.length)] = val;
    }
    localStorage.setItem(_lsKey(lang), JSON.stringify(out));
  } catch { /* quota exceeded or unavailable — ignore */ }
}

const I18N_API_BASE = import.meta.env.VITE_API_URL ? `${import.meta.env.VITE_API_URL}/api` : '/api';

export async function fetchEntityTranslations(
  qids: string[],
  lang: string,
): Promise<Record<string, string>> {
  if (lang === 'en' || qids.length === 0) return {};

  _hydrateFromLocalStorage(lang);

  const t0 = performance.now();
  const valid = qids.filter((q) => /^Q\d+$/.test(q));
  const result: Record<string, string> = {};

  // 1. Per-client cache (in-memory + localStorage hydrated above). Anything
  //    we already know — including confirmed-no-label sentinels — is served
  //    from here without a network call.
  let nFromLocal = 0;
  const need: string[] = [];
  for (const q of valid) {
    const cached = _batchTranslationCache.get(`${q}|${lang}`);
    if (cached !== undefined) {
      if (cached) result[q] = cached;     // '' ⇒ confirmed-no-label, valid hit
      nFromLocal++;
    } else {
      need.push(q);
    }
  }
  if (need.length === 0) {
    const ms = performance.now() - t0;
    console.log(`[i18n batch ${lang}] ${nFromLocal}/${valid.length} from local cache (${ms.toFixed(0)}ms), no network`);
    return result;
  }

  // 2. Server-side proxy with shared Redis cache. The backend keeps a global
  //    label cache so the first user to ask for a (lang, qid) pair pays the
  //    Wikidata cost and every other user gets it from us. We send up to
  //    ~5000 qids per call to keep request size reasonable.
  const CHUNK = 5000;
  let nFromServer = 0;
  let nFromServerCache = 0;
  let nFromServerWikidata = 0;
  for (let i = 0; i < need.length; i += CHUNK) {
    const chunk = need.slice(i, i + CHUNK);
    try {
      const res = await fetch(`${I18N_API_BASE}/wikidata-labels`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ qids: chunk, lang }),
      });
      if (!res.ok) {
        console.warn(`[i18n batch ${lang}] server returned HTTP ${res.status} — skipping this chunk`);
        continue;
      }
      const data = await res.json() as { labels: Record<string, string>; fromCache?: number; fromWikidata?: number };
      // The endpoint omits empty strings from `labels`, so any qid we asked
      // about that isn't in the response is a "confirmed no label" — cache it
      // as an empty string locally so we never re-request it for this lang.
      for (const q of chunk) {
        const label = data.labels?.[q] ?? '';
        _batchTranslationCache.set(`${q}|${lang}`, label);
        if (label) result[q] = label;
        nFromServer++;
      }
      nFromServerCache += data.fromCache ?? 0;
      nFromServerWikidata += data.fromWikidata ?? 0;
    } catch (e) {
      console.warn(`[i18n batch ${lang}] server fetch threw:`, e);
    }
  }

  // 3. Persist what we got back to localStorage so reloads are instant.
  _persistToLocalStorage(lang);
  const totalMs = performance.now() - t0;
  console.log(`[i18n batch ${lang}] done in ${(totalMs / 1000).toFixed(1)}s: ${nFromLocal} local + ${nFromServer} via server (${nFromServerCache} server-cache + ${nFromServerWikidata} fresh Wikidata)`);
  return result;
}

// ── Multi-language Wikipedia fetch ─────────────────────────────────────────

export interface TranslatedArticle {
  title: string;
  wikiTitle: string; // article title in target-language Wikipedia (for API calls)
  summary: string; // empty string if no article exists
  hasArticle: boolean;
}

// Per-(qid, lang) cache for single-article translations. Keys are
// `${qid}|${lang}`. A `null` cached value means "confirmed no result" so
// repeat clicks don't refetch.
const _articleTranslationCache = new Map<string, TranslatedArticle | null>();

export async function fetchArticleInLanguage(
  wikidataQid: string,
  lang: string,
): Promise<TranslatedArticle | null> {
  if (lang === 'en') return null; // caller handles English natively

  const cacheKey = `${wikidataQid}|${lang}`;
  if (_articleTranslationCache.has(cacheKey)) {
    return _articleTranslationCache.get(cacheKey) ?? null;
  }

  const tag = `[i18n ${wikidataQid}/${lang}]`;
  try {
    // 1. Fetch Wikidata label + sitelink for this language. `sitefilter` is the
    // correct Wikidata API param name — `sitelinkfilter` is silently ignored
    // (Wikidata returns a warning and sends ALL sitelinks, which still works
    // but bloats the response).
    const params = new URLSearchParams({
      action: 'wbgetentities',
      ids: wikidataQid,
      props: 'labels|sitelinks',
      languages: lang,
      sitefilter: `${lang}wiki`,
      format: 'json',
      origin: '*',
    });
    const wdUrl = `https://www.wikidata.org/w/api.php?${params}`;
    // One retry on 429 with a Retry-After-aware delay. Wikidata typically
    // returns 1–5s on this header; we cap the wait at 5s to avoid lockup.
    let wdRes = await fetch(wdUrl);
    if (wdRes.status === 429) {
      const retryAfterRaw = wdRes.headers.get('Retry-After');
      const waitMs = Math.min(5000, Math.max(500, Number(retryAfterRaw) * 1000 || 1500));
      console.warn(`${tag} 429 — retrying in ${waitMs}ms`);
      await new Promise((r) => setTimeout(r, waitMs));
      wdRes = await fetch(wdUrl);
    }
    if (!wdRes.ok) {
      console.warn(`${tag} wbgetentities failed: HTTP ${wdRes.status}`);
      // Don't cache the failure — let the user retry on next click.
      return null;
    }
    const wdData = await wdRes.json();
    const entity = wdData.entities?.[wikidataQid];
    if (!entity) {
      console.warn(`${tag} wbgetentities: no entity in response`, wdData);
      return null;
    }

    const label = entity.labels?.[lang]?.value as string | undefined;
    const sitelink = entity.sitelinks?.[`${lang}wiki`] as { title: string } | undefined;
    console.log(`${tag} wbgetentities ok — label=${label ?? '∅'} sitelink=${sitelink?.title ?? '∅'}`);

    if (!sitelink) {
      // No Wikipedia article in this language — return label-only stub so the
      // panel can still show the translated title.
      const labelOnly = label ? { title: label, wikiTitle: '', summary: '', hasArticle: false as const } : null;
      _articleTranslationCache.set(cacheKey, labelOnly);
      return labelOnly;
    }

    // 2. Fetch Wikipedia summary from the target language edition
    const title = encodeURIComponent(sitelink.title.replace(/ /g, '_'));
    const wpUrl = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${title}`;
    const wpRes = await fetch(wpUrl);
    if (!wpRes.ok) {
      console.warn(`${tag} summary fetch failed: HTTP ${wpRes.status} on ${wpUrl}`);
      const stub = { title: label ?? sitelink.title, wikiTitle: sitelink.title, summary: '', hasArticle: false as const };
      _articleTranslationCache.set(cacheKey, stub);
      return stub;
    }
    const wpData = await wpRes.json();

    const article: TranslatedArticle = {
      title: wpData.title ?? label ?? sitelink.title,
      wikiTitle: sitelink.title,
      summary: wpData.extract ?? '',
      hasArticle: true,
    };
    _articleTranslationCache.set(cacheKey, article);
    return article;
  } catch (e) {
    console.warn(`${tag} threw:`, e);
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
