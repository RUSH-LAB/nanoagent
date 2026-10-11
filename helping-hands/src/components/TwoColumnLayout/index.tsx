import React, {type ReactNode, useCallback, useEffect, useState} from 'react';
import clsx from 'clsx';
import BackToTopButton from '@theme/BackToTopButton';
import styles from './styles.module.css';

type SidebarRenderProps = {
  collapsed: boolean;
  onCollapse: () => void;
};

type Props = {
  children: ReactNode;
  renderSidebar?: (props: SidebarRenderProps) => ReactNode;
  sidebarKey?: string | null;
  sidebarClassName?: string;
  showSidebarOnMobile?: boolean;
  contentClassName?: string;
};

function ExpandIcon(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="m4 4 4 4-4 4M9 4l4 4-4 4" />
    </svg>
  );
}

/** A navigation sidebar beside a content area that takes the rest of the width. */
export default function TwoColumnLayout({
  children,
  renderSidebar,
  sidebarKey = null,
  sidebarClassName,
  showSidebarOnMobile = false,
  contentClassName,
}: Props): ReactNode {
  const [collapsed, setCollapsed] = useState(false);
  const toggleSidebar = useCallback(() => setCollapsed(value => !value), []);

  useEffect(() => setCollapsed(false), [sidebarKey]);

  return (
    <div className={styles.wrapper}>
      <BackToTopButton />
      <div className={styles.root}>
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
              {renderSidebar({collapsed, onCollapse: toggleSidebar})}
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
          </aside>
        )}
        <main className={clsx(styles.main, (!renderSidebar || collapsed) && styles.mainExpanded)}>
          <div className={clsx('container padding-bottom--lg', styles.content, contentClassName)}>
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
