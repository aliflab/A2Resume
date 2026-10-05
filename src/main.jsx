import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router/dom';

import { router } from './router.jsx';
import { AppProvider } from './context/AppContext.jsx';
import { initTheme } from './services/themeService.js';
import './styles.css';

initTheme();

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <AppProvider>
      <RouterProvider router={router} />
    </AppProvider>
  </StrictMode>
);
