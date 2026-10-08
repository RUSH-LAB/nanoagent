/** Shared browser transport for plugin pages, independent of src/. */
export const API_BASE = typeof window !== 'undefined' && window.location.hostname !== 'localhost'
  ? ''
  : 'http://localhost:3001';

export function pluginFetch(path, init = {}) {
  const target = String(path).startsWith('http') ? path : `${API_BASE}${path}`;
  return fetch(target, {...init, credentials: 'include'});
}
