import React from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
// The blog's group sidebar, reused so the two read as one design.
import styles from '@site/src/components/BlogGroupSidebar/styles.module.css';
import own from './styles.module.css';

export {pluginNavigation} from './navigation';

/**
 * The Plugins sidebar, shaped like a blog's: the plugins in view, each a plain
 * link, since where the reader is lives in the URL (?app=, and ?tag=, which no
 * control here sets), then the way to the marketplace and, at its foot, the
 * control that collapses it. Where the window is narrow it is the list alone.
 */

function PluginList({navigation, marketplaceHref}) {
  return (
    <nav className={clsx('menu thin-scrollbar', styles.menu, own.list)} aria-label="Plugins">
      <ul className="menu__list">
        {navigation.links.map(plugin => (
          <li className="menu__list-item" key={plugin.id}>
            <Link
              className={clsx('menu__link', styles.categoryLink, plugin.id === navigation.app?.id && 'menu__link--active')}
              to={plugin.permalink}
            >
              <span className={styles.taxonomyTitle}>{plugin.title}</span>
              {plugin.badge && <span className={clsx(own.badge, plugin.badge === 'update' && own.badgeUpdate)}>{plugin.badge}</span>}
            </Link>
          </li>
        ))}
        <li className="menu__list-item">
          <Link className={clsx('menu__link', styles.categoryLink, own.marketplace)} to={marketplaceHref}>
            <svg className={own.plus} viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10" /></svg>
            <span className={styles.taxonomyTitle}>Browse Marketplace</span>
          </Link>
        </li>
      </ul>
    </nav>
  );
}

/** The control that collapses a sidebar, at its foot; none inside the shell, whose activity bar does it. */
export function SidebarFoot({label, onCollapse}) {
  if (!onCollapse) return null;
  return (
    <div className={own.foot}>
      <button className={styles.collapseButton} type="button" title={label} aria-label={label} onClick={onCollapse}>
        <DoubleChevron />
      </button>
    </div>
  );
}

function DoubleChevron() {
  return (
    <svg className={styles.doubleChevron} viewBox="0 0 16 16" aria-hidden="true">
      <path d="m7 4-4 4 4 4M12 4 8 8l4 4" />
    </svg>
  );
}

/** `marketplaceHref` is the marketplace in the reader's workspace, so the navbar keeps it. */
export default function PluginSidebar({navigation, marketplaceHref, collapsed, onCollapse}) {
  return (
    <div className={clsx(styles.sidebar, collapsed && styles.sidebarHidden)}>
      <PluginList navigation={navigation} marketplaceHref={marketplaceHref} />
      <SidebarFoot label="Collapse plugin navigation" onCollapse={onCollapse} />
    </div>
  );
}
