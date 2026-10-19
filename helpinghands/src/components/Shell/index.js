import React from 'react';
import Link from '@docusaurus/Link';
import {useLocation} from '@docusaurus/router';
import clsx from 'clsx';
import NavbarColorModeToggle from '@theme/Navbar/ColorModeToggle';
import UserButton from '@site/src/components/UserButton';
import WorkspaceSwitcher from '@site/src/components/WorkspaceSwitcher';
import useWorkspaceApps, {prepareWorkspaceApps} from '@site/src/hooks/useWorkspaceApps';
import SECTIONS from './registry';
import {sectionAt} from './sectionList';
import Sections, {sectionPath} from './Sections';
import {SIDE_DEFAULT, ShellContext, sectionHrefs} from './context';
import styles from './styles.module.css';

/**
 * A workspace's frame, after VS Code's: an activity bar down the left edge in
 * place of the navbar, and the page beside it. It is drawn once for the
 * workspace, above every page in it (./Frame.js), and holds the workspace's
 * sections (./Sections.js), so no page change remounts them. The bar's icons
 * are the sections; choosing one opens it with its side bar, and choosing
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

/**
 * A section's icon: it opens the section where it was left (sectionHrefs; at
 * its own path the first time) with its side bar showing, or, when open,
 * hides or shows that side bar. Home has no side bar: its icon only opens it.
 */
function ActivityIcon({section, base, active, badge, shell}) {
  const home = !section.path;
  const path = sectionPath(base, section);
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
      <svg viewBox="0 0 20 20" aria-hidden="true">{section.icon}</svg>
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

  // The open section as its route drew it (./SectionPage.js), or null while another page is open; the theme's Layout sets it so.
  const [shown, show] = React.useState(() => {
    const at = sectionAt(location.pathname);
    return at ? {section: SECTIONS.find(item => item.id === at.id), location} : null;
  });
  const base = `/w/${encodeURIComponent(slug)}`;
  const activeId = shown?.section.id ?? null;
  const title = shown?.section.title ?? null;
  const shell = React.useMemo(
    () => ({setOpen, toggle: () => setOpen(value => !value), title, setWidth, drag, show}),
    [title, drag],
  );
  const icon = item => (
    <ActivityIcon
      key={item.id}
      section={item}
      base={base}
      active={item.id === activeId}
      badge={item.id === 'marketplace' ? updates : 0}
      shell={shell}
    />
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
            {SECTIONS.filter(item => !item.foot).map(icon)}
          </div>
          <div className={styles.group}>
            <NavbarColorModeToggle className={styles.theme} />
            {SECTIONS.filter(item => item.foot).map(icon)}
            <UserButton compact />
          </div>
        </nav>
        <div className={styles.main}>
          <Sections base={base} shown={shown} />
          {children}
        </div>
      </div>
    </ShellContext.Provider>
  );
}
