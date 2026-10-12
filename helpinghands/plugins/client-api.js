/**
 * Shared browser transport for plugin pages, independent of src/. The page's
 * own origin serves the API (src/utils/api.js).
 */
export function pluginFetch(path, init = {}) {
  return fetch(path, {...init, credentials: 'include'});
}
