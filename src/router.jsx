import { lazy } from 'react';
import { createBrowserRouter } from 'react-router';

import App from './App.jsx';
import LazyPage from './components/LazyPage.jsx';
import Landing from './pages/Landing.jsx';
import Workspace from './pages/Workspace.jsx';
import InputPage from './pages/InputPage.jsx';
import Analyze from './pages/Analyze.jsx';
import Export from './pages/Export.jsx';
import Settings from './pages/Settings.jsx';
import NotFound from './pages/NotFound.jsx';
import { loadTailor } from './routeChunks.js';

// Loaded on demand, like pdfParser.js and PdfPreview.jsx, to keep the entry
// chunk under Vite's 500 kB warning without raising the limit.
//
// Chosen by measurement, not by guessing (2026-09-27, minified entry chunk):
// 508.62 kB with every page static; making these three lazy took it to
// 465.08 kB. They are the side tools -- off the Input -> Analyze -> Tailor ->
// Export path most visits take -- so a first load rarely needs them.
// The core wizard stays static on purpose: lazy-loading it would put a fetch
// between two wizard steps. Settings (-4.3 kB) is not worth it, since a new
// user's first stop is adding a key there.
//
// Tailor joined them on 2026-10-04, when the redesign took the entry chunk to
// 501.65 kB. It is a wizard step, so it is prefetched from Analyze (see
// routeChunks.js): the chunk is cached before the user can click through.
const Tailor = lazy(loadTailor);
const Match = lazy(() => import('./pages/Match.jsx'));
const CoverLetter = lazy(() => import('./pages/CoverLetter.jsx'));
const Designer = lazy(() => import('./pages/Designer.jsx'));

export const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <Landing /> },
      // Step 1 of the wizard. Workspace stays routed at /app until it has
      // real content of its own.
      { path: 'input', element: <InputPage /> },
      { path: 'app', element: <Workspace /> },
      { path: 'analyze', element: <Analyze /> },
      {
        path: 'tailor',
        element: (
          <LazyPage>
            <Tailor />
          </LazyPage>
        ),
      },
      { path: 'export', element: <Export /> },
      {
        path: 'match',
        element: (
          <LazyPage>
            <Match />
          </LazyPage>
        ),
      },
      {
        path: 'cover-letter',
        element: (
          <LazyPage>
            <CoverLetter />
          </LazyPage>
        ),
      },
      {
        path: 'designer',
        element: (
          <LazyPage>
            <Designer />
          </LazyPage>
        ),
      },
      { path: 'settings', element: <Settings /> },
      { path: '*', element: <NotFound /> },
    ],
  },
]);
