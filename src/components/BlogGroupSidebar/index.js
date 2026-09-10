import React, {useEffect, useRef, useState} from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import {useClickOutside} from '@site/src/hooks/useClickOutside';
import styles from './styles.module.css';

function GroupIcon() {
  return (
    <svg className={styles.groupIcon} viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="7" cy="7" r="2.25" />
      <circle cx="14.25" cy="8" r="1.75" />
      <path d="M3.5 15.75c.4-2.5 1.75-3.75 4-3.75s3.6 1.25 4 3.75M12.25 12.5c2.4-.45 3.85.65 4.25 2.75" />
    </svg>
  );
}

function DoubleChevron() {
  return (
    <svg className={styles.doubleChevron} viewBox="0 0 16 16" aria-hidden="true">
      <path d="m7 4-4 4 4 4M12 4 8 8l4 4" />
    </svg>
  );
}

function TaxonomyIcon({all = false}) {
  return all ? (
    <svg className={styles.taxonomyIcon} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M5.5 4h7M5.5 8h7M5.5 12h7" />
      <circle cx="2.5" cy="4" r=".65" fill="currentColor" stroke="none" />
      <circle cx="2.5" cy="8" r=".65" fill="currentColor" stroke="none" />
      <circle cx="2.5" cy="12" r=".65" fill="currentColor" stroke="none" />
    </svg>
  ) : (
    <svg className={styles.taxonomyIcon} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2.75 4.25h4l1.2 1.5h5.3v6.5h-10.5z" />
    </svg>
  );
}

function GroupSwitcher({navigation}) {
  const [open, setOpen] = useState(false);
  const wrapper = useRef(null);
  useClickOutside(wrapper, () => setOpen(false), open);

  useEffect(() => {
    if (!open) return undefined;
    const closeOnEscape = event => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [open]);

  return (
    <div className={styles.groupSwitcher} ref={wrapper}>
      <button
        className={styles.groupTrigger}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
      >
        <GroupIcon />
        <span className={styles.groupTitle}>{navigation.activeGroup || 'Choose a group'}</span>
        <svg className={styles.chevron} viewBox="0 0 16 16" aria-hidden="true">
          <path d="m4 6 4 4 4-4" />
        </svg>
      </button>
      {open && (
        <div className={styles.groupMenu} role="listbox" aria-label="Choose blog group">
          {navigation.groups.map(group => {
            const selected = group.title === navigation.activeGroup;
            return (
              <Link
                key={group.title}
                className={clsx(styles.groupOption, selected && styles.groupOptionSelected)}
                role="option"
                aria-selected={selected}
                to={group.permalink}
                onClick={() => setOpen(false)}
              >
                <span>{group.title}</span>
                {selected && <span className={styles.checkmark} aria-hidden="true">✓</span>}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

function CategoryTree({navigation}) {
  const [collapsed, setCollapsed] = useState(() => new Set(
    navigation.categories
      .filter(category => category.title !== navigation.activeCategory)
      .map(category => category.title),
  ));

  useEffect(() => {
    setCollapsed(new Set(
      navigation.categories
        .filter(category => category.title !== navigation.activeCategory)
        .map(category => category.title),
    ));
  }, [navigation.activeCategory, navigation.categories]);

  const toggle = title => {
    setCollapsed(current => {
      const next = new Set(current);
      if (next.has(title)) next.delete(title);
      else next.add(title);
      return next;
    });
  };

  return (
    <nav className={clsx('menu thin-scrollbar', styles.menu)} aria-label="Blog categories">
      <ul className="menu__list">
        {navigation.categories.map(category => {
          const hasChildren = category.subcategories.length > 0;
          const isCollapsed = collapsed.has(category.title);
          const categoryActive = category.isAll
            ? !navigation.activeCategory
            : category.title === navigation.activeCategory;
          return (
            <li key={category.title} className={clsx('menu__list-item', isCollapsed && 'menu__list-item--collapsed')}>
              <div className={clsx('menu__list-item-collapsible', categoryActive && 'menu__list-item-collapsible--active')}>
                <Link
                  className={clsx('menu__link', styles.categoryLink, categoryActive && 'menu__link--active')}
                  to={category.permalink}
                >
                  <TaxonomyIcon all={category.isAll} />
                  <span className={styles.taxonomyTitle}>{category.title}</span>
                  <span className={styles.itemCount}>{category.count}</span>
                </Link>
                {hasChildren && (
                  <button
                    className="clean-btn menu__caret"
                    type="button"
                    aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${category.title}`}
                    aria-expanded={!isCollapsed}
                    onClick={() => toggle(category.title)}
                  />
                )}
              </div>
              {hasChildren && !isCollapsed && (
                <ul className={clsx('menu__list', styles.subcategoryList)}>
                  {category.subcategories.map(subcategory => (
                    <li className="menu__list-item" key={subcategory.title}>
                      <Link
                        className={clsx(
                          'menu__link',
                          styles.subcategoryLink,
                          categoryActive && subcategory.title === navigation.activeSubcategory && 'menu__link--active',
                        )}
                        to={subcategory.permalink}
                      >
                        <span className={styles.taxonomyTitle}>{subcategory.title}</span>
                        <span className={styles.itemCount}>{subcategory.count}</span>
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

export default function BlogGroupSidebar({navigation, collapsed, onCollapse}) {
  return (
    <div className={clsx(styles.sidebar, collapsed && styles.sidebarHidden)}>
      <div className={styles.sidebarControls}>
        <GroupSwitcher navigation={navigation} />
        <button
          className={styles.collapseButton}
          type="button"
          title="Collapse blog navigation"
          aria-label="Collapse blog navigation"
          onClick={onCollapse}
        >
          <DoubleChevron />
        </button>
      </div>
      <CategoryTree navigation={navigation} />
    </div>
  );
}
