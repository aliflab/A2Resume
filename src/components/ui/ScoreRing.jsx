import { band } from './scoreBands.js';

/**
 * A radial gauge for a percentage, coloured by its band. The number inside is
 * the caller's (children), so the ring never decides how a score is written.
 *
 * Decorative (aria-hidden): the same number is always printed as text next to
 * it, which is what assistive technology reads.
 */
const R = 52;
const CIRC = 2 * Math.PI * R;

export default function ScoreRing({ percentage, size = 136, tone, children }) {
  const pct = Math.max(0, Math.min(100, Number(percentage) || 0));
  const offset = CIRC * (1 - pct / 100);
  return (
    <div className={`score-ring score-ring--${tone ?? band(pct)}`} style={{ width: size, height: size }}>
      <svg viewBox="0 0 120 120" width={size} height={size} aria-hidden="true" focusable="false">
        <circle className="score-ring__track" cx="60" cy="60" r={R} />
        <circle
          className="score-ring__value"
          cx="60"
          cy="60"
          r={R}
          strokeDasharray={CIRC}
          strokeDashoffset={offset}
          style={{ '--ring-circ': CIRC }}
        />
      </svg>
      {children && <div className="score-ring__label">{children}</div>}
    </div>
  );
}
