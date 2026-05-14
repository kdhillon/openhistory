import { useState, useMemo, useRef, useEffect } from 'react';
import type { FeatureProperties } from '../types';
import { importPolityFromWikidata } from '../lib/api';
import { searchEntities } from '../lib/wikidataApi';
import type { EntityResult } from '../lib/wikidataApi';
import { stripPolityTypeWords } from '../lib/polityNames';
import { getOhmToken } from '../lib/ohmApi';
import { addPendingEdit } from '../lib/pendingOhmEdits';

const API_BASE = import.meta.env.VITE_API_URL ? `${import.meta.env.VITE_API_URL}/api` : '/api';

interface Props {
  ohmName: string;
  ohmWikidataQid: string | null;
  yearStart?: number | null;
  yearEnd?: number | null;
  osmType: 'relation' | 'node';
  osmId: number;
  polities: FeatureProperties[];
  onClose: () => void;
  onPolityImported?: (feature: GeoJSON.Feature) => void;
}

function overlapsRange(p: FeatureProperties, intervalStart: number | null | undefined, intervalEnd: number | null | undefined): boolean {
  if (intervalStart == null) return true;  // no range info → don't filter
  const ps = p.yearStart ?? -9999;
  const pe = p.yearEnd ?? 9999;
  const ie = intervalEnd ?? 9999;
  return !(ps > ie || pe < intervalStart);
}

function btnStyle(bg: string, disabled = false): React.CSSProperties {
  return {
    background: disabled ? '#223' : bg,
    color: disabled ? '#556' : '#e8eaf0',
    border: 'none', borderRadius: 4,
    padding: '5px 12px', fontSize: 12, fontWeight: 600,
    cursor: disabled ? 'default' : 'pointer', fontFamily: 'inherit',
  };
}

