import { Component, Suspense } from 'react';

/**
 * The frame around a route whose page is loaded on demand (React.lazy in
 * router.jsx). Two jobs:
 *
 * - A loading state while the page's chunk is fetched. It renders inside the
 *   app shell's <main>, so the header and nav stay put and only the page area
 *   says it is loading -- the same reason Export shows "Loading the PDF
 *   preview..." rather than blanking the page.
 * - A failure state. A statically imported page cannot fail to load; a lazy
 *   one can: offline, or after a redeploy has replaced the hashed chunk the
 *   open tab still refers to. Without this, React Router's generic error
 *   screen would replace the whole app, header included.
 *
 * Nothing here is page-specific, so every lazy route shares it.
 */
export default function LazyPage({ children }) {
  return (
    <LazyPageBoundary>
      <Suspense
        fallback={
          // The shape of a page, faded in after 150 ms so a fast chunk load
          // never flashes it. "Loading..." stays as the accessible status.
          <section className="page-skeleton" aria-busy="true">
            <p className="visually-hidden" role="status">
              Loading...
            </p>
            <div className="page-skeleton__head" aria-hidden="true">
              <span className="skeleton skeleton--eyebrow" />
              <span className="skeleton skeleton--title" />
              <span className="skeleton skeleton--short" />
            </div>
            <span className="skeleton skeleton--block" aria-hidden="true" />
            <span className="skeleton skeleton--block" aria-hidden="true" />
          </section>
        }
      >
        {children}
      </Suspense>
    </LazyPageBoundary>
  );
}

class LazyPageBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return (
        <section className="page">
          <div className="error-notice" role="alert">
            <div className="error-notice__body">
              <p className="error-notice__title">This page couldn&rsquo;t be loaded</p>
              <p className="error-notice__message">
                This page could not be loaded. Check your connection and reload the page to try again. Your work is
                saved in this browser.
              </p>
            </div>
          </div>
        </section>
      );
    }
    return this.props.children;
  }
}
