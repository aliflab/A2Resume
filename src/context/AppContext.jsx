import { createContext, useCallback, useContext, useEffect, useMemo, useReducer } from 'react';

import { recoverBaseline, rescoreCurrentResume } from '../services/currentResume.js';
import { clearSession, loadSession, saveSession } from '../services/sessionPersistence.js';
import { applyTailoredEdit, dropPendingDraft, isDraftAddress, putPendingDraft, recordManualEdit } from '../services/tailoredEdits.js';

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

  /**
   * Output of analyzeCompetencyGaps / calculateATSScore for the CURRENT resume
   * (currentResume.js): the tailored copy when one exists, otherwise `resume`.
   * Recomputed by the reducer whenever the current resume changes -- see
   * RESCORING_ACTIONS below. Never stale relative to what Export prints.
   */
  gapAnalysis: null,
  atsScore: null,

  /**
   * The same two, as the Input run first computed them against the original
   * parse. A permanent baseline for "before tailoring": set once per run and
   * never recomputed. Often the very same objects as the current pair (no
   * tailoring yet), which is how persistence stores them only once.
   */
  originalGapAnalysis: null,
  originalAtsScore: null,

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
   * Which parts of `tailoredResume` the user has edited by hand since the
   * pass: `[{ section, index, label }]`, one row per part. Null means no
   * edits. Discarding or replacing the pass clears it, and says so first --
   * this is what lets Tailor and Input name the edits they would throw away.
   */
  tailorManualEdits: null,

  /**
   * Editor content typed but not yet saved: `[{ section, index, value }]`,
   * null when nothing is open. Autosaved on a debounce so a crash or a reload
   * does not silently lose typing -- see tailoredEdits.js.
   *
   * A draft is explicitly NOT part of the resume. Export never prints it and
   * the scorer never sees it; only UPDATE_TAILORED_SECTION (Save) moves
   * content into `tailoredResume`, and only that triggers a rescore.
   */
  draftEdits: null,

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
  /**
   * The Input pipeline's analysis and score. They set the current pair AND,
   * when none exists for this run yet, the baseline. Nothing else dispatches
   * these: every later rescore happens inside the reducer.
   */
  SET_GAP_ANALYSIS: 'set_gap_analysis',
  SET_ATS_SCORE: 'set_ats_score',
  /** Payload `{ resume, changesLog, corrections, parsedJD }` -- `parsedJD` is the one the pass was built against. */
  SET_TAILORED_RESUME: 'set_tailored_resume',
  CLEAR_TAILORING: 'clear_tailoring',
  /** One hand edit to one section (or one entry) of tailoredResume. See tailoredEdits.js. */
  UPDATE_TAILORED_SECTION: 'update_tailored_section',
  /** Autosave one open editor block's unsaved content. Payload `{ section, index, value }`. */
  SET_DRAFT_EDIT: 'set_draft_edit',
  /** Throw one pending draft away. Payload `{ section, index }`. */
  DISCARD_DRAFT_EDIT: 'discard_draft_edit',

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

/**
 * Every action that changes the current resume, and so rescores it. The
 * reducer recomputes inside the same transition rather than in an effect: an
 * effect would commit one render with the new resume and the old score, and
 * write that mismatched pair to storage. gapAnalyzer and atsScorer are pure,
 * synchronous and cheap, so doing it here costs nothing and cannot be skipped
 * by a caller that forgets.
 *
 * Exported so the pipeline scenario test can assert the list is complete.
 */
export const RESCORING_ACTIONS = [
  'SET_TAILORED_RESUME', // a pass lands: current becomes the tailored copy
  'UPDATE_TAILORED_SECTION', // a hand edit to the tailored copy
  'MERGE_INFERRED_SKILLS', // approved skills appended to either copy
  'CLEAR_TAILORING', // pass discarded: current falls back to `resume`
];

