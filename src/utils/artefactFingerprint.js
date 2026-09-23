/**
 * A stable short hash of whatever a derived artefact was built from.
 *
 * WHY A FINGERPRINT AND NOT A LIST OF INVALIDATING ACTIONS
 * -------------------------------------------------------
 * The current resume changes through at least six paths -- a new tailoring
 * pass, a hand edit, an entry added, an entry removed, approved inferred
 * skills, a discarded pass -- and `RESCORING_ACTIONS` already exists because
 * that list is easy to add to and easy to forget. An artefact invalidated by an
 * enumeration of actions silently stops noticing the day a seventh path is
 * added. Comparing the thing itself catches any path that changes the resume,
 * including ones that do not exist yet. It is also the approach CLAUDE.md
 * already names as the fix for derived-artefact drift.
 *
 * WHY THIS LIVES HERE AND NOT IN coverLetterGenerator
 * --------------------------------------------------
 * It was written there first, for the cover letter. `matchRunner` needs exactly
 * the same thing, and having it import from `coverLetterGenerator` would tie
 * the Match page to the cover letter for no reason. `coverLetterGenerator`
 * re-exports `fingerprint` so its public API is unchanged -- the same shape as
 * `uploadLimits.js` being re-exported from `pdfParser.js`.
 *
 * Keys are sorted, so an object rebuilt by a spread in a different order
 * fingerprints the same. The hash is FNV-1a: not cryptographic, and it does not
 * need to be -- a collision means failing to warn that an artefact is stale,
 * and the consequence of that is bounded by the user reading what is in front
 * of them. The length is appended, which makes a collision need both an equal
 * hash and an equal serialised length.
 */

/**
 * @param {unknown} value
 * @returns {string}
 */
export function fingerprint(value) {
  const canonical = (v) => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === 'object') {
      const out = {};
      for (const key of Object.keys(v).sort()) out[key] = canonical(v[key]);
      return out;
    }
    return v ?? null;
  };

  const text = JSON.stringify(canonical(value ?? null));
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${hash.toString(36)}-${text.length.toString(36)}`;
}

/**
 * Whether a stored artefact still describes the inputs in front of it.
 *
 * `null` means CANNOT TELL -- no artefact, or one stored by a build that did
 * not record a fingerprint. Callers must render that as unknown, never as
 * fresh, which is why this returns three values rather than a boolean.
 *
 * @param {unknown} storedFingerprint what the artefact recorded
 * @param {unknown} current the value to compare against now
 * @returns {boolean | null} true when stale
 */
export function isStaleAgainst(storedFingerprint, current) {
  if (typeof storedFingerprint !== 'string' || storedFingerprint === '') return null;
  return storedFingerprint !== fingerprint(current);
}
