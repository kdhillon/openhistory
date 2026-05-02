/**
 * GlobalSearchPanel — fixed top-left search box and slide-out results panel.
 *
 * On Enter (or magnifying-glass click), queries `/api/search` and displays
 * polities + events. Results that overlap the current time window are shown
 * first; others fall below.
 *
 * On result click: parent handler opens the InfoPanel, pans/zooms to the
 * feature, and seeks the timeline if the feature is outside the active window.
 */

import { useState, useRef, useEffect } from 'react';
import { searchAll } from '../lib/api';
import type { SearchPolityResult, SearchEventResult } from '../lib/api';
import { CATEGORY_COLORS } from '../theme/categories';
import type { Category } from '../types';

interface Props {
  yearMin: number;
  yearMax: number;
  isMobile: boolean;
  onSelectPolity: (r: SearchPolityResult) => void;
  onSelectEvent: (r: SearchEventResult) => void;
}

export function GlobalSearchPanel({ yearMin, yearMax, isMobile, onSelectPolity, onSelectEvent }: Props) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [polities, setPolities] = useState<SearchPolityResult[]>([]);
  const [events, setEvents] = useState<SearchEventResult[]>([]);
  const [searched, setSearched] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const runSearch = async () => {
    if (query.trim().length < 2) return;
    setLoading(true);
    setSearched(true);
    setOpen(true);
    try {
      const res = await searchAll(query.trim(), yearMin, yearMax);
      setPolities(res.polities);
      setEvents(res.events);
    } finally {
      setLoading(false);
    }
  };

  // Close panel on Esc
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && open) {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === 'INPUT' && inputRef.current === document.activeElement) {
          inputRef.current.blur();
          return;
        }
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // Split into "in-window" vs "outside" so we can render section headers.
  const inWindow = (s: number | null, e: number | null): boolean => {
    if (s == null) return false;
    return s <= yearMax && (e ?? 9999) >= yearMin;
  };

  const polsIn = polities.filter((p) => inWindow(p.yearStart, p.yearEnd));
  const polsOut = polities.filter((p) => !inWindow(p.yearStart, p.yearEnd));
  const evsIn = events.filter((e) => inWindow(e.yearStart, e.yearEnd));
  const evsOut = events.filter((e) => !inWindow(e.yearStart, e.yearEnd));

  // Polities: null yearEnd means still active → show ∞
  const formatPolityRange = (s: number | null, e: number | null): string => {
    if (s == null) return '';
    return `${s}–${e ?? '∞'}`;
  };
  // Events: null yearEnd means single-year event → show just the start year
  const formatEventRange = (s: number | null, e: number | null): string => {
    if (s == null) return '';
    if (e == null || e === s) return String(s);
    return `${s}–${e}`;
  };

  return (
    <>
      {/* Search box (top-left) */}
      <div style={{
        position: 'absolute',
        top: 8,
        left: 8,
        zIndex: 12,
        display: 'flex',
        alignItems: 'center',
        background: 'rgba(255,255,255,0.95)',
        borderRadius: 8,
        boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
        width: 280,
        maxWidth: 'calc(100vw - 24px)',
      }}>
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') runSearch(); }}
          placeholder="Search polities & events…"
          style={{
            flex: 1,
            border: 'none',
            outline: 'none',
            padding: '8px 12px',
            fontSize: 14,
            background: 'transparent',
            fontFamily: 'inherit',
            borderRadius: 8,
          }}
        />
        <button
          onClick={runSearch}
          aria-label="Search"
          style={{
            border: 'none',
            background: 'transparent',
            padding: '8px 12px',
            cursor: 'pointer',
            color: '#555',
            display: 'flex',
            alignItems: 'center',
          }}
        >
          {/* Magnifying glass SVG */}
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="7"/>
            <line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
        </button>
      </div>

      {/* Side panel — absolute so it sits inside the map container (below the top bar) */}
      {open && (
        <div style={{
          position: 'absolute',
          top: 52,  // sits just below the search box (top: 8 + ~36 height + 8 gap)
          left: 0,
          bottom: 8,  // small gap above the timeline bar
          width: isMobile ? '100vw' : 360,
          maxWidth: '100vw',
          zIndex: 11,
          background: '#1e2433',
          color: '#e8eaf0',
          boxShadow: '2px 0 16px rgba(0,0,0,0.4)',
          display: 'flex',
          flexDirection: 'column',
          fontFamily: 'inherit',
        }}>
          {/* Header */}
          <div style={{
            padding: '12px 16px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderBottom: '1px solid #2a3450',
          }}>
            <div style={{ fontSize: 13, color: '#8899bb' }}>
              {loading ? 'Searching…' : searched ? `Search: "${query}"` : 'Search'}
            </div>
            <button
              onClick={() => setOpen(false)}
              aria-label="Close"
              style={{
                background: 'none',
                border: 'none',
                color: '#8899bb',
                fontSize: 18,
                cursor: 'pointer',
                padding: 0,
                lineHeight: 1,
              }}
            >
              ×
            </button>
          </div>

          {/* Results */}
          <div style={{ overflowY: 'auto', flex: 1 }}>
            {!loading && polities.length === 0 && events.length === 0 && searched && (
              <div style={{ padding: 16, color: '#778', fontSize: 13 }}>No results.</div>
            )}

            <Section
              title={`Polities · current window (${polsIn.length})`}
              show={polsIn.length > 0}
            >
              {polsIn.map((p) => (
                <PolityRow key={p.id} p={p} formatRange={formatPolityRange} onClick={() => onSelectPolity(p)} />
              ))}
            </Section>

            <Section
              title={`Events · current window (${evsIn.length})`}
              show={evsIn.length > 0}
            >
              {evsIn.map((e) => (
                <EventRow key={e.id} e={e} formatRange={formatEventRange} onClick={() => onSelectEvent(e)} />
              ))}
            </Section>

            <Section
              title={`Polities · outside window (${polsOut.length})`}
              show={polsOut.length > 0}
              dim
            >
              {polsOut.map((p) => (
                <PolityRow key={p.id} p={p} formatRange={formatPolityRange} onClick={() => onSelectPolity(p)} />
              ))}
            </Section>

            <Section
              title={`Events · outside window (${evsOut.length})`}
              show={evsOut.length > 0}
              dim
            >
              {evsOut.map((e) => (
                <EventRow key={e.id} e={e} formatRange={formatEventRange} onClick={() => onSelectEvent(e)} />
              ))}
            </Section>
          </div>
        </div>
      )}
    </>
  );
}

