/**
 * BYOK key storage. localStorage only -- keys never leave this browser except
 * as an Authorization/x-goog-api-key header on a request the user initiated to
 * the provider they chose.
 *
 * Key values are never logged, stringified into errors, or returned in bulk to
 * anything but the caller that asked for them.
 */

const STORAGE_KEY = 'a2resume_api_keys';

/**
 * The stored shape is fixed at all five providers even though only gemini and
 * openai are wired into aiService.js today, so the format never has to change.
 */
export const PROVIDER_IDS = ['openai', 'claude', 'deepseek', 'kimi', 'gemini'];

const emptyKeys = () => Object.fromEntries(PROVIDER_IDS.map((id) => [id, '']));

/**
 * @returns {Record<string, string>} All five providers, missing entries as ''.
 */
export function getApiKeys() {
  let stored = null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    stored = raw ? JSON.parse(raw) : null;
  } catch {
    stored = null; // Corrupt or unavailable storage: fall back to empty.
  }

  const keys = emptyKeys();
  if (stored && typeof stored === 'object') {
    for (const id of PROVIDER_IDS) {
      if (typeof stored[id] === 'string') keys[id] = stored[id];
    }
  }
  return keys;
}

/**
 * @param {string} provider
 * @returns {string} '' when unset.
 */
export function getApiKey(provider) {
  return getApiKeys()[provider] ?? '';
}

/** @param {string} provider @param {string} value */
export function setApiKey(provider, value) {
  if (!PROVIDER_IDS.includes(provider)) {
    throw new Error(`Unknown provider "${provider}".`);
  }
  const keys = getApiKeys();
  keys[provider] = (value || '').trim();
  persist(keys);
}

/** @param {string} provider */
export function clearApiKey(provider) {
  setApiKey(provider, '');
}

export function clearAllApiKeys() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage unavailable; nothing to clear.
  }
}

/** @param {string} provider @returns {boolean} */
export function hasApiKey(provider) {
  return getApiKey(provider) !== '';
}

/**
 * Which providers have a key set. Safe to log -- booleans only, no values.
 * @returns {Record<string, boolean>}
 */
export function getKeyPresence() {
  const keys = getApiKeys();
  return Object.fromEntries(PROVIDER_IDS.map((id) => [id, keys[id] !== '']));
}

function persist(keys) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(keys));
  } catch (err) {
    throw new Error(`Could not save API keys to local storage: ${err.message}`, { cause: err });
  }
}
