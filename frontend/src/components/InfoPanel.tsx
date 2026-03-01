import type { FeatureProperties, Category } from '../types';
import { CATEGORY_COLORS, CATEGORY_LABELS } from '../theme/categories';
import { displayYear } from '../hooks/useTimeline';

interface Props {
  feature: FeatureProperties | null;
  onClose: () => void;
}

export function InfoPanel({ feature, onClose }: Props) {
  if (!feature) return null;

  const yearStr = feature.yearStart != null
    ? (feature.dateIsFuzzy ? `~${displayYear(feature.yearStart)}` : displayYear(feature.yearStart))
    : 'Date unknown';

  const rangeStr = feature.dateIsFuzzy && feature.dateRangeMin != null && feature.dateRangeMax != null
    ? ` (est. ${displayYear(feature.dateRangeMin)} – ${displayYear(feature.dateRangeMax)})`
    : '';

  return (
    <div style={styles.panel}>
      <button style={styles.close} onClick={onClose} title="Close">✕</button>

      <div style={styles.categories}>
        {feature.categories.map((cat) => (
          <span
            key={cat}
            style={{
              ...styles.tag,
              background: CATEGORY_COLORS[cat as Category] ?? '#9E9E9E',
            }}
          >
            {CATEGORY_LABELS[cat as Category] ?? cat}
          </span>
        ))}
      </div>

      <h2 style={styles.title}>{feature.title}</h2>

      <div style={styles.meta}>
        <span>{yearStr}{rangeStr}</span>
        {feature.locationName && (
          <span style={styles.location}> · {feature.locationName}</span>
        )}
      </div>

      {feature.wikipediaSummary && (
        <p style={styles.summary}>{feature.wikipediaSummary}</p>
      )}

      <a
        href={feature.wikipediaUrl}
        target="_blank"
        rel="noopener noreferrer"
        style={styles.wikiLink}
      >
        View on Wikipedia →
      </a>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    position: 'fixed',
    top: 60,
    right: 0,
    width: 340,
    maxHeight: 'calc(100vh - 120px)',
    background: 'rgba(20, 20, 30, 0.95)',
    backdropFilter: 'blur(12px)',
    borderLeft: '1px solid rgba(255,255,255,0.1)',
    padding: '20px 20px 24px',
    overflowY: 'auto',
    zIndex: 90,
    color: '#fff',
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  close: {
    position: 'absolute',
    top: 12,
    right: 12,
    background: 'none',
    border: 'none',
    color: 'rgba(255,255,255,0.5)',
    fontSize: 16,
    cursor: 'pointer',
    lineHeight: 1,
  },
  categories: {
    display: 'flex',
    gap: 6,
    flexWrap: 'wrap',
  },
  tag: {
    fontSize: 11,
    fontWeight: 600,
    padding: '2px 8px',
    borderRadius: 12,
    color: '#fff',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  title: {
    margin: 0,
    fontSize: 18,
    fontWeight: 700,
    lineHeight: 1.3,
    color: '#fff',
  },
  meta: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.6)',
  },
  location: {
    color: 'rgba(255,255,255,0.5)',
  },
  summary: {
    fontSize: 14,
    lineHeight: 1.6,
    color: 'rgba(255,255,255,0.85)',
    margin: 0,
  },
  wikiLink: {
    fontSize: 13,
    color: '#4285F4',
    textDecoration: 'none',
    marginTop: 4,
  },
};
