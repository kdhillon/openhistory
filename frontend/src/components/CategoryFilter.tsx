import type { Category } from '../types';
import { ALL_CATEGORIES, CATEGORY_COLORS, CATEGORY_LABELS } from '../theme/categories';

interface Props {
  activeCategories: Set<Category>;
  onToggle: (cat: Category) => void;
}

export function CategoryFilter({ activeCategories, onToggle }: Props) {
  return (
    <div style={styles.bar}>
      {ALL_CATEGORIES.map((cat) => {
        const active = activeCategories.has(cat);
        return (
          <button
            key={cat}
            onClick={() => onToggle(cat)}
            style={{
              ...styles.chip,
              opacity: active ? 1 : 0.35,
            }}
            title={active ? `Hide ${CATEGORY_LABELS[cat]}` : `Show ${CATEGORY_LABELS[cat]}`}
          >
            <span
              style={{
                ...styles.dot,
                background: CATEGORY_COLORS[cat],
              }}
            />
            {CATEGORY_LABELS[cat]}
          </button>
        );
      })}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  bar: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    height: 48,
    background: 'rgba(20, 20, 30, 0.9)',
    backdropFilter: 'blur(8px)',
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '0 16px',
    zIndex: 100,
    borderBottom: '1px solid rgba(255,255,255,0.1)',
  },
  chip: {
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    background: 'rgba(255,255,255,0.08)',
    border: 'none',
    borderRadius: 16,
    color: '#fff',
    fontSize: 12,
    fontWeight: 500,
    padding: '4px 10px',
    cursor: 'pointer',
    transition: 'opacity 0.15s',
    whiteSpace: 'nowrap',
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    flexShrink: 0,
  },
};
