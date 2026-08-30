import { createBrowserRouter } from 'react-router';

import App from './App.jsx';
import Landing from './pages/Landing.jsx';
import Workspace from './pages/Workspace.jsx';
import Analyze from './pages/Analyze.jsx';
import Tailor from './pages/Tailor.jsx';
import Export from './pages/Export.jsx';
import Match from './pages/Match.jsx';
import CoverLetter from './pages/CoverLetter.jsx';
import Designer from './pages/Designer.jsx';
import Settings from './pages/Settings.jsx';
import NotFound from './pages/NotFound.jsx';

export const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <Landing /> },
      { path: 'app', element: <Workspace /> },
      { path: 'analyze', element: <Analyze /> },
      { path: 'tailor', element: <Tailor /> },
      { path: 'export', element: <Export /> },
      { path: 'match', element: <Match /> },
      { path: 'cover-letter', element: <CoverLetter /> },
      { path: 'designer', element: <Designer /> },
      { path: 'settings', element: <Settings /> },
      { path: '*', element: <NotFound /> },
    ],
  },
]);
