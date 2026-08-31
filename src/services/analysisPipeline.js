/**
 * The four-step intake pipeline, in one place.
 *
 *   parseResumeWithAI -> parseJobDescriptionWithAI
 *     -> analyzeCompetencyGaps -> calculateATSScore
 *
 * Deliberately React-free, like every other service here. It reports progress
 * and results through callbacks, and the page decides what that means for
 * AppContext. Keeping the dispatch out of this file is what lets the pipeline
 * be driven from a console, a test, or a future "re-run" button on another
 * page without any of them agreeing on a store shape.
 *
 * The two AI calls run in sequence rather than in parallel on purpose. A key
 * that is going to be rejected should be rejected once, on the first step,
 * rather than producing two simultaneous auth failures and a race over which
 * error the user sees.
 */

import { parseResumeWithAI } from './resumeParser.js';
import { parseJobDescriptionWithAI } from './jdParser.js';
import { analyzeCompetencyGaps } from './gapAnalyzer.js';
import { calculateATSScore } from './atsScorer.js';

/**
 * @typedef {'parseResume'|'parseJD'|'gapAnalysis'|'atsScore'} StageId
 */

/**
 * Run the full pipeline.
 *
 * @param {object} args
 * @param {string} args.resumeText Raw resume text.
 * @param {string} args.jdText Raw job description text.
 * @param {string} args.provider Provider id.
 * @param {string} args.apiKey The user's key for that provider.
 * @param {(stage: StageId) => void} [args.onStage] Fired as each step starts.
 * @param {(key: string, value: unknown) => void} [args.onResult] Fired as each
 *   step finishes, with the artefact it produced. This is the hook the page
 *   uses to dispatch into AppContext incrementally, so a later failure still
 *   leaves the earlier results on screen.
 * @param {AbortSignal} [args.signal] Abandon the run between steps.
 * @returns {Promise<{ resume: object, parsedJD: object, gapAnalysis: object, atsScore: object, diagnostics: object }>}
 */
export async function runAnalysisPipeline({
  resumeText,
  jdText,
  provider,
  apiKey,
  onStage,
  onResult,
  signal,
}) {
  if (typeof resumeText !== 'string' || resumeText.trim() === '') {
    throw new Error('runAnalysisPipeline: resumeText is empty.');
  }
  if (typeof jdText !== 'string' || jdText.trim() === '') {
    throw new Error('runAnalysisPipeline: jdText is empty.');
  }
  if (!provider || !apiKey) {
    throw new Error('runAnalysisPipeline: a provider and its API key are required.');
  }

  // Checked between steps rather than threaded into the providers: the AI
  // calls already own their own timeout AbortController, and handing them a
  // second signal would let a cancel surface as an opaque provider error.
  const abortIfCancelled = () => {
    if (signal?.aborted) {
      const err = new Error('Run cancelled.');
      err.name = 'AbortError';
      throw err;
    }
  };

  const diagnostics = {};

  // --- 1. Resume ------------------------------------------------------------
  abortIfCancelled();
  onStage?.('parseResume');
  const resumeResult = await parseResumeWithAI(resumeText, { provider, apiKey });
  diagnostics.resume = {
    model: resumeResult.model,
    fenced: resumeResult.fenced,
    salvaged: resumeResult.salvaged,
  };
  onResult?.('resume', resumeResult.data);

  // --- 2. Job description ---------------------------------------------------
  abortIfCancelled();
  onStage?.('parseJD');
  const jdResult = await parseJobDescriptionWithAI(jdText, { provider, apiKey });
  diagnostics.jd = {
    model: jdResult.model,
    fenced: jdResult.fenced,
    salvaged: jdResult.salvaged,
  };
  onResult?.('parsedJD', jdResult.data);

  // --- 3 and 4. Local, deterministic, fast ---------------------------------
  // No network and no key. They are still reported as stages because a user
  // watching a progress list should see the whole pipeline, not just the
  // slow half of it.
  abortIfCancelled();
  onStage?.('gapAnalysis');
  const gapAnalysis = analyzeCompetencyGaps(resumeResult.data, jdResult.data);
  onResult?.('gapAnalysis', gapAnalysis);

  abortIfCancelled();
  onStage?.('atsScore');
  const atsScore = calculateATSScore(resumeResult.data, jdResult.data, gapAnalysis);
  onResult?.('atsScore', atsScore);

  return {
    resume: resumeResult.data,
    parsedJD: jdResult.data,
    gapAnalysis,
    atsScore,
    diagnostics,
  };
}
