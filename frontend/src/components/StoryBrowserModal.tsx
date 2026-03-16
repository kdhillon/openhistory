import { useState, useEffect, useRef } from 'react';
import type { StoryIndexEntry } from '../types';

const DETAIL_LEVEL_LABELS: Record<string, string> = {
  elementary: 'Elementary',
  middle_school: 'Middle School',
  high_school: 'High School',
  deep_dive: 'Deep Dive',
};

const DETAIL_LEVEL_COLORS: Record<string, string> = {
  elementary: '#2e7d32',
  middle_school: '#1565c0',
  high_school: '#6a1b9a',
  deep_dive: '#c62828',
};

interface Props {
  onClose: () => void;
  onStartStory: (slug: string) => void;
}

export function StoryBrowserModal({ onClose, onStartStory }: Props) {
  const [entries, setEntries] = useState<StoryIndexEntry[]>([]);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<StoryIndexEntry | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const isMobile = window.innerWidth < 640;

  useEffect(() => {
    fetch('/data/stories/index.json')
      .then((r) => r.json())
      .then((data: StoryIndexEntry[]) => {
        setEntries(data);
        if (data.length > 0) setSelected(data[0]);
      })
      .catch(() => setEntries([]));
    // Focus search on open
    requestAnimationFrame(() => searchRef.current?.focus());
  }, []);

  const filtered = entries.filter((e) => {
    if (!query.trim()) return true;
    const q = query.toLowerCase();
    return e.title.toLowerCase().includes(q) || (e.description ?? '').toLowerCase().includes(q);
  });

  return (
    <div style={styles.overlay} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={isMobile ? styles.sheetMobile : styles.modal}>
        {/* Header */}
        <div style={styles.header}>
          <div style={styles.headerLeft}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, opacity: 0.8 }}>
              <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/>
              <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
            </svg>
            <span style={styles.headerTitle}>Story Browser</span>
          </div>
          <button style={styles.closeBtn} onClick={onClose}>✕</button>
        </div>

        {/* Body: list + detail */}
        <div style={isMobile ? styles.bodyMobile : styles.body}>
          {/* Left: search + list */}
          <div style={isMobile ? styles.listPaneMobile : styles.listPane}>
            {/* Search */}
            <div style={styles.searchWrap}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="rgba(0,0,0,0.4)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}>
                <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
              </svg>
              <input
                ref={searchRef}
                type="text"
                placeholder="Search stories…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                style={styles.searchInput}
              />
            </div>

            {/* Story list */}
            <div style={styles.list}>
              {filtered.length === 0 ? (
                <div style={styles.empty}>No stories found</div>
              ) : (
                filtered.map((entry) => (
                  <button
                    key={entry.slug}
                    style={{
                      ...styles.listItem,
                      ...(selected?.slug === entry.slug ? styles.listItemActive : {}),
                    }}
                    onClick={() => setSelected(entry)}
                  >
                    <div style={styles.listItemTitle}>{entry.title}</div>
                    <div style={styles.listItemMeta}>
                      <span style={{ ...styles.levelBadge, background: `${DETAIL_LEVEL_COLORS[entry.detail_level] ?? '#555'}18`, color: DETAIL_LEVEL_COLORS[entry.detail_level] ?? '#555', border: `1px solid ${DETAIL_LEVEL_COLORS[entry.detail_level] ?? '#555'}44` }}>
                        {DETAIL_LEVEL_LABELS[entry.detail_level] ?? entry.detail_level}
                      </span>
                      <span style={styles.beatCount}>{entry.beat_count} beats</span>
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>

          {/* Right: detail panel — hidden on mobile when nothing selected; show below list on mobile */}
          {selected && (
            <div style={isMobile ? styles.detailPaneMobile : styles.detailPane}>
              <div style={styles.detailContent}>
                <div style={{ marginBottom: 6 }}>
                  <span style={{ ...styles.levelBadge, background: `${DETAIL_LEVEL_COLORS[selected.detail_level] ?? '#555'}18`, color: DETAIL_LEVEL_COLORS[selected.detail_level] ?? '#555', border: `1px solid ${DETAIL_LEVEL_COLORS[selected.detail_level] ?? '#555'}44` }}>
                    {DETAIL_LEVEL_LABELS[selected.detail_level] ?? selected.detail_level}
                  </span>
                </div>
                <h2 style={styles.detailTitle}>{selected.title}</h2>
                {selected.description && (
                  <p style={styles.detailDesc}>{selected.description}</p>
                )}
                <div style={styles.detailMeta}>
                  <span style={styles.metaChip}>{selected.beat_count} beats</span>
                </div>
              </div>
              <button
                style={styles.startBtn}
                onClick={() => { onClose(); onStartStory(selected.slug); }}
              >
                Start Story →
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.35)',
    zIndex: 500,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  modal: {
    background: '#fff',
    borderRadius: 14,
    boxShadow: '0 20px 60px rgba(0,0,0,0.2)',
    width: 680,
    maxWidth: 'calc(100vw - 40px)',
    maxHeight: 'calc(100vh - 80px)',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  sheetMobile: {
    background: '#fff',
    borderRadius: '16px 16px 0 0',
    boxShadow: '0 -4px 24px rgba(0,0,0,0.18)',
    position: 'fixed' as const,
    bottom: 0,
    left: 0,
    right: 0,
    maxHeight: '88vh',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '14px 18px',
    borderBottom: '1px solid rgba(0,0,0,0.08)',
    flexShrink: 0,
  },
  headerLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    color: '#202122',
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: 700,
    color: '#202122',
    letterSpacing: '-0.01em',
  },
  closeBtn: {
    background: 'rgba(0,0,0,0.06)',
    border: 'none',
    borderRadius: '50%',
    width: 28,
    height: 28,
    cursor: 'pointer',
    color: '#555',
    fontSize: 12,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontFamily: 'inherit',
    flexShrink: 0,
  },
  body: {
    display: 'flex',
    flex: 1,
    overflow: 'hidden',
    minHeight: 0,
  },
  bodyMobile: {
    display: 'flex',
    flex: 1,
    flexDirection: 'column',
    overflow: 'hidden',
    minHeight: 0,
  },
  listPane: {
    width: 260,
    flexShrink: 0,
    borderRight: '1px solid rgba(0,0,0,0.08)',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  listPaneMobile: {
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    borderBottom: '1px solid rgba(0,0,0,0.08)',
    maxHeight: '40vh',
  },
  searchWrap: {
    position: 'relative' as const,
    padding: '10px 12px',
    borderBottom: '1px solid rgba(0,0,0,0.06)',
    flexShrink: 0,
  },
  searchInput: {
    width: '100%',
    paddingLeft: 30,
    paddingRight: 10,
    paddingTop: 7,
    paddingBottom: 7,
    fontSize: 13,
    border: '1px solid rgba(0,0,0,0.14)',
    borderRadius: 8,
    outline: 'none',
    background: '#f8f9fa',
    color: '#202122',
    fontFamily: 'inherit',
    boxSizing: 'border-box' as const,
  },
  list: {
    flex: 1,
    overflowY: 'auto' as const,
    padding: '6px 0',
  },
  empty: {
    padding: '20px 16px',
    fontSize: 13,
    color: 'rgba(0,0,0,0.4)',
    textAlign: 'center' as const,
  },
  listItem: {
    display: 'block',
    width: '100%',
    textAlign: 'left' as const,
    padding: '10px 14px',
    background: 'transparent',
    border: 'none',
    borderLeft: '3px solid transparent',
    cursor: 'pointer',
    transition: 'background 0.1s',
    fontFamily: 'inherit',
  },
  listItemActive: {
    background: '#f0f4ff',
    borderLeftColor: '#3366cc',
  },
  listItemTitle: {
    fontSize: 13,
    fontWeight: 600,
    color: '#202122',
    marginBottom: 4,
    lineHeight: 1.3,
  },
  listItemMeta: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  levelBadge: {
    fontSize: 10,
    fontWeight: 600,
    padding: '2px 6px',
    borderRadius: 4,
    letterSpacing: '0.03em',
    whiteSpace: 'nowrap' as const,
  },
  beatCount: {
    fontSize: 11,
    color: 'rgba(0,0,0,0.4)',
  },
  detailPane: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    minWidth: 0,
  },
  detailPaneMobile: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'auto' as const,
    minHeight: 0,
  },
  detailContent: {
    flex: 1,
    padding: '22px 24px 16px',
    overflowY: 'auto' as const,
  },
  detailTitle: {
    fontSize: 22,
    fontWeight: 700,
    color: '#202122',
    margin: '8px 0 12px',
    letterSpacing: '-0.02em',
    lineHeight: 1.2,
  },
  detailDesc: {
    fontSize: 14,
    lineHeight: 1.7,
    color: '#555',
    margin: '0 0 16px',
  },
  detailMeta: {
    display: 'flex',
    gap: 8,
    flexWrap: 'wrap' as const,
  },
  metaChip: {
    fontSize: 11,
    fontWeight: 500,
    color: 'rgba(0,0,0,0.45)',
    background: 'rgba(0,0,0,0.05)',
    padding: '3px 8px',
    borderRadius: 4,
  },
  startBtn: {
    margin: '0 24px 20px',
    padding: '12px 0',
    background: '#1a237e',
    color: '#fff',
    border: 'none',
    borderRadius: 10,
    fontSize: 15,
    fontWeight: 700,
    cursor: 'pointer',
    fontFamily: 'inherit',
    letterSpacing: '-0.01em',
    flexShrink: 0,
    transition: 'background 0.15s',
  },
};
