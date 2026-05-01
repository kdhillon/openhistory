/**
 * UnlocatedPolitiesPanel — bottom-left collapsible panel showing polities with no map location.
 *
 * Shows polities that are active in the current year but have no coordinates (null geometry).
 * Clicking a polity fires onSelectFeature exactly as a map click would.
 */

import { useMemo, useState } from 'react';
import { useTranslations } from '../lib/TranslationContext';
import type { FeatureProperties, Category } from '../types';
import { CATEGORY_COLORS } from '../theme/categories';
import { decodeDate } from '../hooks/useTimeline';

interface Props {
  geojson: GeoJSON.FeatureCollection;
  currentDateInt: number;
  onSelectFeature: (props: FeatureProperties) => void;
  /** Polity IDs that are matched to a visible OHM territory — exclude from "unlocated" */
  ohmMatchedPolityIds?: Set<string>;
}

function PolityRow({ props, onSelect }: { props: FeatureProperties; onSelect: () => void }) {
  const translationMap = useTranslations();
  const [hovered, setHovered] = useState(false);
  const color = CATEGORY_COLORS[props.polityType as Category] ?? CATEGORY_COLORS[props.primaryCategory as Category] ?? '#9E9E9E';
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
        background: hovered ? 'rgba(0,0,0,0.04)' : 'transparent',
        border: 'none',
        borderRadius: 4,
        padding: '4px 8px',
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
      <span style={{ fontSize: 13, color: '#202122', lineHeight: 1.4 }}>
        {(props.wikidataQid && translationMap?.[props.wikidataQid]) || props.title}
      </span>
    </button>
  );
}

export function UnlocatedPolitiesPanel({ geojson, currentDateInt, onSelectFeature, ohmMatchedPolityIds }: Props) {
  const [collapsed, setCollapsed] = useState(true);

  const currentYear = decodeDate(currentDateInt).year;
  const STILL_ACTIVE_TYPES = new Set(['republic', 'kingdom']);

  const polities = useMemo(() => {
    const result: FeatureProperties[] = [];

    for (const f of geojson.features) {
      if (f.geometry !== null) continue;

      const p = f.properties as FeatureProperties;
      if (p.featureType !== 'polity') continue;
      if (p.yearStart == null) continue;
      if (p.yearEnd == null && !STILL_ACTIVE_TYPES.has(p.polityType ?? '')) continue;
      if (p.yearStart > currentYear) continue;
      if (p.yearEnd != null && currentYear > p.yearEnd) continue;
      if (ohmMatchedPolityIds?.has(p.id)) continue;

      result.push(p);
    }

    result.sort((a, b) => (b.sitelinksCount ?? 0) - (a.sitelinksCount ?? 0));
    return result;
  }, [geojson, currentYear]);

  return (
    <div style={{
      background: '#ffffff',
      borderRadius: 12,
      border: '1px solid rgba(0,0,0,0.1)',
      boxShadow: '0 8px 32px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.06)',
      color: '#202122',
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
          padding: '10px 14px',
          cursor: 'pointer',
        }}
        onClick={() => setCollapsed((v) => !v)}
      >
        <span style={{ fontSize: 13, fontWeight: 600, color: '#54595d', flex: 1 }}>
          {collapsed ? (polities.length > 0 ? `Unlocated Polities (${polities.length})` : 'Unlocated Polities') : 'Unlocated Polities'}
        </span>
        <span style={{ fontSize: 18, color: '#9a9a9a', lineHeight: 1 }}>
          {collapsed ? '▴' : '▾'}
        </span>
      </div>

      {/* Body */}
      {!collapsed && (
        <div style={{
          maxHeight: 280,
          overflowY: 'auto',
          padding: '0 6px 8px',
          borderTop: '1px solid rgba(0,0,0,0.06)',
        }}>
          {polities.length === 0 && (
            <div style={{ padding: '8px 8px', fontSize: 12, color: '#9a9a9a', fontStyle: 'italic' }}>
              No unlocated polities
            </div>
          )}
          {polities.map((p) => (
            <PolityRow key={p.id} props={p} onSelect={() => onSelectFeature(p)} />
          ))}
        </div>
      )}
    </div>
  );
}
