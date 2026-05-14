import { useEffect, useState } from 'react';
import { usePendingOhmEdits, removePendingEdit, clearPendingEdits } from '../lib/pendingOhmEdits';
import { getOhmToken, updateOhmElements } from '../lib/ohmApi';

const API_BASE = import.meta.env.VITE_API_URL ? `${import.meta.env.VITE_API_URL}/api` : '/api';

interface Props {
  onPublishSuccess?: () => void;
  isMobile?: boolean;
}

/**
 * Floating badge + expanded review panel for queued OHM tag edits.
 *
 * - When the queue is empty, renders nothing (invisible, zero footprint).
 * - When non-empty, shows a compact "N pending" badge in the bottom-right
 *   that expands on click into a list of queued edits with "Publish all"
 *   to bundle them into one OSM changeset.
 *
 * Publishing requires OHM OAuth. If the user isn't signed in, the panel
 * routes them through /api/ohm/auth-url first.
 */
export function PendingChangesPanel({ onPublishSuccess, isMobile = false }: Props) {
  const edits = usePendingOhmEdits();
  const [open, setOpen] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState<boolean>(() => Boolean(getOhmToken()));

  // Cross-tab + same-tab token sync (mirrors the modal's approach).
  // Refresh on storage event + focus + 1s poll so an OAuth completion in
  // another tab is picked up here.
  useEffect(() => {
    const sync = () => setSignedIn(Boolean(getOhmToken()));
    window.addEventListener('storage', sync);
    window.addEventListener('focus', sync);
    const interval = setInterval(sync, 1000);
    return () => {
      window.removeEventListener('storage', sync);
      window.removeEventListener('focus', sync);
      clearInterval(interval);
    };
  }, []);

  if (edits.length === 0) return null;

  async function handlePublish() {
    setError(null);
    const token = getOhmToken();
    if (!token) {
      // Kick off OAuth in a new tab — the panel re-checks the token on focus.
      try {
        const r = await fetch(`${API_BASE}/ohm/auth-url`);
        const data = await r.json();
        if (data.url) window.open(data.url, '_blank', 'noopener,noreferrer');
        else setError('Backend returned no auth URL.');
      } catch (e) {
        setError(`Sign-in failed: ${(e as Error).message}`);
      }
      return;
    }
    setPublishing(true);
    try {
      const comment = edits.length === 1
        ? edits[0].comment
        : `Wikidata/Wikipedia tagging via OpenHistory (${edits.length} edits: ${edits.slice(0, 5).map((e) => e.displayName).join(', ')}${edits.length > 5 ? '…' : ''})`;
      await updateOhmElements({
        token,
        comment,
        edits: edits.map((e) => ({ osmType: e.osmType, osmId: e.osmId, setTags: e.setTags })),
      });
      clearPendingEdits();
      setOpen(false);
      onPublishSuccess?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPublishing(false);
    }
  }

  const wrap: React.CSSProperties = {
    position: 'fixed',
    top: isMobile ? 56 : 78,
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: 110,
    background: '#1e2433',
    color: '#e8eaf0',
    borderRadius: 8,
    boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
    fontFamily: 'inherit',
    maxWidth: 360,
    width: open ? 360 : 'auto',
  };

  if (!open) {
    return (
      <div style={wrap}>
        <button
          onClick={() => setOpen(true)}
          style={{
            background: 'none', border: 'none', color: '#e8eaf0',
            padding: '8px 12px', fontSize: 12, fontFamily: 'inherit',
            cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8,
          }}
          title="Review and publish your queued OHM tag edits"
        >
          <span style={{
            background: '#4caf50', color: '#0f1a14', borderRadius: 10,
            padding: '1px 8px', fontSize: 11, fontWeight: 700,
          }}>{edits.length}</span>
          Pending OHM edits ▴
        </button>
      </div>
    );
  }

  return (
    <div style={wrap}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '10px 12px', borderBottom: '1px solid #2a3450',
      }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>Pending OHM edits ({edits.length})</div>
        <button
          onClick={() => setOpen(false)}
          style={{ background: 'none', border: 'none', color: '#778', cursor: 'pointer', fontSize: 16, padding: 0 }}
          aria-label="Collapse"
        >▾</button>
      </div>

      <div style={{ maxHeight: 280, overflowY: 'auto' }}>
        {edits.map((e) => (
          <div key={`${e.osmType}/${e.osmId}`} style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
            padding: '8px 12px', borderBottom: '1px solid #1e2a3e',
          }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, color: '#e8eaf0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.displayName}</div>
              <div style={{ fontSize: 10, color: '#556', fontFamily: 'monospace', marginTop: 1 }}>
                {e.osmType}/{e.osmId} → {e.polityQid}
              </div>
            </div>
            <button
              onClick={() => removePendingEdit(e.osmType, e.osmId)}
              style={{
                background: 'none', border: 'none', color: '#778', cursor: 'pointer',
                fontSize: 14, padding: '0 4px', marginLeft: 8,
              }}
              title="Remove from queue"
              aria-label={`Remove ${e.displayName}`}
            >×</button>
          </div>
        ))}
      </div>

      {error && (
        <div style={{ fontSize: 11, color: '#ef5350', padding: '8px 12px', borderTop: '1px solid #2a3450' }}>{error}</div>
      )}

      <div style={{
        display: 'flex', gap: 8, padding: '10px 12px',
        borderTop: '1px solid #2a3450', justifyContent: 'flex-end', alignItems: 'center',
      }}>
        <button
          onClick={() => { if (confirm(`Discard all ${edits.length} pending edits?`)) clearPendingEdits(); }}
          style={{
            background: 'none', border: '1px solid #3a4560', borderRadius: 4,
            color: '#8899bb', fontSize: 11, padding: '4px 10px',
            cursor: 'pointer', fontFamily: 'inherit',
          }}
        >Discard all</button>
        <button
          onClick={handlePublish}
          disabled={publishing}
          style={{
            background: publishing ? '#223' : '#4caf50',
            color: publishing ? '#556' : '#0f1a14',
            border: 'none', borderRadius: 4, padding: '6px 14px',
            fontSize: 12, fontWeight: 700, cursor: publishing ? 'default' : 'pointer',
            fontFamily: 'inherit',
          }}
          title={signedIn
            ? `Publish all ${edits.length} pending edits as one OHM changeset`
            : 'Sign in to OpenHistoricalMap to publish'}
        >
          {publishing ? 'Publishing…' : signedIn ? `Publish all (${edits.length})` : 'Sign in & publish'}
        </button>
      </div>
    </div>
  );
}
