import React, {type ReactNode, useCallback, useEffect, useState} from 'react';
import clsx from 'clsx';
import BackToTopButton from '@theme/BackToTopButton';
import {useShell} from '@site/src/components/Shell/context';
import Sash from '@site/src/components/Shell/Sash';
import styles from './styles.module.css';

type SidebarRenderProps = {
  collapsed: boolean;
  /** Null inside the shell, whose activity bar hides and shows the sidebar: the sidebar draws no collapse control. */
  onCollapse: (() => void) | null;
};

type Props = {
  children: ReactNode;
  renderSidebar?: (props: SidebarRenderProps) => ReactNode;
  sidebarKey?: string | null;
  sidebarClassName?: string;
  showSidebarOnMobile?: boolean;
  /** A page rather than a document: as much room on the right of the content as on its left. */
  evenGutters?: boolean;
};

function ExpandIcon(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="m4 4 4 4-4 4M9 4l4 4-4 4" />
    </svg>
  );
}

/**
 * A navigation sidebar beside a content area that takes the rest of the width.
 * Inside the shell (components/Shell) the sidebar opens and closes with the
 * activity bar, headed by the section's name, is as wide as its edge is
 * dragged, and closed it takes no room; elsewhere it collapses to a strip by
 * its own control, and expands from that strip.
 */
export default function TwoColumnLayout({
  children,
  renderSidebar,
  sidebarKey = null,
  sidebarClassName,
  showSidebarOnMobile = false,
  evenGutters = false,
}: Props): ReactNode {
  const shell = useShell();
  const [ownCollapsed, setCollapsed] = useState(false);
  const toggleSidebar = useCallback(() => setCollapsed(value => !value), []);
  // Inside the shell the side bar is folded in CSS, from the shell's data-side-folded.
  const collapsed = shell ? false : ownCollapsed;

  useEffect(() => setCollapsed(false), [sidebarKey]);

  return (
    <div className={styles.wrapper}>
      <BackToTopButton />
      <div className={clsx(styles.root, shell && styles.inShell)}>
        {renderSidebar && (
          <aside
            className={clsx(
              sidebarClassName,
              styles.sidebarColumn,
              collapsed && styles.sidebarColumnCollapsed,
              showSidebarOnMobile && styles.sidebarColumnMobile,
            )}
          >
            <div className={styles.sidebarViewport}>
              {shell?.title && <header className={styles.sideHeader}>{shell.title}</header>}
              <div className={styles.sideBody}>
                {renderSidebar({collapsed, onCollapse: shell ? null : toggleSidebar})}
              </div>
              {collapsed && (
                <button
                  className={styles.expandButton}
                  type="button"
                  title="Expand navigation"
                  aria-label="Expand navigation"
                  onClick={toggleSidebar}
                >
                  <ExpandIcon />
                </button>
              )}
            </div>
            {shell && <Sash />}
          </aside>
        )}
        <main className={clsx(styles.main, (!renderSidebar || collapsed) && styles.mainExpanded)}>
          <div className={clsx('container padding-bottom--lg', styles.content, evenGutters && styles.contentEven)}>
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
