import React, {useEffect, useRef, useState} from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import {useClickOutside} from '@site/src/hooks/useClickOutside';
import {useLabCommand} from '@site/src/utils/labApp';
// The blog's group sidebar, reused so the two read as one design.
import styles from '@site/src/components/BlogGroupSidebar/styles.module.css';
import own from './styles.module.css';

export {pluginNavigation} from './navigation';

/**
 * The Plugins sidebar, shaped like a blog's: the tag switcher (All, or one
 * tag), the only place a tag is chosen, then the plugins in view. The tags are
 * the ones the member gave their plugins; where the reader is lives in the URL
 * (?tag=, ?app=, ?draft=), so every entry is a plain link. Below them, while
 * the member's computer is connected, are the drafts on it, or why they could
 * not be read, and how to make one in the member's own terminal with the
 * command their RUSH Lab puts on their PATH.
 */

function TagIcon() {
  return (
    <svg className={styles.groupIcon} viewBox="0 0 20 20" aria-hidden="true">
      <rect x="3" y="3" width="5.5" height="5.5" rx="1.2" />
      <rect x="11.5" y="3" width="5.5" height="5.5" rx="1.2" />
      <rect x="3" y="11.5" width="5.5" height="5.5" rx="1.2" />
      <rect x="11.5" y="11.5" width="5.5" height="5.5" rx="1.2" />
    </svg>
  );
}

function TagSwitcher({navigation}) {
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
        <TagIcon />
        <span className={styles.groupTitle}>{navigation.allTags ? 'All' : navigation.activeTag ?? navigation.unknownTag}</span>
        <svg className={styles.chevron} viewBox="0 0 16 16" aria-hidden="true">
          <path d="m4 6 4 4 4-4" />
        </svg>
      </button>
      {open && (
        <div className={styles.groupMenu} role="listbox" aria-label="Choose plugin tag">
          {navigation.tags.map(tag => {
            const selected = tag.all ? navigation.allTags : tag.title === navigation.activeTag;
            return (
              <div key={tag.title} className={styles.groupOptionRow}>
                <Link
                  className={clsx(styles.groupOption, selected && styles.groupOptionSelected)}
                  role="option"
                  aria-selected={selected}
                  to={tag.permalink}
                  onClick={() => setOpen(false)}
                >
                  <span>{tag.title}</span>
                  {selected && <span className={styles.checkmark} aria-hidden="true">✓</span>}
                </Link>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// What a member adds to their shell's startup for ~/.local/bin, where RUSH Lab puts its command, to be on their PATH.
const PATH_LINES = [
  ['macOS', `echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc`],
  ['Windows (PowerShell)', `[Environment]::SetEnvironmentVariable('Path', "$env:USERPROFILE\\.local\\bin;" + [Environment]::GetEnvironmentVariable('Path', 'User'), 'User')`],
];

function DraftList({navigation, draftsError}) {
  const command = useLabCommand();
  return (
    <>
      <li className="menu__list-item">
        <span className={styles.emptySelection}>Drafts on this computer</span>
      </li>
      {draftsError && (
        <li className="menu__list-item">
          <span className={styles.groupError} role="alert">{draftsError}</span>
        </li>
      )}
      {navigation.draftLinks.map(draft => (
        <li className="menu__list-item" key={draft.id}>
          <Link
            className={clsx('menu__link', styles.categoryLink, draft.id === navigation.draft?.id && 'menu__link--active')}
            to={draft.permalink}
          >
            <span className={styles.taxonomyTitle}>{draft.title}</span>
          </Link>
        </li>
      ))}
      <li className={clsx('menu__list-item', own.draftHint)}>
        <p>
          To make one, in your terminal run <code>{command} new my-plugin</code>, open your AI CLI (Claude Code, Codex,
          Gemini) in <code>my-plugin</code>, then run <code>{command} preview .</code> to see it here.
        </p>
        <p>If your terminal cannot find <code>{command}</code>, add ~/.local/bin to your PATH, then open a new terminal:</p>
        {PATH_LINES.map(([system, line]) => (
          <p key={system}>{system}: <code>{line}</code></p>
        ))}
      </li>
    </>
  );
}

function PluginList({navigation, marketplaceHref, showDrafts, draftsError}) {
  return (
    <nav className={clsx('menu thin-scrollbar', styles.menu)} aria-label="Plugins">
      <ul className="menu__list">
        {navigation.links.map(plugin => (
          <li className="menu__list-item" key={plugin.id}>
            <Link
              className={clsx('menu__link', styles.categoryLink, plugin.id === navigation.app?.id && 'menu__link--active')}
              to={plugin.permalink}
            >
              <span className={styles.taxonomyTitle}>{plugin.title}</span>
              {plugin.maintenance && <span className={own.maintenance} title="Under maintenance">maintenance</span>}
            </Link>
          </li>
        ))}
        <li className="menu__list-item">
          <Link className={clsx('menu__link', styles.categoryLink, own.marketplace)} to={marketplaceHref}>
            <svg className={own.plus} viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10" /></svg>
            <span className={styles.taxonomyTitle}>Browse Marketplace</span>
          </Link>
        </li>
        {showDrafts && <DraftList navigation={navigation} draftsError={draftsError} />}
      </ul>
    </nav>
  );
}

function DoubleChevron() {
  return (
    <svg className={styles.doubleChevron} viewBox="0 0 16 16" aria-hidden="true">
      <path d="m7 4-4 4 4 4M12 4 8 8l4 4" />
    </svg>
  );
}

/**
 * `marketplaceHref` is the marketplace in the reader's workspace, so the navbar keeps it;
 * `showDrafts`, whether the member's computer said which drafts it has, or `draftsError` why
 * they could not be read.
 */
export default function PluginSidebar({navigation, marketplaceHref, showDrafts, draftsError, collapsed, onCollapse}) {
  return (
    <div className={clsx(styles.sidebar, collapsed && styles.sidebarHidden)}>
      <div className={styles.sidebarControls}>
        <TagSwitcher navigation={navigation} />
        <button
          className={styles.collapseButton}
          type="button"
          title="Collapse plugin navigation"
          aria-label="Collapse plugin navigation"
          onClick={onCollapse}
        >
          <DoubleChevron />
        </button>
      </div>
      <PluginList navigation={navigation} marketplaceHref={marketplaceHref} showDrafts={showDrafts} draftsError={draftsError} />
    </div>
  );
}
