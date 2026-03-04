import { useMemo, useCallback } from 'react';
import type { FeatureProperties } from '../types';
import { eventDateRange, STEP_YEAR } from '../hooks/useTimeline';

const FADE_INT = 3 * STEP_YEAR;

interface MajorEvent {
  qid: string;
  title: string;
  slug: string | null;
  count: number;
}

interface Props {
  geojson: GeoJSON.FeatureCollection;
  currentDateInt: number;
  stepSize: number;
  onNavigateToFeature: (feature: FeatureProperties) => void;
}

export function MajorEventsPanel({ geojson, currentDateInt, stepSize, onNavigateToFeature }: Props) {
  const majorEvents = useMemo<MajorEvent[]>(() => {
    const counts = new Map<string, MajorEvent>();
    const effectiveNow = currentDateInt + stepSize - 1;

    for (const feature of geojson.features) {
      const p = feature.properties as FeatureProperties;
      if (p.featureType !== 'event' || p.yearStart == null) continue;

      const [startInt, endInt] = eventDateRange(
        p.yearStart, p.monthStart, p.dayStart,
        p.yearEnd,   p.monthEnd,   p.dayEnd,
      );
      if (!(startInt <= effectiveNow && currentDateInt <= endInt + FADE_INT)) continue;

      for (const parent of (p.partOfResolved ?? [])) {
        if (!parent.qid || !parent.title) continue;
        const ex = counts.get(parent.qid);
        if (ex) {
          ex.count++;
        } else {
          counts.set(parent.qid, {
            qid: parent.qid,
            title: parent.title,
            slug: parent.slug ?? null,
            count: 1,
          });
        }
      }
    }

    return [...counts.values()].sort((a, b) => b.count - a.count);
  }, [geojson, currentDateInt, stepSize]);

  const handleClick = useCallback((ev: MajorEvent) => {
    if (!ev.slug) return;
    const match = geojson.features.find(
      (f) => f.properties?.slug === ev.slug && f.properties?.featureType === 'event',
    );
    if (match) onNavigateToFeature(match.properties as FeatureProperties);
  }, [geojson, onNavigateToFeature]);

  if (majorEvents.length === 0) return null;

  return (
    <div style={{
      position: 'fixed',
      bottom: 60,
      left: 0,
      right: 0,
      height: 44,
      background: 'rgba(12, 17, 23, 0.88)',
      backdropFilter: 'blur(10px)',
      WebkitBackdropFilter: 'blur(10px)',
      display: 'flex',
      alignItems: 'stretch',
      zIndex: 95,
      borderTop: '1px solid rgba(255,255,255,0.07)',
    }}>
      {/* Fixed label — does not scroll */}
      <div style={{
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        padding: '0 12px 0 16px',
        color: 'rgba(255,255,255,0.35)',
        fontSize: 10,
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: '0.1em',
        borderRight: '1px solid rgba(255,255,255,0.09)',
        whiteSpace: 'nowrap',
      }}>
        Major Events
      </div>

      {/* Scrollable chips */}
      <div
        className="no-scrollbar"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          overflowX: 'auto',
          padding: '0 14px',
          flex: 1,
        }}
      >
        {majorEvents.map((ev) => (
          <Chip key={ev.qid} ev={ev} onClick={handleClick} />
        ))}
      </div>
    </div>
  );
}

function Chip({ ev, onClick }: { ev: MajorEvent; onClick: (ev: MajorEvent) => void }) {
  const clickable = !!ev.slug;
  return (
    <button
      onClick={() => onClick(ev)}
      disabled={!clickable}
      style={{
        flexShrink: 0,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 7,
        background: 'rgba(255,255,255,0.06)',
        border: '1px solid rgba(255,255,255,0.11)',
        borderRadius: 999,
        color: 'rgba(255,255,255,0.85)',
        fontSize: 12.5,
        lineHeight: 1,
        padding: '4px 11px 4px 11px',
        cursor: clickable ? 'pointer' : 'default',
        whiteSpace: 'nowrap',
        transition: 'background 0.12s, border-color 0.12s',
      }}
      onMouseEnter={(e) => {
        if (!clickable) return;
        e.currentTarget.style.background = 'rgba(255,255,255,0.13)';
        e.currentTarget.style.borderColor = 'rgba(255,255,255,0.22)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'rgba(255,255,255,0.06)';
        e.currentTarget.style.borderColor = 'rgba(255,255,255,0.11)';
      }}
    >
      {ev.title}
      <span style={{
        fontSize: 11,
        fontWeight: 600,
        color: 'rgba(255,255,255,0.38)',
        minWidth: 14,
        textAlign: 'right',
      }}>
        {ev.count}
      </span>
    </button>
  );
}
