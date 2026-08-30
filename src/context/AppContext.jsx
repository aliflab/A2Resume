import { createContext, useContext, useMemo, useReducer } from 'react';

/**
 * The single global store for the app. useReducer + Context only --
 * do not introduce Redux, Zustand, or any other state library.
 */
export const initialState = {
  resume: null,
  jobDescription: '',
  settings: {},
  ui: {
    status: 'idle',
  },
};

export const ACTIONS = {
  RESET: 'reset',
  SET_RESUME: 'set_resume',
  SET_JOB_DESCRIPTION: 'set_job_description',
  SET_SETTINGS: 'set_settings',
  SET_STATUS: 'set_status',
};

export function appReducer(state, action) {
  switch (action.type) {
    case ACTIONS.RESET:
      return initialState;
    case ACTIONS.SET_RESUME:
      return { ...state, resume: action.payload };
    case ACTIONS.SET_JOB_DESCRIPTION:
      return { ...state, jobDescription: action.payload };
    case ACTIONS.SET_SETTINGS:
      return { ...state, settings: { ...state.settings, ...action.payload } };
    case ACTIONS.SET_STATUS:
      return { ...state, ui: { ...state.ui, status: action.payload } };
    default:
      return state;
  }
}

const AppContext = createContext(null);

export function AppProvider({ children }) {
  const [state, dispatch] = useReducer(appReducer, initialState);
  const value = useMemo(() => ({ state, dispatch }), [state]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const context = useContext(AppContext);
  if (context === null) {
    throw new Error('useApp must be used inside an <AppProvider>');
  }
  return context;
}
