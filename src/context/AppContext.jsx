import { createContext, useCallback, useContext, useEffect, useMemo, useReducer } from 'react';

import { clearSession, loadSession, saveSession } from '../services/sessionPersistence.js';

/**
 * The single global store for the app. useReducer + Context only --
 * do not introduce Redux, Zustand, or any other state library.
 *
 * EVERY PAGE MUST TOLERATE EMPTY STATE.
 * There are no route guards, so any page can be loaded cold with nothing but
 * `initialState` -- a bookmarked /analyze, a first visit, a session that was
 * cleared, or stored data that was missing or corrupt. The pipeline slice is
 * persisted (sessionPersistence.js) so a reload usually restores it, but
 * "usually" is not a guarantee: guard every read. `null` for "not produced
 * yet" is a normal value here, not an error condition.
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

/**
 * `target` with the new skills from `incoming` appended under
 * INFERRED_SKILLS_CATEGORY, or null when every one is already present.
 */
function withInferredSkills(target, incoming) {
  const groups = Array.isArray(target.skills) ? target.skills : [];

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
  if (fresh.length === 0) return null;

  const at = groups.findIndex((g) => g?.category === INFERRED_SKILLS_CATEGORY);
  const skills =
    at === -1
      ? [...groups, { category: INFERRED_SKILLS_CATEGORY, skills: fresh }]
      : groups.map((g, i) => (i === at ? { ...g, skills: [...(Array.isArray(g.skills) ? g.skills : []), ...fresh] } : g));

  return { ...target, skills };
}

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
      // A tailoring pass is derived from the resume. One that finishes after
      // "Start over" wiped the resume would otherwise land in an empty store,
      // be persisted, and resurface on Export as a resume with no source.
      // Tailor's busy flag is page-local, so the reset cannot see it to wait.
      if (!state.resume) return state;
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
    //
    // A tailoring pass that already exists gets the same append. Export prefers
    // `tailoredResume`, so writing to `resume` alone left an approved skill
    // invisible there until Tailor was re-run. Appending is what a re-run would
    // produce anyway: mergeNonDestructiveResume unions skills, so every skill in
    // `resume` ends up in the tailored copy. Clearing the pass instead would
    // throw away a paid, already-reviewed rewrite to add one skill. Each copy is
    // de-duplicated against itself, since the tailored one may hold skills the
    // model added that the original lacks.
    case ACTIONS.MERGE_INFERRED_SKILLS: {
      const incoming = Array.isArray(action.payload) ? action.payload.filter((s) => typeof s === 'string' && s.trim()) : [];
      if (incoming.length === 0) return state;

      const resume = withInferredSkills(state.resume && typeof state.resume === 'object' ? state.resume : {}, incoming);
      const tailoredResume =
        state.tailoredResume && typeof state.tailoredResume === 'object' && !Array.isArray(state.tailoredResume)
          ? withInferredSkills(state.tailoredResume, incoming)
          : null;
      if (!resume && !tailoredResume) return state;

      return {
        ...state,
        resume: resume ?? state.resume,
        tailoredResume: tailoredResume ?? state.tailoredResume,
      };
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

/**
 * Lazy initialiser: hydrate from the stored session before the first render.
 *
 * It has to happen here, not in an effect. Pages seed their local form state
 * from the store once, on mount (InputPage's textareas do exactly this), so a
 * store that fills in one render later would leave them empty.
 *
 * `ui` always starts from `initialState` -- see sessionPersistence.js.
 */
function hydrate(base) {
  const { state: restored } = loadSession();
  if (!restored) return base;
  return {
    ...base,
    ...restored,
    sources: { ...base.sources, ...(restored.sources ?? {}) },
    settings: { ...base.settings, ...(restored.settings ?? {}) },
    ui: base.ui,
  };
}

export function AppProvider({ children }) {
  const [state, dispatch] = useReducer(appReducer, initialState, hydrate);

  const {
    resumeText,
    resume,
    jobDescription,
    parsedJD,
    gapAnalysis,
    atsScore,
    tailoredResume,
    changesLog,
    tailorCorrections,
    sources,
    settings,
  } = state;

  // Persist after every change to the pipeline slice -- each completed stage,
  // a tailoring result, merged skills, a reset. `ui` is deliberately not a
  // dependency, so stage ticks and spinners never trigger a write. Batched
  // dispatches (the re-score's two) commit as one render and one write.
  useEffect(() => {
    saveSession({
      resumeText,
      resume,
      jobDescription,
      parsedJD,
      gapAnalysis,
      atsScore,
      tailoredResume,
      changesLog,
      tailorCorrections,
      sources,
      settings,
    });
  }, [resumeText, resume, jobDescription, parsedJD, gapAnalysis, atsScore, tailoredResume, changesLog, tailorCorrections, sources, settings]);

  // Dev-only read handle for __manual__/session.manual.js, which has to compare
  // the live store against storage across a reload. Stripped from production
  // builds by the import.meta.env.DEV check.
  useEffect(() => {
    if (import.meta.env.DEV) window.a2resumeDev = { getState: () => state };
  }, [state]);

  /** "Start over": delete the stored session, then empty the store. API keys are untouched. */
  const resetSession = useCallback(() => {
    clearSession();
    dispatch({ type: ACTIONS.RESET });
  }, []);

  const value = useMemo(() => ({ state, dispatch, resetSession }), [state, resetSession]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const context = useContext(AppContext);
  if (context === null) {
    throw new Error('useApp must be used inside an <AppProvider>');
  }
  return context;
}