function Section({ title, show, dim, children }: { title: string; show: boolean; dim?: boolean; children: React.ReactNode }) {
  if (!show) return null;
  return (
    <div style={{ opacity: dim ? 0.7 : 1 }}>
      <div style={{
        padding: '8px 16px 4px',
        fontSize: 11,
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        color: '#8899bb',
        background: 'rgba(0,0,0,0.15)',
      }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function PolityRow({ p, formatRange, onClick }: {
  p: SearchPolityResult;
  formatRange: (s: number | null, e: number | null) => string;
  onClick: () => void;
}) {
  const color = CATEGORY_COLORS[p.polityType as Category] ?? CATEGORY_COLORS.other ?? '#607D8B';
  return (
    <div
      onClick={onClick}
      style={{
        padding: '8px 16px',
        cursor: 'pointer',
        display: 'flex',
        gap: 10,
        alignItems: 'center',
        borderBottom: '1px solid #1e2a3e',
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = '#2a3a5a')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      <span style={{
        width: 8, height: 8, borderRadius: 4, background: color, flexShrink: 0,
      }} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {p.title}
        </div>
        <div style={{ fontSize: 11, color: '#778' }}>
          {formatRange(p.yearStart, p.yearEnd)} · {p.polityType}
        </div>
      </div>
    </div>
  );
}

function EventRow({ e, formatRange, onClick }: {
  e: SearchEventResult;
  formatRange: (s: number | null, e: number | null) => string;
  onClick: () => void;
}) {
  const color = CATEGORY_COLORS[e.primaryCategory as Category] ?? '#9E9E9E';
  return (
    <div
      onClick={onClick}
      style={{
        padding: '8px 16px',
        cursor: 'pointer',
        display: 'flex',
        gap: 10,
        alignItems: 'center',
        borderBottom: '1px solid #1e2a3e',
      }}
      onMouseEnter={(ev) => (ev.currentTarget.style.background = '#2a3a5a')}
      onMouseLeave={(ev) => (ev.currentTarget.style.background = 'transparent')}
    >
      <span style={{
        width: 8, height: 8, borderRadius: 4, background: color, flexShrink: 0,
      }} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {e.title}
        </div>
        <div style={{ fontSize: 11, color: '#778' }}>
          {formatRange(e.yearStart, e.yearEnd)}
          {e.locationName ? ` · ${e.locationName}` : ''}
        </div>
      </div>
    </div>
  );
}
