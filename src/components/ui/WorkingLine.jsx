import { useEffect, useState } from 'react';

/**
 * Seconds since the component using it mounted. One interval, cleared on
 * unmount; the state is only ever set from the timer callback, never in the
 * effect body.
 */
export function useElapsed() {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  return elapsed;
}

/**
 * "Still working" for an operation, in words, with a bar under it.
 *
 * - `label`: what is happening now, specific to the operation ("Improving
 *   relevant sections with Claude…"). It sits in a role="status" region, so a
 *   screen reader hears it change.
 * - `detail`: an optional second, quieter line.
 * - `progress`: 0..1 when the work is measurable (pages read, postings
 *   scored); the bar is then determinate. Omitted, the bar is indeterminate --
 *   an honest "we cannot say how far along this is".
 * - `showElapsed`: seconds so far, for waits with no measurable progress, so a
 *   long AI call reads as work rather than a hang.
 */
export default function WorkingLine({ label, detail, progress, showElapsed = true }) {
  const elapsed = useElapsed();
  const determinate = typeof progress === 'number' && Number.isFinite(progress);
  const pct = determinate ? Math.max(0, Math.min(100, progress * 100)) : 0;

  return (
    <div className="loading-line" role="status">
      <span className="loading-line__text">
        <span>{label}</span>
        {showElapsed && (
          <span className="loading-line__elapsed" aria-hidden="true">
            {elapsed}s
          </span>
        )}
      </span>
      {detail && <span className="loading-line__detail">{detail}</span>}
      {determinate ? (
        <span className="progress-bar progress-bar--determinate" aria-hidden="true">
          <span style={{ width: `${pct}%` }} />
        </span>
      ) : (
        <span className="progress-bar" aria-hidden="true" />
      )}
    </div>
  );
}
