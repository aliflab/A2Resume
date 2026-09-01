import { createContext, useContext, useMemo, useReducer } from 'react';

/**
 * The single global store for the app. useReducer + Context only --
 * do not introduce Redux, Zustand, or any other state library.
 *
 * EVERY PAGE MUST TOLERATE EMPTY STATE.
 * There are no route guards, so any page can be loaded cold with nothing but
 * `initialState` -- a bookmarked /analyze, a hard refresh mid-flow, a shared
 * link. Guard every read. `null` for "not produced yet" is a normal value
 * here, not an error condition.
 */
export const initialState = {
  /** Raw resume text, before parsing. Kept so a re-run needs no re-upload. */
  resumeText: '',
  /** Parsed resume object from parseResumeWithAI. Any key may be absent. */
  resume: null,

  /** Raw job description text, however it was obtained. */
  jobDescription: '',
  /** Parsed JD object from parseJobDescriptionWithAI. Any key may be absent. */
  parsedJD: null,

  /** Output of analyzeCompetencyGaps. */
  gapAnalysis: null,
  /** Output of calculateATSScore. */
  atsScore: null,

  /**
   * Output of tailorResumeWithAI, after mergeNonDestructiveResume has run.
   * Kept separate from `resume` on purpose: the original parse stays intact so
   * a tailoring pass can be reviewed, rejected, or re-run without re-uploading.
   */
  tailoredResume: null,
  /** The model's before/after log for the tailoring pass. */
  changesLog: null,
  /** What the merge safety net had to correct in the model's output. */
  tailorCorrections: null,

  /**
   * Where each artefact came from, for display and for deciding whether a
   * re-run is cheap. Not load-bearing -- nothing branches on it.
   */
  sources: {
    resume: null, // 'pdf' | 'paste'
    jobDescription: null, // 'url' | 'paste'
    resumeFileName: null,
    jobDescriptionUrl: null,
    provider: null, // the provider that produced the current artefacts
  },

  settings: {
    /** Provider chosen for the next run. Persisted choice lives in Settings. */
    provider: null,
  },

  ui: {
    status: 'idle', // 'idle' | 'running' | 'done' | 'error'
    /** Which pipeline step is in flight; null when not running. */
    stage: null,
    /** { message, code, kind, isAuth } -- never a raw Error object. */
    error: null,
  },
};

/**
 * The pipeline steps, in order. Exported so the progress indicator and the
 * runner agree on the list rather than each keeping its own copy.
 */
export const PIPELINE_STAGES = [
  { id: 'parseResume', label: 'Reading your resume' },
  { id: 'parseJD', label: 'Reading the job description' },
  { id: 'gapAnalysis', label: 'Comparing against the role' },
  { id: 'atsScore', label: 'Scoring for ATS' },
];

export const ACTIONS = {
  RESET: 'reset',

  SET_RESUME_TEXT: 'set_resume_text',
  SET_RESUME: 'set_resume',
  SET_JOB_DESCRIPTION: 'set_job_description',
  SET_PARSED_JD: 'set_parsed_jd',
  SET_GAP_ANALYSIS: 'set_gap_analysis',
  SET_ATS_SCORE: 'set_ats_score',
  SET_TAILORED_RESUME: 'set_tailored_resume',
  CLEAR_TAILORING: 'clear_tailoring',

  SET_SOURCES: 'set_sources',
  SET_SETTINGS: 'set_settings',

  SET_STATUS: 'set_status',
  SET_STAGE: 'set_stage',
  SET_ERROR: 'set_error',

  /** Append user-approved inferred skills to resume.skills. */
  MERGE_INFERRED_SKILLS: 'merge_inferred_skills',

  /** Clear every pipeline artefact without touching settings. */
  CLEAR_ANALYSIS: 'clear_analysis',
};

/**
 * Category the inference step files its suggestions under. Kept distinct from
 * whatever the resume itself declared, so an approved *inference* is never
 * silently indistinguishable from something the candidate actually wrote.
 */
export const INFERRED_SKILLS_CATEGORY = 'Inferred from experience';

