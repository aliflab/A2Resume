import Spinner from './Spinner.jsx';

/**
 * What the PDF preview area shows while its chunk (react-pdf, ~460 kB gzip)
 * loads: the shape of a page, so the layout does not jump when the real
 * document arrives. Used as the Suspense fallback on Export, Designer and
 * Cover Letter.
 */
export default function PreviewSkeleton({ label = 'Preparing the PDF preview…' }) {
  return (
    <div className="preview-loading" role="status" aria-busy="true">
      <span className="preview-skeleton" aria-hidden="true">
        <span className="skeleton skeleton--paper skeleton--title" />
        <span className="skeleton skeleton--paper" />
        <span className="skeleton skeleton--paper skeleton--short" />
        <span className="skeleton skeleton--paper" style={{ marginTop: 'var(--space-6)' }} />
        <span className="skeleton skeleton--paper" />
        <span className="skeleton skeleton--paper skeleton--short" />
        <span className="skeleton skeleton--paper" style={{ marginTop: 'var(--space-6)' }} />
        <span className="skeleton skeleton--paper skeleton--short" />
      </span>
      <span className="preview-loading__label">
        <Spinner />
        {label}
      </span>
    </div>
  );
}
