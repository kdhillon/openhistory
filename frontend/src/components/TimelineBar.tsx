import { YEAR_MIN, YEAR_MAX } from '../types';
import { displayYear } from '../hooks/useTimeline';

interface Props {
  currentYear: number;
  stepSize: number;
  stepOptions: number[];
  isPlaying: boolean;
  playbackSpeed: number;
  onSeek: (year: number) => void;
  onStep: (dir: 1 | -1) => void;
  onTogglePlay: () => void;
  onSetStepSize: (s: number) => void;
  onSetSpeed: (s: number) => void;
}

const SPEED_OPTIONS = [5, 10, 25, 50];

export function TimelineBar({
  currentYear,
  stepSize,
  stepOptions,
  isPlaying,
  playbackSpeed,
  onSeek,
  onStep,
  onTogglePlay,
  onSetStepSize,
  onSetSpeed,
}: Props) {
  const yearLabel = displayYear(currentYear);
  const isFuzzyDisplay = currentYear === 0;

  return (
    <div style={styles.bar}>
      {/* Left controls */}
      <div style={styles.controls}>
        <button style={styles.btn} onClick={() => onStep(-1)} title="Step back">‹</button>
        <button style={{ ...styles.btn, ...styles.playBtn }} onClick={onTogglePlay} title={isPlaying ? 'Pause' : 'Play'}>
          {isPlaying ? '⏸' : '▶'}
        </button>
        <button style={styles.btn} onClick={() => onStep(1)} title="Step forward">›</button>
      </div>

      {/* Slider */}
      <div style={styles.sliderWrapper}>
        <input
          type="range"
          min={YEAR_MIN}
          max={YEAR_MAX}
          step={stepSize}
          value={currentYear}
          onChange={(e) => onSeek(Number(e.target.value))}
          style={styles.slider}
        />
      </div>

      {/* Year display */}
      <div style={{ ...styles.yearLabel, ...(isFuzzyDisplay ? styles.fuzzy : {}) }}>
        {yearLabel}
      </div>

      {/* Right controls */}
      <div style={styles.controls}>
        <label style={styles.label}>Step</label>
        <select
          style={styles.select}
          value={stepSize}
          onChange={(e) => onSetStepSize(Number(e.target.value))}
        >
          {stepOptions.map((s) => (
            <option key={s} value={s}>{s}yr</option>
          ))}
        </select>

        <label style={styles.label}>Speed</label>
        <select
          style={styles.select}
          value={playbackSpeed}
          onChange={(e) => onSetSpeed(Number(e.target.value))}
        >
          {SPEED_OPTIONS.map((s) => (
            <option key={s} value={s}>{s}yr/s</option>
          ))}
        </select>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  bar: {
    position: 'fixed',
    bottom: 0,
    left: 0,
    right: 0,
    height: 56,
    background: 'rgba(20, 20, 30, 0.92)',
    backdropFilter: 'blur(8px)',
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '0 16px',
    zIndex: 100,
    borderTop: '1px solid rgba(255,255,255,0.1)',
  },
  controls: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    flexShrink: 0,
  },
  btn: {
    background: 'rgba(255,255,255,0.1)',
    border: 'none',
    color: '#fff',
    borderRadius: 4,
    width: 32,
    height: 32,
    cursor: 'pointer',
    fontSize: 18,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  playBtn: {
    background: 'rgba(66, 133, 244, 0.6)',
    fontSize: 14,
  },
  sliderWrapper: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
  },
  slider: {
    width: '100%',
    accentColor: '#4285F4',
  },
  yearLabel: {
    color: '#fff',
    fontWeight: 600,
    fontSize: 15,
    minWidth: 90,
    textAlign: 'center',
    fontVariantNumeric: 'tabular-nums',
    flexShrink: 0,
  },
  fuzzy: {
    color: '#F4B400',
  },
  label: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 11,
    marginLeft: 8,
  },
  select: {
    background: 'rgba(255,255,255,0.1)',
    border: 'none',
    color: '#fff',
    borderRadius: 4,
    padding: '2px 6px',
    fontSize: 12,
    cursor: 'pointer',
  },
};
