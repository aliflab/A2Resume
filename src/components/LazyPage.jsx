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
          <section className="page" aria-busy="true">
            <p className="muted" role="status">
              Loading...
            </p>
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
          <p className="inline-status inline-status--error" role="alert">
            This page could not be loaded. Check your connection and reload the page to try again. Your work is saved
            in this browser.
          </p>
        </section>
      );
    }
    return this.props.children;
  }
}
