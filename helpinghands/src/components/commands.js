import {useMemo} from 'react';
import useGlobalData from '@docusaurus/useGlobalData';
import useWorkspaceSite from '@site/src/hooks/useWorkspaceSite';
import {workspaceDocumentHref} from '@site/src/utils/documentUrls';
import {scopeWorkspacePath} from '@site/src/utils/workspaces';

/**
 * The one list of places you can go, read by both launchers.
 *
 * The bottom CLI bar (CommandBar) and the Cmd+K palette (CommandPalette) both
 * call `useCommands`, so an entry here surfaces in both and neither of them
 * keeps a list of its own.
 *
 * A command comes from one of two places, and the split is deliberate:
 *
 *   PAGE_COMMANDS  The platform's own tools and administrative pages. Content
 *                  collections are deliberately absent: each workspace
 *                  contributes those from its validated database settings.
 *   plugin data    A tool declares its own way in, by putting a `command` (or a
 *                  `commands` array, when one tool has more than one entrance)
 *                  in its global data. Adding a tool stays "add a directory
 *                  under plugins/"; this file is not edited for it.
 *
 * Icons are named rather than passed by a plugin. Global data is serialized
 * into the build and a React element does not survive that, so a plugin names
 * one of the icons below and gets the fallback if it names something else. The
 * entries in this file hold the element directly, since they are right here.
 */

/* ── SVG icons (inline to avoid any external dependency) ────────── */
// The full vocabulary, not just what PAGE_COMMANDS happens to use: the CLI's
// verbs (src/components/CommandBar/verbs.js) draw from the same set, and a
// plugin may name any key here.
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
  // What a plugin gets when it names an icon this shell does not have, and what
  // the palette draws in its own search field.
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

/**
 * The order categories are shown in, which is not their alphabetical order.
 *
 * The sort below groups by category before it sorts by name, because the
 * palette emits a header whenever the category changes as it walks the list: a
 * name-only sort would repeat every header. A category nobody names here (a
 * plugin may invent one) sorts after these, grouped with its own kind.
 */
const CATEGORY_ORDER = ['Tools', 'Content', 'Insights', 'Meta'];

/**
 * The site's own pages.
 *
 * Every href here is a real shared application route under src/pages. A
 * command that navigates to a 404 is worse than a missing command, so anything
 * moved or removed has to leave here with it.
 *
 * The bibliography is deliberately absent: it is a plugin now, it owns its own
 * route, and it declares its own command. Listing it here as well would be a
 * second source of truth that the plugin could not correct.
 */
export const PAGE_COMMANDS = [
  // Tools
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
  {id: 'people', name: 'people', category: 'Tools', icon: icons.list, title: 'People', description: 'Everyone in your organization', href: '/settings#people'},
  {id: 'apps', name: 'apps', category: 'Tools', icon: icons.grid, title: 'Apps', description: 'Apps built on NanoAgent, and their tasks', href: '/apps'},
  {id: 'marketplace', name: 'marketplace', category: 'Tools', icon: icons.grid, title: 'Marketplace', description: 'Download NanoAgent plugins, or share your own', href: '/marketplace'},
  {id: 'workspace', name: 'workspace', category: 'Tools', icon: icons.pages, title: 'Workspace', description: 'Files the apps saved for you', href: '/workspace'},
  {id: 'channels', name: 'channels', category: 'Tools', icon: icons.layers, title: 'Channels', description: 'Browse, rename, and archive channels', href: '/channels'},

  // Content activity is shared; named collections come from workspace data.
  {id: 'timeline', name: 'timeline', category: 'Content', icon: icons.clock, title: 'Timeline', description: 'Recent content activity', href: '/timeline'},

  // Insights
  {id: 'analytics', name: 'analytics', category: 'Insights', icon: icons.chart, title: 'Analytics', description: 'Pageview dashboard', href: '/analytics'},
  {id: 'stats', name: 'stats', category: 'Insights', icon: icons.chart, title: 'Stats', description: 'Content statistics', href: '/stats'},

  // Meta
  {id: 'home', name: 'home', category: 'Meta', icon: icons.navigate, title: 'Home', description: 'Back to the front page', href: '/'},
  {id: 'about', name: 'about', category: 'Meta', icon: icons.info, title: 'About', description: 'What this site is', href: '/about'},
  {id: 'api', name: 'api', category: 'Meta', icon: icons.pages, title: 'API Docs', description: 'Server endpoint reference', href: '/api-docs'},
  {id: 'admin', name: 'admin', category: 'Meta', icon: icons.shield, title: 'Admin', description: 'Administration panel', href: '/admin'},
];