export function appReducer(state, action) {
  const next = reduce(state, action);
  if (next === state) return state;
  return RESCORING_ACTIONS.some((name) => ACTIONS[name] === action.type) ? rescoreCurrentResume(next) : next;
}

function reduce(state, action) {
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
    // The baseline is written only while empty. CLEAR_ANALYSIS empties it at
    // the start of every Input run, so it holds exactly that run's first
    // result and cannot be overwritten later by accident.
    case ACTIONS.SET_GAP_ANALYSIS:
      return { ...state, gapAnalysis: action.payload, originalGapAnalysis: state.originalGapAnalysis ?? action.payload };
    case ACTIONS.SET_ATS_SCORE:
      return { ...state, atsScore: action.payload, originalAtsScore: state.originalAtsScore ?? action.payload };

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
      // The same race with a new Input run instead of a reset: the run
      // replaces resume and parsedJD while an older pass is still in flight,
      // so `state.resume` is non-null again by the time the pass finishes.
      // Without this it would land, be scored against a JD it was never
      // tailored for, and show up on Export. Every run makes a new parsedJD
      // object, so identity says whether this pass belongs to the current one.
      // Identity, not the resume, because an approved skill replaces `resume`
      // mid-pass without making the pass stale.
      if (!state.parsedJD || payload.parsedJD !== state.parsedJD) return state;
      return {
        ...state,
        tailoredResume: payload.resume ?? null,
        changesLog: Array.isArray(payload.changesLog) ? payload.changesLog : [],
        tailorCorrections: Array.isArray(payload.corrections) ? payload.corrections : [],
        // A fresh pass carries no hand edits. Tailor only offers a new pass
        // after a discard, and the discard asks first when edits exist.
        tailorManualEdits: null,
        // A draft is a delta against the text the pass just replaced. Carrying
        // it over would silently overwrite the model's new wording with words
        // typed against the old, so a pending draft dies with the pass it
        // belonged to -- the same rule tailorManualEdits already follows.
        draftEdits: null,
      };
    }

    // Discard a tailoring pass without touching the analysis behind it.
    case ACTIONS.CLEAR_TAILORING:
      return { ...state, tailoredResume: null, changesLog: null, tailorCorrections: null, tailorManualEdits: null, draftEdits: null };

    // One section or one entry, never the whole resume. Invalid and no-op
    // edits return null from applyTailoredEdit and leave state untouched, so
    // they neither write storage nor show up in the edit log. With no
    // tailoring pass there is nothing to edit (the same rule as a pass that
    // lands after "Start over").
    case ACTIONS.UPDATE_TAILORED_SECTION: {
      const { section, index } = action.payload && typeof action.payload === 'object' ? action.payload : {};
      // Saving ends that block's draft whether or not the save changed
      // anything. A no-op save still closes the editor, and a draft left
      // behind would reopen it on the next load claiming to be unsaved work.
      const remaining = dropPendingDraft(state.draftEdits, section, index ?? null);
      const dropped = remaining !== state.draftEdits;
      // Emptied means gone, not an empty array: a spent draft must leave
      // nothing behind in storage to measure or to misread on the next load.
      const draftEdits = dropped ? (remaining.length > 0 ? remaining : null) : state.draftEdits;

      const result = applyTailoredEdit(state.tailoredResume, action.payload);
      if (!result) return dropped ? { ...state, draftEdits } : state;
      return {
        ...state,
        tailoredResume: result.resume,
        tailorManualEdits: recordManualEdit(state.tailorManualEdits, result.edit),
        draftEdits,
      };
    }

    // Autosave. Deliberately absent from RESCORING_ACTIONS: a draft is not yet
    // part of the current resume, so it must not move the score. Only the Save
    // above does that. Requires a tailoring pass -- there is nothing to draft
    // against otherwise -- and an address that names a real editable block, so
    // a malformed dispatch cannot park junk in storage.
    case ACTIONS.SET_DRAFT_EDIT: {
      const { section, index = null, value } = action.payload && typeof action.payload === 'object' ? action.payload : {};
      if (!state.tailoredResume || !isDraftAddress(section, index)) return state;
      const draftEdits = putPendingDraft(state.draftEdits, { section, index, value });
      // Identical to what is already stored: no state change, so no write.
      // This is what stops a repeated autosave tick from hammering storage.
      return draftEdits === state.draftEdits ? state : { ...state, draftEdits };
    }

    case ACTIONS.DISCARD_DRAFT_EDIT: {
      const { section, index = null } = action.payload && typeof action.payload === 'object' ? action.payload : {};
      const remaining = dropPendingDraft(state.draftEdits, section, index);
      if (remaining === state.draftEdits) return state;
      return { ...state, draftEdits: remaining.length > 0 ? remaining : null };
    }

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
        originalGapAnalysis: null,
        originalAtsScore: null,
        // Tailoring is derived from the analysis; leaving it behind would show
        // a tailored resume built from artefacts that no longer exist.
        tailoredResume: null,
        changesLog: null,
        tailorCorrections: null,
        tailorManualEdits: null,
        draftEdits: null,
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
 *
 * The current score is recomputed on the way in. With this build's scorer
 * and an unchanged resume that is a no-op, and the stored objects are kept.
 * It matters in two cases:
 * - A session saved before scores tracked the current resume holds the
 *   original score as its "current" one, even when a tailored resume exists.
 *   loadSession adopts that as the baseline, and this rescores the tailored copy.
 * - Build drift: a current score computed by an older scorer is replaced.
 *   The baseline is not rescored. It records what the Input run found.
 *
 * `recoverBaseline` then runs, in that order: it only acts on a session that
 * reached here with a score and no baseline, which is the state the rescore
 * above can itself create out of a save taken mid-run. See currentResume.js.
 */
