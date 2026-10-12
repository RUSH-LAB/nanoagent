import React, {useEffect, useState} from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import styles from '@site/src/components/BlogGroupSidebar/styles.module.css';

/**
 * A sidebar's collapsible categories: each is a link with an icon, an optional
 * count, and links beneath it that a caret opens and closes. The blog's
 * categories and the settings groups are both this.
 *
 * `items` is [{key, label, to, icon, count, active, children: [{key, label, to, count, active}]}].
 * With `collapseInactive`, only the active category starts open and it reopens
 * when the active one changes; otherwise every category starts open.
 */
export default function SidebarTree({label, items, collapseInactive = false}) {
  const activeKey = items.find(item => item.active)?.key;
  const keys = items.map(item => item.key).join('\n');
  const closed = () => new Set(collapseInactive ? items.map(item => item.key).filter(key => key !== activeKey) : []);
  const [collapsed, setCollapsed] = useState(closed);

  useEffect(() => {
    if (collapseInactive) setCollapsed(closed());
    // `items` is rebuilt on every render; what matters is which keys exist and which is active.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collapseInactive, activeKey, keys]);

  const toggle = key => {
    setCollapsed(current => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <nav className={clsx('menu thin-scrollbar', styles.menu)} aria-label={label}>
      <ul className="menu__list">
        {items.map(item => {
          const hasChildren = item.children.length > 0;
          const isCollapsed = collapsed.has(item.key);
          return (
            <li key={item.key} className={clsx('menu__list-item', isCollapsed && 'menu__list-item--collapsed')}>
              <div className={clsx('menu__list-item-collapsible', item.active && 'menu__list-item-collapsible--active')}>
                <Link className={clsx('menu__link', styles.categoryLink, item.active && 'menu__link--active')} to={item.to}>
                  {item.icon}
                  <span className={styles.taxonomyTitle}>{item.label}</span>
                  {item.count != null && <span className={styles.itemCount}>{item.count}</span>}
                </Link>
                {hasChildren && (
                  <button
                    className="clean-btn menu__caret"
                    type="button"
                    aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${item.label}`}
                    aria-expanded={!isCollapsed}
                    onClick={() => toggle(item.key)}
                  />
                )}
              </div>
              {hasChildren && !isCollapsed && (
                <ul className={clsx('menu__list', styles.subcategoryList)}>
                  {item.children.map(child => (
                    <li className="menu__list-item" key={child.key}>
                      <Link
                        className={clsx('menu__link', styles.subcategoryLink, child.active && 'menu__link--active')}
                        to={child.to}
                        aria-current={child.active ? 'true' : undefined}
                      >
                        <span className={styles.taxonomyTitle}>{child.label}</span>
                        {child.count != null && <span className={styles.itemCount}>{child.count}</span>}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