/**
 * Haystack a fuzzy match runs against, so both launchers rank identically.
 *
 * Every field is optional to a plugin, and a missing one used to interpolate
 * the literal string "undefined" into the haystack, which then matched a query
 * of "und".
 */
export function commandHaystack(cmd) {
  return [cmd?.name, cmd?.title, cmd?.description, cmd?.category].filter(Boolean).join(' ');
}

/** Group by category first, then by name, so each header is emitted once. */
function categoryRank(category) {
  const index = CATEGORY_ORDER.indexOf(category);
  return index === -1 ? CATEGORY_ORDER.length : index;
}

function compareCommands(a, b) {
  const byRank = categoryRank(a.category) - categoryRank(b.category);
  if (byRank !== 0) return byRank;
  // Two categories the order above does not name still have to be contiguous.
  const byCategory = String(a.category ?? '').localeCompare(String(b.category ?? ''));
  if (byCategory !== 0) return byCategory;
  return String(a.name).localeCompare(String(b.name));
}

/**
 * Every navigation command: the site's pages, then whatever the plugins offer.
 *
 * Navigation only. The CLI concatenates its own verbs (the commands that DO
 * something rather than going somewhere) onto this list itself, and the palette
 * never wanted them.
 *
 * Global data is keyed by plugin name and then by instance id, and a plugin
 * that declares no command contributes nothing, so most of the walk below is
 * skipping over the plugins that are here for other reasons. A plugin may
 * declare one `command` or a `commands` array; both are read, because a tool
 * can reasonably offer more than one way in.
 */
export function useCommands() {
  const globalData = useGlobalData();
  const {slug: workspaceSlug, site: workspaceSite} = useWorkspaceSite();
  return useMemo(() => {
    const found = [];
    // An id is a React key in both launchers, so a repeat is dropped rather
    // than rendered twice. The pages win, since a plugin must not be able to
    // take over the site's own way in by claiming its id.
    const seen = new Set();
    const take = (command, icon) => {
      if (!command?.name || !command?.href) return;
      const id = command.id ?? command.name;
      if (seen.has(id)) return;
      seen.add(id);
      found.push({...command, id, icon});
    };

    const currentPath = workspaceSlug ? `/w/${encodeURIComponent(workspaceSlug)}` : '/';
    for (const command of PAGE_COMMANDS) {
      take({...command, href: scopeWorkspacePath(command.href, currentPath)}, command.icon);
    }

    for (const item of workspaceSite?.navigation ?? []) {
      const collection = (workspaceSite.collections ?? [])
        .filter(candidate => item.path === candidate.pathPrefix || item.path.startsWith(`${candidate.pathPrefix}/`))
        .sort((a, b) => b.pathPrefix.length - a.pathPrefix.length)[0];
      // Books and blogs are hidden for now (FUTURE.md).
      if (collection) continue;
      take({
        id: `workspace-content:${item.path}`,
        name: item.label,
        category: 'Content',
        title: item.label,
        description: 'Document collection',
        href: workspaceDocumentHref(item.path, workspaceSlug, ''),
      }, icons.book);
    }

    for (const instances of Object.values(globalData ?? {})) {
      for (const data of Object.values(instances ?? {})) {
        const declared = [];
        if (Array.isArray(data?.commands)) declared.push(...data.commands);
        if (data?.command) declared.push(data.command);
        for (const command of declared) {
          // A workspace-scoped command is meaningful only after this tab's
          // workspace configuration has resolved. Hiding it during a route
          // transition prevents a default plugin surface from flashing before
          // the new workspace's enablement is known.
          if (command.scope === 'workspace' && workspaceSlug && !workspaceSite) continue;
          if (command?.plugin && workspaceSite?.plugins?.[command.plugin]?.enabled === false) continue;
          const href = command.scope === 'workspace' && workspaceSlug && command.href?.startsWith('/')
            ? `/w/${encodeURIComponent(workspaceSlug)}${command.href}`
            : scopeWorkspacePath(command.href, currentPath);
          take({
            ...command,
            href,
          }, icons[command?.icon] ?? icons.search);
        }
      }
    }

    return found.sort(compareCommands);
  }, [globalData, workspaceSite, workspaceSlug]);
}