export function hydrate(base, load = loadSession) {
  const { state: restored } = load();
  if (!restored) return base;
  return recoverBaseline(
    rescoreCurrentResume({
      ...base,
      ...restored,
      sources: { ...base.sources, ...(restored.sources ?? {}) },
      settings: { ...base.settings, ...(restored.settings ?? {}) },
      ui: base.ui,
    }),
  );
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
    originalGapAnalysis,
    originalAtsScore,
    tailoredResume,
    changesLog,
    tailorCorrections,
    tailorManualEdits,
    draftEdits,
    sources,
    settings,
  } = state;

  // Persist after every change to the pipeline slice -- each completed stage,
  // a tailoring result, a hand edit, an autosaved draft, merged skills, a
  // reset. Drafts ride this same write rather than a second storage
  // mechanism; the debounce lives in the editor, so one write per pause in
  // typing reaches here, not one per keystroke. `ui` is
  // deliberately not a dependency, so stage ticks and spinners never trigger a
  // write. A rescore happens inside the same reducer transition as the change
  // that caused it, so the resume and its score are always written together.
  useEffect(() => {
    saveSession({
      resumeText,
      resume,
      jobDescription,
      parsedJD,
      gapAnalysis,
      atsScore,
      originalGapAnalysis,
      originalAtsScore,
      tailoredResume,
      changesLog,
      tailorCorrections,
      tailorManualEdits,
      draftEdits,
      sources,
      settings,
    });
  }, [resumeText, resume, jobDescription, parsedJD, gapAnalysis, atsScore, originalGapAnalysis, originalAtsScore, tailoredResume, changesLog, tailorCorrections, tailorManualEdits, draftEdits, sources, settings]);

  // Dev-only handle for the __manual__ runners, which have to compare the live
  // store against storage across a reload, and to stand in for an action the
  // page would otherwise only reach through a paid AI call. Stripped from
  // production builds by the import.meta.env.DEV check -- assert 0 occurrences
  // in dist/ if you touch this.
  useEffect(() => {
    if (import.meta.env.DEV) window.a2resumeDev = { getState: () => state, dispatch };
  }, [state, dispatch]);

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