export function appReducer(state, action) {
  switch (action.type) {
    case ACTIONS.RESET:
      return initialState;

    case ACTIONS.SET_RESUME_TEXT:
      return { ...state, resumeText: action.payload };
    case ACTIONS.SET_RESUME:
      return { ...state, resume: action.payload };
    case ACTIONS.SET_JOB_DESCRIPTION:
      return { ...state, jobDescription: action.payload };
    case ACTIONS.SET_PARSED_JD:
      return { ...state, parsedJD: action.payload };
    case ACTIONS.SET_GAP_ANALYSIS:
      return { ...state, gapAnalysis: action.payload };
    case ACTIONS.SET_ATS_SCORE:
      return { ...state, atsScore: action.payload };

    // One dispatch for the whole tailoring result. The resume, the log of what
    // changed, and what the merge had to correct are produced together and are
    // only meaningful together -- splitting them across three actions would
    // allow a render between them showing a tailored resume with no changelog.
    case ACTIONS.SET_TAILORED_RESUME: {
      const payload = action.payload && typeof action.payload === 'object' ? action.payload : {};
      return {
        ...state,
        tailoredResume: payload.resume ?? null,
        changesLog: Array.isArray(payload.changesLog) ? payload.changesLog : [],
        tailorCorrections: Array.isArray(payload.corrections) ? payload.corrections : [],
      };
    }

    // Discard a tailoring pass without touching the analysis behind it.
    case ACTIONS.CLEAR_TAILORING:
      return { ...state, tailoredResume: null, changesLog: null, tailorCorrections: null };

    case ACTIONS.SET_SOURCES:
      return { ...state, sources: { ...state.sources, ...action.payload } };
    case ACTIONS.SET_SETTINGS:
      return { ...state, settings: { ...state.settings, ...action.payload } };

    case ACTIONS.SET_STATUS:
      return { ...state, ui: { ...state.ui, status: action.payload } };
    case ACTIONS.SET_STAGE:
      return { ...state, ui: { ...state.ui, stage: action.payload } };

    // An error always ends the run, so status and stage move with it rather
    // than leaving a stale spinner behind for a caller to remember to clear.
    case ACTIONS.SET_ERROR:
      return {
        ...state,
        ui: {
          ...state.ui,
          error: action.payload,
          status: action.payload ? 'error' : state.ui.status,
          stage: action.payload ? null : state.ui.stage,
        },
      };

    // Appends only. It never rewrites an existing category's list, never
    // touches any other part of the resume, and de-duplicates against every
    // skill already present so an approval cannot create a double entry.
    case ACTIONS.MERGE_INFERRED_SKILLS: {
      const incoming = Array.isArray(action.payload) ? action.payload.filter((s) => typeof s === 'string' && s.trim()) : [];
      if (incoming.length === 0) return state;

      const resume = state.resume && typeof state.resume === 'object' ? state.resume : {};
      const groups = Array.isArray(resume.skills) ? resume.skills : [];

      const key = (s) => s.toLowerCase().replace(/[^a-z0-9+#]/g, '');
      const existing = new Set(
        groups.flatMap((g) => (Array.isArray(g?.skills) ? g.skills : [])).filter((s) => typeof s === 'string').map(key)
      );

      const fresh = [];
      for (const skill of incoming) {
        const k = key(skill);
        if (!k || existing.has(k)) continue;
        existing.add(k);
        fresh.push(skill.trim());
      }
      if (fresh.length === 0) return state;

      const at = groups.findIndex((g) => g?.category === INFERRED_SKILLS_CATEGORY);
      const skills =
        at === -1
          ? [...groups, { category: INFERRED_SKILLS_CATEGORY, skills: fresh }]
          : groups.map((g, i) =>
              i === at ? { ...g, skills: [...(Array.isArray(g.skills) ? g.skills : []), ...fresh] } : g
            );

      return { ...state, resume: { ...resume, skills } };
    }

    case ACTIONS.CLEAR_ANALYSIS:
      return {
        ...state,
        resume: null,
        parsedJD: null,
        gapAnalysis: null,
        atsScore: null,
        // Tailoring is derived from the analysis; leaving it behind would show
        // a tailored resume built from artefacts that no longer exist.
        tailoredResume: null,
        changesLog: null,
        tailorCorrections: null,
        ui: { ...state.ui, status: 'idle', stage: null, error: null },
      };

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
