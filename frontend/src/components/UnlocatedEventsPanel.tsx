/**
 * UnlocatedEventsPanel — bottom-left collapsible panel showing events with no map location.
 *
 * Two sections:
 *   Active  — event is currently within its date range
 *   Recent  — event has ended but is still within the linger window (same logic as MapView)
 *
 * Clicking an event fires onSelectFeature exactly as a map click would.
 */

import { useMemo, useState } from 'react';
import type { FeatureProperties, Category } from '../types';
import { CATEGORY_COLORS } from '../theme/categories';
import { encodeDate, eventDateRange, STEP_YEAR } from '../hooks/useTimeline';

// Must match MapView constants exactly
const LINGER_STEPS = 5;
const LINGER_MAX = 3 * STEP_YEAR;

interface Props {
  eventFeatures: GeoJSON.Feature[];
  currentDateInt: number;
  stepSize: number;
  onSelectFeature: (props: FeatureProperties) => void;
}

function EventRow({ props, onSelect }: { props: FeatureProperties; onSelect: () => void }) {
  const [hovered, setHovered] = useState(false);
  const color = CATEGORY_COLORS[props.primaryCategory as Category] ?? '#9E9E9E';
  return (
    <button
      onClick={onSelect}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 7,
        width: '100%',
        background: hovered ? 'rgba(255,255,255,0.08)' : 'transparent',
        border: 'none',
        borderRadius: 4,
        padding: '4px 6px',
        cursor: 'pointer',
        textAlign: 'left',
        fontFamily: 'inherit',
      }}
    >
      <span style={{
        width: 7,
        height: 7,
        borderRadius: '50%',
        background: color,
        flexShrink: 0,
        marginTop: 4,
      }} />
      <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.85)', lineHeight: 1.4 }}>
        {props.title}
      </span>
    </button>
  );
}

function SectionHeader({ label, count }: { label: string; count: number }) {
  return (
    <div style={{
      fontSize: 10,
      fontWeight: 700,
      letterSpacing: '0.07em',
      textTransform: 'uppercase',
      color: 'rgba(255,255,255,0.35)',
      padding: '6px 6px 2px',
    }}>
      {label} <span style={{ fontWeight: 400 }}>({count})</span>
    </div>
  );
}

export function UnlocatedEventsPanel({ eventFeatures, currentDateInt, stepSize, onSelectFeature }: Props) {
  const [collapsed, setCollapsed] = useState(false);

  const { active, recent } = useMemo(() => {
    const active: FeatureProperties[] = [];
    const recent: FeatureProperties[] = [];

    for (const f of eventFeatures) {
      // Only events with no geometry (no location)
      if (f.geometry !== null) continue;

      const p = f.properties as FeatureProperties;
      if (p.featureType !== 'event') continue;
      if (p.yearStart == null) continue;

      const [startInt, endInt] = eventDateRange(
        p.yearStart, p.monthStart, p.dayStart,
        p.yearEnd,   p.monthEnd,   p.dayEnd,
      );

      const effectiveNow = currentDateInt + stepSize - 1;
      const lingerEnd = endInt + Math.min(LINGER_STEPS * stepSize, LINGER_MAX);

      if (startInt > effectiveNow) continue;
      if (currentDateInt > lingerEnd) continue;

      if (currentDateInt <= endInt) {
        active.push(p);
      } else {
        recent.push(p);
      }
    }

    // Sort by yearStart descending within each group
    const byStart = (a: FeatureProperties, b: FeatureProperties) =>
      (b.yearStart ?? 0) - (a.yearStart ?? 0);
    active.sort(byStart);
    recent.sort(byStart);

    return { active, recent };
  }, [eventFeatures, currentDateInt, stepSize]);

  const total = active.length + recent.length;
  if (total === 0) return null;

  return (
    <div style={{
      position: 'absolute',
      bottom: 10,
      left: 10,
      zIndex: 10,
      background: 'rgba(30,30,30,0.82)',
      backdropFilter: 'blur(6px)',
      borderRadius: 8,
      fontSize: 12,
      color: 'rgba(255,255,255,0.9)',
      pointerEvents: 'auto',
      userSelect: 'none',
      maxWidth: 240,
      minWidth: collapsed ? 0 : 200,
    }}>
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 10px',
          cursor: 'pointer',
        }}
        onClick={() => setCollapsed((v) => !v)}
      >
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.45)', flex: 1 }}>
          {collapsed ? `Unlocated (${total})` : 'Unlocated Events'}
        </span>
        <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.35)', lineHeight: 1 }}>
          {collapsed ? '▸' : '▾'}
        </span>
      </div>

      {/* Body */}
      {!collapsed && (
        <div style={{
          maxHeight: 280,
          overflowY: 'auto',
          padding: '0 4px 6px',
          borderTop: '1px solid rgba(255,255,255,0.07)',
        }}>
          {active.length > 0 && (
            <>
              <SectionHeader label="Active" count={active.length} />
              {active.map((p) => (
                <EventRow key={p.id} props={p} onSelect={() => onSelectFeature(p)} />
              ))}
            </>
          )}
          {recent.length > 0 && (
            <>
              <SectionHeader label="Recent" count={recent.length} />
              {recent.map((p) => (
                <EventRow key={p.id} props={p} onSelect={() => onSelectFeature(p)} />
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
