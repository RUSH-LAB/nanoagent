// ─────────────────────────────────────────────────────────────
// Shared page list for the Mochi Lab integration test scripts.
//
// Both test-visual.mjs and test-pages.mjs exercise the SAME ordered
// set of 18 site routes. Previously each script hardcoded its own
// copy and the two had to be hand-synced; this module is now the
// single source of that data so the lists can no longer drift apart.
//
// Exports:
//   PAGE_PATHS           ordered list of the 18 route paths
//   PAGE_CONTENT_MATCHES path-keyed content-match strings
//   PAGE_CONTENT_CHECKS  [path, matches] tuples in PAGE_PATHS order
// ─────────────────────────────────────────────────────────────

// ── The 18 site routes, in canonical order ──
export const PAGE_PATHS = [
  '/',
  '/bibliography',
  '/recommendations',
  '/analytics',
  '/admin',
  '/graph',
  '/api-docs',
  '/search',
  '/about',
  '/reading-lists',
  '/compare',
  '/stats',
  '/whiteboard',
  '/mindmap',
  '/flashcards',
  '/tasks',
  '/glossary',
  '/timeline',
];

// ── Per-path content-match strings ──
// Note: Docusaurus SPA serves a shell HTML for all routes — the actual page
// content is rendered client-side via JS. The shell HTML typically only
// contains the site title ("Mochi Lab"), Docusaurus bootstrap, and linked
// bundles. For SPA routes we verify: HTTP 200, valid SPA shell, no errors.
// Content strings are checked case-insensitively against the full HTML
// including script bundles and route metadata where available.
export const PAGE_CONTENT_MATCHES = {
  '/':                ['Mochi Lab'],
  '/bibliography':    ['Bibliography', 'references'],
  '/recommendations': ['Recommend', 'Discover'],
  '/analytics':       ['Analytics', 'Dashboard'],
  '/admin':           ['Admin', 'Management'],
  '/graph':           ['Graph', 'Knowledge'],
  '/api-docs':        ['API', 'endpoint'],
  '/search':          ['Search', 'search'],
  '/about':           ['About', 'Mochi Lab'],
  '/reading-lists':   ['Reading', 'list'],
  '/compare':         ['Compare', 'comparison'],
  '/stats':           ['Stats', 'Statistics'],
  '/whiteboard':      ['Whiteboard', 'canvas'],
  '/mindmap':         ['Mindmap', 'Mind'],
  '/flashcards':      ['Flashcard', 'card'],
  '/tasks':           ['Task', 'Kanban'],
  '/glossary':        ['Glossary', 'term'],
  '/timeline':        ['Timeline', 'timeline'],
};

// ── [path, matches] tuples, rebuilt from the single shared ordering ──
// Each entry: [path, [contentStringsToMatchAny]]. Byte-identical to
// test-pages.mjs's original PAGES tuple list.
export const PAGE_CONTENT_CHECKS = PAGE_PATHS.map(p => [p, PAGE_CONTENT_MATCHES[p]]);
