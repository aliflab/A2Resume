/**
 * Thin key-value wrapper around localStorage. This is the ONLY persistence
 * layer in the project -- there is no backend and no cloud sync.
 * Deliberately logic-free: namespacing, schema versioning, and migrations
 * are not implemented yet.
 */
const PREFIX = 'a2resume:';

const key = (name) => `${PREFIX}${name}`;

export function get(name) {
  const raw = localStorage.getItem(key(name));
  return raw === null ? null : JSON.parse(raw);
}

export function set(name, value) {
  localStorage.setItem(key(name), JSON.stringify(value));
}

export function remove(name) {
  localStorage.removeItem(key(name));
}

export default { get, set, remove };
