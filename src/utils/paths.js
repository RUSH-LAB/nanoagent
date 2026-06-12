/**
 * Render a content source path as its parent-directory label: strip the leading
 * `content/` prefix, then drop the final `/segment`. Shared by the homepage,
 * analytics, and timeline pages so the transform lives in exactly one place.
 *
 * The `!filePath` guard returns '' for empty or undefined input, matching the
 * timeline page's former local helper and acting as a safe superset for the
 * inline call sites (whose paths are always truthy strings).
 *
 * @param {string} filePath  A content source path, e.g. 'content/books/foo/bar.md'.
 * @returns {string}  The parent-directory label, e.g. 'books/foo'.
 */
export function displayDirPath(filePath) {
  if (!filePath) return '';
  return filePath.replace(/^content\//, '').replace(/\/[^/]+$/, '');
}
