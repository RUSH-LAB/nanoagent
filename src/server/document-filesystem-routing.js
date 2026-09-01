'use strict';

/**
 * Database-native endpoints must not pay for the legacy, fs-shaped document
 * snapshot. The compatibility filesystem is retained only for older analysis
 * handlers that still traverse content synchronously.
 */
const DATABASE_NATIVE_PATHS = new Set([
  '/api/site',
  '/api/settings',
  '/api/member-preferences',
  '/api/file',
  '/api/files',
  '/api/files/search',
  '/api/stats',
  '/api/notes',
  '/api/analytics',
  '/api/analytics/pageview',
]);

const DATABASE_NATIVE_PREFIXES = [
  '/api/content/',
  '/api/assets/',
  '/api/comments/',
  '/api/chat/',
  '/api/org/',
];

function usesLegacyDocumentFilesystem(pathname) {
  if (pathname === '/api/content' || pathname === '/api/assets'
      || pathname === '/api/comments' || pathname === '/api/chat'
      || pathname === '/api/org') {
    return false;
  }
  if (DATABASE_NATIVE_PATHS.has(pathname)) return false;
  return !DATABASE_NATIVE_PREFIXES.some(prefix => pathname.startsWith(prefix));
}

module.exports = {usesLegacyDocumentFilesystem};
