/**
 * The one list of places you can go and things you can do.
 *
 * Both launchers read this: the bottom CLI bar (CommandBar) and the Cmd+K
 * palette (CommandPalette). Adding an entry here surfaces it in both.
 *
 * Each command carries either an `href` (navigate there) or an `action` key
 * (a named handler the launcher wires up), never both. `name` is the short
 * token the CLI types and completes; `title` is the human phrasing the palette
 * shows.
 */

/* ── SVG icons (inline to avoid any external dependency) ────────── */
export const icons = {
  navigate: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  ),
  book: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </svg>
  ),
  pages: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
      <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
    </svg>
  ),
  star: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  ),
  chart: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="20" x2="18" y2="10" />
      <line x1="12" y1="20" x2="12" y2="4" />
      <line x1="6" y1="20" x2="6" y2="14" />
    </svg>
  ),
  shield: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  ),
  graph: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
      <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
    </svg>
  ),
  plus: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  ),
  search: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  ),
  list: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <line x1="3" y1="6" x2="3.01" y2="6" />
      <line x1="3" y1="12" x2="3.01" y2="12" />
      <line x1="3" y1="18" x2="3.01" y2="18" />
    </svg>
  ),
  clock: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  ),
  layers: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="12 2 2 7 12 12 22 7 12 2" />
      <polyline points="2 17 12 22 22 17" />
      <polyline points="2 12 12 17 22 12" />
    </svg>
  ),
  grid: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" />
      <rect x="14" y="3" width="7" height="7" />
      <rect x="14" y="14" width="7" height="7" />
      <rect x="3" y="14" width="7" height="7" />
    </svg>
  ),
  note: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="9" y1="13" x2="15" y2="13" />
      <line x1="9" y1="17" x2="13" y2="17" />
    </svg>
  ),
  split: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <line x1="12" y1="4" x2="12" y2="20" />
    </svg>
  ),
  eraser: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 20H7L3 16a2 2 0 0 1 0-3l9-9a2 2 0 0 1 3 0l6 6a2 2 0 0 1 0 3l-7 7" />
      <line x1="18" y1="12" x2="11" y2="19" />
    </svg>
  ),
  info: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  ),
};

/* ── Commands ──────────────────────────────────────────────────── */
export const COMMANDS = [
  // Tools
  {id: 'bibliography', name: 'bibliography', category: 'Tools', icon: icons.book, title: 'Bibliography', description: 'Browse and manage references', href: '/bibliography'},
  {id: 'recommendations', name: 'recommendations', category: 'Tools', icon: icons.star, title: 'Recommendations', description: 'Papers matched to your interests', href: '/recommendations'},
  {id: 'reading-lists', name: 'reading-lists', category: 'Tools', icon: icons.list, title: 'Reading Lists', description: 'Queue papers to read later', href: '/reading-lists'},
  {id: 'graph', name: 'graph', category: 'Tools', icon: icons.graph, title: 'Graph', description: 'Citation and link graph', href: '/graph'},
  {id: 'mindmap', name: 'mindmap', category: 'Tools', icon: icons.layers, title: 'Mindmap', description: 'Outline a document as a mind map', href: '/mindmap'},
  {id: 'whiteboard', name: 'whiteboard', category: 'Tools', icon: icons.grid, title: 'Whiteboard', description: 'Freeform sticky-note canvas', href: '/whiteboard'},
  {id: 'flashcards', name: 'flashcards', category: 'Tools', icon: icons.layers, title: 'Flashcards', description: 'Spaced-repetition review', href: '/flashcards'},
  {id: 'glossary', name: 'glossary', category: 'Tools', icon: icons.book, title: 'Glossary', description: 'Defined terms across the site', href: '/glossary'},
  {id: 'tasks', name: 'tasks', category: 'Tools', icon: icons.list, title: 'Tasks', description: 'Kanban board', href: '/tasks'},
  {id: 'compare', name: 'compare', category: 'Tools', icon: icons.pages, title: 'Compare', description: 'Diff two documents side by side', href: '/compare'},
  {id: 'search', name: 'search', category: 'Tools', icon: icons.search, title: 'Content Search', description: 'Full-text search across content', href: '/content-search'},

  // Content
  {id: 'research', name: 'research', category: 'Content', icon: icons.pages, title: 'Research', description: 'Research paper summaries', href: '/research'},
  {id: 'blog', name: 'blog', category: 'Content', icon: icons.pages, title: 'Blog', description: 'Posts on ideas and updates', href: '/blog'},
  {id: 'survey', name: 'survey', category: 'Content', icon: icons.book, title: 'Survey', description: 'Literature review chapters', href: '/survey/intro'},
  {id: 'math', name: 'math', category: 'Content', icon: icons.book, title: 'Math', description: 'Mathematics textbook', href: '/math/intro'},
  {id: 'programming', name: 'programming', category: 'Content', icon: icons.book, title: 'Programming', description: 'Programming textbook', href: '/programming/intro'},
  {id: 'builder', name: 'builder', category: 'Content', icon: icons.book, title: 'Builder', description: 'Notes on building this site', href: '/builder/intro'},
  {id: 'timeline', name: 'timeline', category: 'Content', icon: icons.clock, title: 'Timeline', description: 'Recent content activity', href: '/timeline'},

  {id: 'people', name: 'people', category: 'Tools', icon: icons.list, title: 'People', description: 'Everyone in your organization', href: '/people'},
  {id: 'channels', name: 'channels', category: 'Tools', icon: icons.layers, title: 'Channels', description: 'Browse, rename, and archive channels', href: '/channels'},

  // Insights
  {id: 'analytics', name: 'analytics', category: 'Insights', icon: icons.chart, title: 'Analytics', description: 'Pageview dashboard', href: '/analytics'},
  {id: 'stats', name: 'stats', category: 'Insights', icon: icons.chart, title: 'Stats', description: 'Content statistics', href: '/stats'},

  // Actions
  {id: 'note', name: 'note', category: 'Actions', icon: icons.note, title: 'Quick Note', description: 'Jot a note without leaving the page', action: 'quick-note'},
  {id: 'split', name: 'split', category: 'Actions', icon: icons.split, title: 'Split', description: 'Open another session beside this one', action: 'split'},
  {id: 'clear', name: 'clear', category: 'Actions', icon: icons.eraser, title: 'Clear', description: 'Wipe this session\'s transcript', action: 'clear'},

  // Meta
  {id: 'home', name: 'home', category: 'Meta', icon: icons.navigate, title: 'Home', description: 'Back to the front page', href: '/'},
  {id: 'about', name: 'about', category: 'Meta', icon: icons.info, title: 'About', description: 'What this site is', href: '/about'},
  {id: 'api', name: 'api', category: 'Meta', icon: icons.pages, title: 'API Docs', description: 'Server endpoint reference', href: '/api-docs'},
  {id: 'admin', name: 'admin', category: 'Meta', icon: icons.shield, title: 'Admin', description: 'Administration panel', href: '/admin'},
];

/** Haystack a fuzzy match runs against, so both launchers rank identically. */
export function commandHaystack(cmd) {
  return `${cmd.name} ${cmd.title} ${cmd.description} ${cmd.category}`;
}
