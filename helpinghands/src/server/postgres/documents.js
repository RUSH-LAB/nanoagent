const {titleOf} = require('../document-title');
const MAX_PATH_LENGTH = 400;

function checkPath(value) {
  const input = String(value ?? '');
  const path = input.startsWith('content/') ? input.slice('content/'.length) : input;
  if (!path || path.length > MAX_PATH_LENGTH) throw new TypeError(`A document path must be 1 to ${MAX_PATH_LENGTH} characters`);
  if (path.startsWith('/') || path.includes('\\') || path.split('/').includes('..')) throw new TypeError(`Not a document path: ${path}`);
  return path;
}

function prefixOf(value) {
  if (value === undefined || value === null || value === '') return null;
  return checkPath(String(value).replace(/\/+$/, ''));
}

module.exports = {titleOf, checkPath, prefixOf};
