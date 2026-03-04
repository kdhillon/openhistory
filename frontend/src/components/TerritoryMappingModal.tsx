import { useState, useMemo, useRef, useEffect } from 'react';
import type { FeatureProperties } from '../types';
import { saveTerritoryMapping } from '../lib/api';

interface Props {
  hbName: string;
  snapshotYear: number;
  polities: FeatureProperties[];
  onClose: () => void;
  /** Called immediately after a successful save */
  onSaved?: (polityId: string, polityName: string) => void;
}

export function TerritoryMappingModal({ hbName, snapshotYear, polities, onClose, onSaved }: Props) {
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q) return polities.slice(0, 40);
    return polities
      .filter((p) => p.title.toLowerCase().includes(q))
      .slice(0, 40);
  }, [query, polities]);

  const selected = polities.find((p) => p.id === selectedId) ?? null;

  async function handleSave() {
    if (!selected) return;
    setStatus('saving');
    try {
      await saveTerritoryMapping(hbName, snapshotYear, selected.id, selected.wikidataQid ?? null);
      setStatus('saved');
      onSaved?.(selected.id, selected.title);
    } catch {
      setStatus('error');
    }
  }

  const overlay: React.CSSProperties = {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 2000,
  };

  const card: React.CSSProperties = {
    background: '#1e2433', color: '#e8eaf0', borderRadius: 10,
    width: 420, maxWidth: '95vw', padding: '20px 22px 18px',
    boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
    display: 'flex', flexDirection: 'column', gap: 14,
  };

  return (
    <div style={overlay} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={card}>
        <div>
          <div style={{ fontSize: 13, color: '#8899bb', marginBottom: 4 }}>
            Assign territory — snapshot {snapshotYear}
          </div>
          <div style={{ fontSize: 17, fontWeight: 600 }}>{hbName}</div>
        </div>

        {status === 'saved' ? (
          <div style={{ textAlign: 'center', padding: '14px 0' }}>
            <div style={{ color: '#66bb6a', fontSize: 15, marginBottom: 6 }}>✓ Mapping saved</div>
            <div style={{ fontSize: 12, color: '#778' }}>
              Re-run <code>import-territories.py --snapshot {snapshotYear}</code> to apply
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
                color: '#e8eaf0', padding: '8px 10px', fontSize: 13, outline: 'none', width: '100%',
                boxSizing: 'border-box',
              }}
            />

            <div style={{
              maxHeight: 220, overflowY: 'auto', border: '1px solid #2a3450',
              borderRadius: 6, background: '#11172a',
            }}>
              {filtered.length === 0 && (
                <div style={{ padding: '12px', color: '#556', fontSize: 13 }}>No matches</div>
              )}
              {filtered.map((p) => (
                <div
                  key={p.id}
                  onClick={() => setSelectedId(p.id)}
                  style={{
                    padding: '8px 12px', cursor: 'pointer', borderBottom: '1px solid #1e2a3e',
                    background: p.id === selectedId ? '#2a3a5a' : 'transparent',
                    display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
                  }}
                >
                  <span style={{ fontSize: 13 }}>{p.title}</span>
                  <span style={{ fontSize: 11, color: '#778', marginLeft: 10, whiteSpace: 'nowrap' }}>
                    {p.yearStart ?? '?'}–{p.yearEnd ?? '∞'}
                    {p.polityType ? ` · ${p.polityType}` : ''}
                  </span>
                </div>
              ))}
            </div>

            {status === 'error' && (
              <div style={{ fontSize: 12, color: '#ef5350' }}>Save failed — is the API running?</div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button onClick={onClose} style={btnStyle('#2a3450')}>Cancel</button>
              <button
                onClick={handleSave}
                disabled={!selected || status === 'saving'}
                style={btnStyle(selected ? '#3a6bbf' : '#2a3450', !selected)}
              >
                {status === 'saving' ? 'Saving…' : 'Save mapping'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function btnStyle(bg: string, disabled = false): React.CSSProperties {
  return {
    background: bg, color: disabled ? '#556' : '#e8eaf0',
    border: 'none', borderRadius: 6, padding: '7px 16px',
    fontSize: 13, cursor: disabled ? 'default' : 'pointer',
    marginTop: 4,
  };
}
