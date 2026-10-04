/**
 * Loaders for the route chunks that are split out of the entry bundle.
 *
 * One function per chunk, shared by router.jsx (React.lazy) and by the pages
 * that warm a chunk before the user asks for it. Both call the same dynamic
 * import, so Vite emits one chunk and the browser fetches it once: a prefetch
 * that has finished makes the later lazy render instant.
 *
 * Tailor is split out because the redesign took the entry chunk past Vite's
 * 500 kB warning (see CLAUDE.md, Code splitting). Unlike the side tools, it is
 * a wizard step, and the reason the wizard stayed static was to keep a fetch
 * from sitting between two steps. Prefetching it from Analyze -- the step
 * before it -- keeps that promise: by the time Tailor is clicked, the chunk is
 * already in the cache. Same-origin, the app's own file; nothing third-party.
 */
export const loadTailor = () => import('./pages/Tailor.jsx');

/** Warm a chunk without caring about the result. A failure surfaces later, in LazyPage. */
export function prefetch(loader) {
  loader().catch(() => {});
}
