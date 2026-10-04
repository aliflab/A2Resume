import { useMemo, useState } from 'react';

/**
 * One gap analysis rendered as matched / partial / missing buckets, grouped by
 * priority, with per-keyword density behind a click.
 *
 * WHY THIS IS A COMPONENT AND NOT A SECOND COPY
 * --------------------------------------------
 * It was `KeywordCard` inside `Analyze.jsx`. Match shows the same breakdown for
 * every posting in a batch, and a second implementation of it would drift --
 * the bucket labels, the "matched via your wording" line and the density
 * tooltips are explanations of how `gapAnalyzer` actually works, and two copies
 * of an explanation become two different explanations. So Analyze renders this
 * and so does each expanded Match row.
 *
 * The density map is deliberately NOT in the main view: it is per-keyword detail
 * that would triple the row count for something most readers never want. It
 * lives in each chip's `title` (hover) and in a click-to-expand line. That
 * decision is documented in CLAUDE.md and is preserved here unchanged.
 *
 * `title` is null on Match, where the surrounding row already names the posting
 * and a second "Keyword coverage" heading inside every row is noise. Analyze
 * passes the heading it always had, so its output is unchanged.
 */

const asArray = (v) => (Array.isArray(v) ? v : []);
const PRIORITIES = ['high', 'medium', 'low'];

export default function KeywordCoverage({ gap, title = 'Keyword coverage', idPrefix = '' }) {
  const [expanded, setExpanded] = useState(null);

  const buckets = useMemo(
    () => [
      { id: 'matched', label: 'Matched', items: asArray(gap.matched), tone: 'ok', blurb: 'Found in your resume as written.' },
      { id: 'partial', label: 'Partial', items: asArray(gap.partial), tone: 'warn', blurb: 'You said something equivalent, but not the words the posting uses.' },
      { id: 'missing', label: 'Missing', items: asArray(gap.missing), tone: 'poor', blurb: 'Not found anywhere in your resume.' },
    ],
    [gap]
  );

  const total = gap.totalKeywords ?? 0;

  const counts = buckets.map((b) => b.items.length);
  const counted = counts.reduce((a, b) => a + b, 0) || 1;

  return (
    <>
      {title && (
        <div className="section-head">
          <div>
            <h2>{title}</h2>
            <p className="muted">Click a keyword to see how often it appears in your resume.</p>
          </div>
        </div>
      )}
      <p className="coverage-summary">
        <span>
          <strong>{total}</strong> keyword{total === 1 ? '' : 's'} from the job description
        </span>
        <span>
          <strong>{gap.matchRate}%</strong> covered
        </span>
        {typeof gap.weightedMatchRate === 'number' && (
          <span>
            <strong>{gap.weightedMatchRate}%</strong> weighted by priority
          </span>
        )}
      </p>
      {total > 0 && (
        <div
          className="coverage-bar"
          role="img"
          aria-label={`${counts[0]} matched, ${counts[1]} partial, ${counts[2]} missing`}
        >
          {buckets.map((b, i) =>
            counts[i] > 0 ? (
              <span key={b.id} className={`coverage-bar__${b.tone}`} style={{ width: `${(counts[i] / counted) * 100}%` }} />
            ) : null
          )}
        </div>
      )}

      {total === 0 ? (
        <p className="muted">
          {asArray(gap.degraded?.reasons).join(' ') || 'No keywords were extracted from the job description.'}
        </p>
      ) : (
        <div className="buckets">
          {buckets.map((b) => (
            <div key={b.id} className={`bucket bucket--${b.id}`}>
              <h3 className={`bucket__title bucket__title--${b.tone}`}>
                {b.label} <span className="muted">({b.items.length})</span>
              </h3>
              <p className="muted bucket__blurb">{b.blurb}</p>

              {b.items.length === 0 ? (
                <p className="muted">None.</p>
              ) : (
                PRIORITIES.map((priority) => {
                  const items = b.items.filter((k) => k.priority === priority);
                  if (items.length === 0) return null;
                  return (
                    <div key={priority} className="bucket__group">
                      <p className="bucket__priority">{priority} priority</p>
                      <ul className="chips">
                        {items.map((k) => {
                          // Prefixed so several of these on one page (a Match
                          // batch) cannot collide and expand each other's chips.
                          const id = `${idPrefix}${b.id}-${k.keyword}`;
                          const open = expanded === id;
                          const count = gap.densityMap?.[k.keyword];
                          return (
                            <li key={id}>
                              <button
                                type="button"
                                className={`chip chip--${b.tone}${open ? ' chip--open' : ''}`}
                                onClick={() => setExpanded(open ? null : id)}
                                title={
                                  count
                                    ? `Appears ${count} time${count === 1 ? '' : 's'} in your resume`
                                    : 'Not found in your resume'
                                }
                                aria-expanded={open}
                              >
                                {k.keyword}
                                {count > 1 && <span className="chip__count">{count}</span>}
                              </button>
                              {open && (
                                <p className="chip__detail">
                                  {count
                                    ? `Appears ${count} time${count === 1 ? '' : 's'}.`
                                    : 'Does not appear.'}
                                  {k.matchedVia && k.matchedVia !== k.keyword && (
                                    <> Matched via your wording &ldquo;{k.matchedVia}&rdquo;.</>
                                  )}
                                </p>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  );
                })
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
