import React from 'react';
import Link from '@docusaurus/Link';
import {useLocation} from '@docusaurus/router';
import clsx from 'clsx';
import NavbarColorModeToggle from '@theme/Navbar/ColorModeToggle';
import UserButton from '@site/src/components/UserButton';
import WorkspaceSwitcher from '@site/src/components/WorkspaceSwitcher';
import useWorkspaceApps, {prepareWorkspaceApps} from '@site/src/hooks/useWorkspaceApps';
import {SIDE_DEFAULT, ShellContext, sectionHrefs} from './context';
import styles from './styles.module.css';

/**
 * A workspace's frame, after VS Code's: an activity bar down the left edge in
 * place of the navbar, and the page beside it. The bar's icons are the
 * workspace's sections; choosing one opens it with its side bar, and choosing
 * the one already open hides its side bar or shows it again. Every page's side
 * bar follows that one state (./context.js), kept across visits, and is drawn
 * at one width, dragged by its edge (./Sash.js). At its foot
 * are the theme, Settings and the account. Where the window is narrow the bar
 * runs along the bottom. The pages keep their own layout: the shell sets the
 * navbar's height to 0 (html.site-shell, src/css/custom.css), so whatever was
 * sized below the navbar fills the window instead.
 */

const OPEN_KEY = 'mochi:shell-sidebar-open';
const WIDTH_KEY = 'mochi:shell-sidebar-width';

const ICONS = {
  home: <path d="M3.5 9.25 10 3.75l6.5 5.5V16a.75.75 0 0 1-.75.75H12.5v-4.5h-5v4.5H4.25A.75.75 0 0 1 3.5 16z" />,
  plugins: <path d="M9 3.5h3.5a1 1 0 0 1 1 1V8a2 2 0 1 1 0 4v3.5a1 1 0 0 1-1 1H9a2 2 0 1 0-4 0H4.5a1 1 0 0 1-1-1V12a2 2 0 1 0 0-4V4.5a1 1 0 0 1 1-1H5a2 2 0 1 1 4 0z" />,
  marketplace: <path d="M3.5 8h13l-1.1 9h-10.8zM7 8V6.5a3 3 0 0 1 6 0V8" />,
  workspace: <path d="M2.75 5.25a1.5 1.5 0 0 1 1.5-1.5h3.5l1.75 2h6.25a1.5 1.5 0 0 1 1.5 1.5v7.5a1.5 1.5 0 0 1-1.5 1.5H4.25a1.5 1.5 0 0 1-1.5-1.5z" />,
  // Lucide's settings gear (ISC), on its 24-unit grid.
  settings: (
    <g transform="scale(0.8333)" strokeWidth="1.8">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </g>
  ),
};

/** The workspace's sections, by the path under /w/<slug>/ each lives at; Home, the workspace's own page, at /w/<slug>. */
const SECTIONS = [
  {id: 'home', title: 'Home', path: ''},
  {id: 'plugins', title: 'Plugins', path: 'apps'},
  {id: 'marketplace', title: 'Marketplace', path: 'marketplace'},
  {id: 'workspace', title: 'Filesystem', path: 'workspace'},
];
const SETTINGS = {id: 'settings', title: 'Settings', path: 'settings'};

/**
 * A section's icon: it opens the section where it was left (sectionHrefs; at
 * its own path the first time) with its side bar showing, or, when open,
 * hides or shows that side bar. Home has no side bar: its icon only opens it.
 */
function ActivityIcon({section, base, active, badge, shell}) {
  const home = !section.path;
  const path = home ? base : `${base}/${section.path}`;
  return (
    <Link
      to={sectionHrefs.get(path) ?? path}
      className={clsx(styles.item, active && styles.active)}
      title={active && !home ? `${section.title} (click to hide or show its side bar)` : section.title}
      aria-label={section.title}
      aria-current={active ? 'page' : undefined}
      onClick={event => {
        if (home) return undefined;
        if (!active) return shell.setOpen(true);
        event.preventDefault();
        return shell.toggle();
      }}
    >
      <svg viewBox="0 0 20 20" aria-hidden="true">{ICONS[section.id]}</svg>
      {badge > 0 && <span className={styles.badge}>{badge}</span>}
    </Link>
  );
}

export default function Shell({slug, workspace, children}) {
  const location = useLocation();
  const [open, setOpen] = React.useState(() => {
    try {
      return window.localStorage.getItem(OPEN_KEY) !== 'false';
    } catch {
      return true;
    }
  });
  React.useEffect(() => {
    try {
      window.localStorage.setItem(OPEN_KEY, String(open));
    } catch {
      // A browser that keeps nothing reopens the side bar on each visit.
    }
  }, [open]);
  const [width, setWidth] = React.useState(() => Number(window.localStorage.getItem(WIDTH_KEY)) || SIDE_DEFAULT);
  React.useEffect(() => window.localStorage.setItem(WIDTH_KEY, String(width)), [width]);
  // Neither is in the context's value: the pages draw the side bar from the
  // shell's data-side-folded and --site-side-width, so opening, folding and
  // resizing it re-render no page. While its edge is dragged, the width is set
  // on the page itself as the pointer moves, and the one the drag ends at is
  // then kept (./Sash.js).
  const shellRef = React.useRef(null);
  const kept = React.useRef({open, width});
  kept.current = {open, width};
  const drag = React.useMemo(() => {
    const draw = px => shellRef.current.style.setProperty('--site-side-width', `${px}px`);
    return {
      isOpen: () => kept.current.open,
      start: () => shellRef.current.classList.add(styles.resizing),
      move: draw,
      // Back at the kept width, which setWidth then moves to where the drag ended.
      end: () => {
        shellRef.current.classList.remove(styles.resizing);
        draw(kept.current.width);
      },
    };
  }, []);

  // Entering a workspace starts installing its plugins, before any is opened.
  React.useEffect(() => prepareWorkspaceApps(workspace.id), [workspace.id]);
  const {apps} = useWorkspaceApps(workspace);
  const updates = (apps ?? []).filter(app => app.latest && app.version !== app.latest).length;

  const base = `/w/${encodeURIComponent(slug)}`;
  const section = location.pathname.slice(base.length).split('/')[1] ?? '';
  const active = [...SECTIONS, SETTINGS].find(item => item.path === section) ?? null;
  const activeId = active?.id ?? null;
  const title = active?.title ?? null;
  const shell = React.useMemo(
    () => ({setOpen, toggle: () => setOpen(value => !value), title, setWidth, drag}),
    [title, drag],
  );

  return (
    <ShellContext.Provider value={shell}>
      <div
        ref={shellRef}
        className={styles.shell}
        data-side-folded={open ? undefined : ''}
        style={{'--site-side-width': `${width}px`}}
      >
        <nav className={styles.bar} aria-label="Workspace">
          <div className={styles.group}>
            <WorkspaceSwitcher compact />
            {SECTIONS.map(item => (
              <ActivityIcon
                key={item.id}
                section={item}
                base={base}
                active={item.id === activeId}
                badge={item.id === 'marketplace' ? updates : 0}
                shell={shell}
              />
            ))}
          </div>
          <div className={styles.group}>
            <NavbarColorModeToggle className={styles.theme} />
            <ActivityIcon section={SETTINGS} base={base} active={activeId === 'settings'} shell={shell} />
            <UserButton compact />
          </div>
        </nav>
        <div className={styles.main}>{children}</div>
      </div>
    </ShellContext.Provider>
  );
}