export function OhmMappingModal({ ohmName, ohmWikidataQid, yearStart, yearEnd, osmType, osmId, polities, onClose, onPolityImported }: Props) {
  const [query, setQuery]               = useState(() => stripPolityTypeWords(ohmName));
  const [selectedId, setSelectedId]     = useState<string | null>(null);
  const [status, setStatus]             = useState<'idle' | 'queued' | 'opened' | 'error'>('idle');
  const [errorMsg, setErrorMsg]         = useState<string | null>(null);
  const [ohmToken, setOhmToken] = useState<string | null>(() => getOhmToken());

  const [wdResults, setWdResults]       = useState<EntityResult[]>([]);
  const [wdLoading, setWdLoading]       = useState(false);
  const [wdOpen, setWdOpen]             = useState(true);
  const [importingQid, setImportingQid] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (window.innerWidth >= 640) inputRef.current?.focus(); }, []);

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    const matches = q
      ? polities.filter((p) => {
          if (p.title.toLowerCase().includes(q)) return true;
          const aliases = (p.aliases as string[] | undefined) ?? [];
          return aliases.some((a) => a.toLowerCase().includes(q));
        })
      : polities;
    const overlaps = matches
      .filter((p) => overlapsRange(p, yearStart, yearEnd))
      .sort((a, b) => {
        const lifeA = (a.yearStart != null && a.yearEnd != null) ? a.yearEnd - a.yearStart : Infinity;
        const lifeB = (b.yearStart != null && b.yearEnd != null) ? b.yearEnd - b.yearStart : Infinity;
        return lifeA - lifeB;
      });
    const outside = matches.filter((p) => !overlapsRange(p, yearStart, yearEnd));
    return [...overlaps, ...outside].slice(0, 40);
  }, [query, polities, yearStart, yearEnd]);

  const existingQids = useMemo(() => new Set(polities.map((p) => p.wikidataQid).filter(Boolean)), [polities]);

  useEffect(() => {
    if (!wdOpen) return;
    let cancelled = false;
    setWdLoading(true);
    setWdResults([]);
    searchEntities(query.trim() || ohmName)
      .then((r) => { if (!cancelled) setWdResults(r.filter((x) => !existingQids.has(x.id))); })
      .catch(() => { if (!cancelled) setWdResults([]); })
      .finally(() => { if (!cancelled) setWdLoading(false); });
    return () => { cancelled = true; };
  }, [query, wdOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  // Queue the polity's wikidata (and wikipedia) tag for later publish. The
  // user reviews all queued edits in the pending-changes panel and publishes
  // them as a single OSM changeset — keeps OHM's changeset list tidy.
  function handleQueueEdit(polity?: FeatureProperties) {
    const p = polity ?? polities.find((x) => x.id === selectedId);
    if (!p) return;
    const qid = p.wikidataQid;
    if (!qid) {
      setStatus('error');
      setErrorMsg(`${p.title} has no Wikidata QID in our database — pick a different polity or import one from Wikipedia below.`);
      return;
    }
    setErrorMsg(null);
    const tags: Record<string, string> = { wikidata: qid };
    if (p.wikipediaTitle) {
      tags.wikipedia = `en:${p.wikipediaTitle}`;
    }
    addPendingEdit({
      osmType,
      osmId,
      setTags: tags,
      displayName: p.title,
      polityQid: qid,
      comment: `Link to ${p.title} (${qid}) via OpenHistory`,
      addedAt: Date.now(),
    });
    setStatus('queued');
  }

  // Fallback path: copy the polity's wikidata QID to the clipboard and deep-link
  // to OHM's iD editor. Works for everyone (no auth needed). User pastes the QID
  // into the wikidata field in iD and saves.
  //
  // Two URL parts:
  //  • `?{type}={id}` — selects the element if our type guess matches. The frontend
  //    type comes from the click site; it's reliable for polygon clicks but unreliable
  //    for centroid-label clicks (label points carry the underlying RELATION's id,
  //    not a node's, despite being rendered from a point layer).
  //  • `#map=zoom/lat/lng` — always present, so iD lands at the user's current map
  //    view regardless of whether the element-select succeeds. Without this, iD
  //    defaults to world view when the element ID can't be resolved.
  async function handleOpenInOhm(polity?: FeatureProperties) {
    const p = polity ?? polities.find((x) => x.id === selectedId);
    if (!p) return;
    const qid = p.wikidataQid;
    if (!qid) {
      setStatus('error');
      setErrorMsg(`${p.title} has no Wikidata QID in our database — pick a different polity or import one from Wikipedia below.`);
      return;
    }
    setErrorMsg(null);
    try { await navigator.clipboard.writeText(qid); } catch { /* clipboard blocked — user can copy from the success card */ }
    const zoom = Math.max(13, Math.round(Number(localStorage.getItem('oh-map-zoom') ?? '5')));
    const lat = Number(localStorage.getItem('oh-map-lat') ?? '30').toFixed(4);
    const lng = Number(localStorage.getItem('oh-map-lng') ?? '0').toFixed(4);
    // Centroid-label clicks almost always carry a relation id; if our frontend tagged
    // it 'node' from the sign-convention heuristic, override to 'relation' so iD has
    // a better chance of selecting the element.
    const effectiveType = osmType === 'node' ? 'relation' : osmType;
    const url = `https://www.openhistoricalmap.org/edit?${effectiveType}=${osmId}#map=${zoom}/${lat}/${lng}`;
    window.open(url, '_blank', 'noopener,noreferrer');
    setStatus('opened');
  }

  async function handleSignInToOhm() {
    try {
      const r = await fetch(`${API_BASE}/ohm/auth-url`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      if (!data.url) {
        setStatus('error');
        setErrorMsg('Backend returned no auth URL.');
        return;
      }
      window.open(data.url, '_blank', 'noopener,noreferrer');
    } catch (e) {
      setStatus('error');
      setErrorMsg(`Sign-in failed: ${(e as Error).message}`);
    }
  }

  // Refresh the token from localStorage whenever it might have changed.
  // The OAuth flow opens a second tab that writes the token; cross-tab `storage`
  // events fire but can be unreliable (browser quirks, popup blockers, fast tab
  // close). Belt-and-suspenders: also re-check on focus and on a 1s poll.
  useEffect(() => {
    const sync = () => {
      const fresh = getOhmToken();
      setOhmToken((prev) => (prev === fresh ? prev : fresh));
    };
    window.addEventListener('storage', sync);
    window.addEventListener('focus', sync);
    const interval = setInterval(sync, 1000);
    return () => {
      window.removeEventListener('storage', sync);
      window.removeEventListener('focus', sync);
      clearInterval(interval);
    };
  }, []);

  async function handleImport(r: EntityResult) {
    setImportingQid(r.id);
    try {
      const feature = await importPolityFromWikidata(r.id);
      onPolityImported?.(feature);
      const props = feature.properties as FeatureProperties;
      setSelectedId(props.id);
    } catch (e) {
      console.error('Import failed:', e);
    } finally {
      setImportingQid(null);
    }
  }

  const overlay: React.CSSProperties = {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 2000,
  };

  const card: React.CSSProperties = {
    background: '#1e2433', color: '#e8eaf0', borderRadius: 10,
    width: 480, maxWidth: '95vw', padding: '20px 22px 18px',
    boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
    display: 'flex', flexDirection: 'column', gap: 14,
    position: 'relative',
    ...((status === 'queued' || status === 'opened')
      ? { height: 'auto' }
      : { height: 'calc(100vh - 120px)', maxHeight: 780 }),
    overflow: 'hidden',
  };

  return (
    <div style={overlay} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={card}>

        {/* Header */}
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, color: '#8899bb', marginBottom: 3 }}>Add Wikidata QID to OHM</div>
              <div style={{ fontSize: 17, fontWeight: 600 }}>{ohmName}</div>
              {(yearStart != null) && (
                <div style={{ fontSize: 12, color: '#8899bb', marginTop: 3 }}>
                  {yearStart}–{yearEnd ?? '∞'}
                </div>
              )}
              <div style={{ fontSize: 10, color: '#445', marginTop: 4, fontFamily: 'monospace' }}>{osmType}/{osmId}</div>
            </div>
            {ohmToken ? (
              <span style={{ fontSize: 10, color: '#66bb6a', padding: '2px 8px', border: '1px solid #2d5a3a', borderRadius: 4, whiteSpace: 'nowrap', flexShrink: 0 }}>OHM signed in</span>
            ) : (
              <button
                onClick={handleSignInToOhm}
                style={{ ...btnStyle('#3a4560'), padding: '4px 10px', fontSize: 11, flexShrink: 0 }}
                title="Sign in to OpenHistoricalMap to publish tag edits"
              >Sign in to OHM</button>
            )}
          </div>
          {ohmWikidataQid ? (
            <div style={{ fontSize: 11, color: '#778', marginTop: 6 }}>OHM already has <code>{ohmWikidataQid}</code> — confirm it matches the polity you want, or pick a replacement below.</div>
          ) : (
            <div style={{ fontSize: 11, color: '#778', marginTop: 6 }}>This element has no Wikidata tag in OHM. Pick the matching polity to queue a <code>wikidata=Q…</code> (and <code>wikipedia=…</code>) tag edit. Pending edits get bundled into a single OHM changeset when you publish.</div>
          )}
        </div>

        {status === 'queued' ? (
          <div style={{ textAlign: 'center', padding: '14px 4px' }}>
            <div style={{ color: '#66bb6a', fontSize: 15, marginBottom: 8 }}>✓ Added to pending changes</div>
            <div style={{ color: '#8899bb', fontSize: 12, lineHeight: 1.5, marginBottom: 12 }}>
              Queued tag edit on <code>{osmType}/{osmId}</code>. Review and publish all your pending edits as a single OHM changeset from the badge at the bottom of the screen.
            </div>
            <button onClick={onClose} style={btnStyle('#3a4560')}>Close</button>
          </div>
        ) : status === 'opened' ? (
          <div style={{ textAlign: 'center', padding: '14px 4px' }}>
            <div style={{ color: '#66bb6a', fontSize: 15, marginBottom: 8 }}>✓ OHM editor opened in a new tab</div>
            <div style={{ color: '#8899bb', fontSize: 12, lineHeight: 1.5, marginBottom: 12 }}>
              QID copied to your clipboard. In iD, click the <code>wikidata</code> field on this element and paste, then Save.
              The map will recolor once OHM's tile cache refreshes.
            </div>
            <button onClick={onClose} style={btnStyle('#3a4560')}>Close</button>
          </div>
        ) : (
          <>
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => { setQuery(e.target.value); setSelectedId(null); }}
              placeholder="Search polities…"
              style={{
                background: '#11172a', border: '1px solid #3a4560', borderRadius: 6,
                color: '#e8eaf0', padding: '8px 10px', fontSize: 16, outline: 'none', width: '100%',
                boxSizing: 'border-box',
              }}
            />

            <div style={{ overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10, flex: 1, minHeight: 0 }}>
              {/* Local polity results */}
              <div style={{ border: '1px solid #2a3450', borderRadius: 6, background: '#11172a', flexShrink: 0 }}>
                {filtered.length === 0 && (
                  <div style={{ padding: '10px 12px', color: '#556', fontSize: 13 }}>No local matches</div>
                )}
                {filtered.map((p) => {
                  const dimmed = !overlapsRange(p, yearStart, yearEnd);
                  return (
                  <div
                    key={p.id}
                    onClick={() => setSelectedId(p.id)}
                    onDoubleClick={() => { setSelectedId(p.id); handleQueueEdit(p); }}
                    style={{
                      padding: '8px 12px', cursor: 'pointer', borderBottom: '1px solid #1e2a3e',
                      background: p.id === selectedId ? '#2a3a5a' : 'transparent',
                      display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
                      opacity: dimmed ? 0.4 : 1,
                    }}
                  >
                    <a
                      href={p.wikipediaUrl || `https://en.wikipedia.org/wiki/${p.title.replace(/ /g, '_')}`}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      style={{ fontSize: 13, color: '#e8eaf0', textDecoration: 'none' }}
                      onMouseEnter={(e) => (e.currentTarget.style.textDecoration = 'underline')}
                      onMouseLeave={(e) => (e.currentTarget.style.textDecoration = 'none')}
                    >{p.title}</a>
                    <span style={{ fontSize: 11, color: '#778', marginLeft: 10, whiteSpace: 'nowrap' }}>
                      {p.yearStart ?? '?'}–{p.yearEnd ?? '∞'}
                      {p.polityType ? ` · ${p.polityType}` : ''}
                    </span>
                  </div>
                  );
                })}
              </div>

              {/* Wikipedia / Wikidata results */}
              {!wdOpen ? (
                <button
                  onClick={() => setWdOpen(true)}
                  style={{
                    background: 'none', border: '1px solid #2a3450', borderRadius: 6,
                    color: '#8899bb', fontSize: 12, padding: '7px 12px',
                    cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left',
                  }}
                >
                  See More — search Wikipedia
                </button>
              ) : (
                <div style={{ flexShrink: 0 }}>
                  <div style={{
                    fontSize: 11, fontWeight: 600, letterSpacing: '0.06em',
                    textTransform: 'uppercase', color: '#556', marginBottom: 6,
                  }}>
                    From Wikipedia {wdLoading && <span style={{ color: '#445', fontWeight: 400 }}>· searching…</span>}
                  </div>
                  {!wdLoading && wdResults.length === 0 && (
                    <div style={{ fontSize: 12, color: '#556', padding: '6px 0' }}>No results found.</div>
                  )}
                  {wdResults.length > 0 && (
                    <div style={{ border: '1px solid #2a3450', borderRadius: 6, background: '#11172a' }}>
                      {wdResults.map((r) => (
                        <div
                          key={r.id}
                          style={{
                            padding: '8px 12px', borderBottom: '1px solid #1e2a3e',
                            display: 'flex', alignItems: 'baseline', gap: 8,
                          }}
                        >
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <a
                              href={`https://en.wikipedia.org/wiki/${r.label.replace(/ /g, '_')}`}
                              target="_blank"
                              rel="noreferrer"
                              style={{ fontSize: 13, color: '#e8eaf0', textDecoration: 'none' }}
                              onMouseEnter={(e) => (e.currentTarget.style.textDecoration = 'underline')}
                              onMouseLeave={(e) => (e.currentTarget.style.textDecoration = 'none')}
                            >
                              {r.label}
                            </a>
                            {r.description && (
                              <span style={{ fontSize: 11, color: '#667', marginLeft: 8 }}>{r.description}</span>
                            )}
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                            <span style={{ fontSize: 10, color: '#445' }}>{r.id}</span>
                            <button
                              onClick={() => handleImport(r)}
                              disabled={importingQid === r.id}
                              style={btnStyle('#2a5a3a', importingQid === r.id)}
                            >
                              {importingQid === r.id ? 'Importing…' : 'Import'}
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {status === 'error' && errorMsg && (
              <div style={{ fontSize: 12, color: '#ef5350' }}>{errorMsg}</div>
            )}

            {/* Footer buttons. Two write paths:
                  (a) "Add to pending" — queues the edit locally; user reviews +
                      publishes the full batch as a single OSM changeset from the
                      pending-changes panel (no OAuth needed yet).
                  (b) "Open in editor" — deep-link to OHM's iD editor for users
                      who'd rather edit on OHM directly. */}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
              <button onClick={onClose} style={btnStyle('#3a4560')}>Cancel</button>
              <button
                onClick={() => handleOpenInOhm()}
                disabled={!selectedId}
                style={btnStyle('#2d3a55', !selectedId)}
                title="Copy QID and open OHM's iD editor on this element"
              >
                Open in editor
              </button>
              <button
                onClick={() => handleQueueEdit()}
                disabled={!selectedId}
                style={btnStyle('#2a5a3a', !selectedId)}
                title="Queue this tag edit. Review and publish all pending edits together as a single OHM changeset."
              >
                Add to pending →
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
