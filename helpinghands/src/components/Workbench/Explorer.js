import React, {useEffect, useMemo, useRef, useState} from 'react';
import clsx from 'clsx';
import {
  dragAndDropFeature, hotkeysCoreFeature, searchFeature, selectionFeature, syncDataLoaderFeature,
} from '@headless-tree/core';
import {useTree} from '@headless-tree/react';
import {ROOT, dirname, entryProblem, topmost, treeIndex} from './tree';
import {droppedEntries} from './upload';
import styles from './styles.module.css';

/**
 * The workbench's file tree, modelled on VS Code's explorer and run by
 * headless-tree (github.com/lukasbach/headless-tree): folders first, compact
 * folder chains, chevrons, inline inputs for new and renamed entries, a context
 * menu, selection of many with ⌘/Ctrl and Shift, keyboard navigation (arrows,
 * Home, End, Shift with arrows to extend), typing to find a row, dragging
 * entries onto a folder to move them and files from this computer to upload
 * them, and the explorer's keys: Enter, Space, F2, Delete, ⌘C, ⌘X, ⌘V, ⌘Z.
 * It owns no data; the workbench holds what is open, selected and focused, and
 * carries out every action through callbacks.
 */

// Extension → its icon and tint, so kinds of file read at a glance.
const KINDS = [
  [/\.(md|mdx|markdown|txt|rst)$/i, 'text', styles.tintText],
  [/\.(tex|sty|cls|bib|bbl)$/i, 'tex', styles.tintTex],
  [/\.(py|js|mjs|cjs|jsx|ts|tsx|sh|bash|zsh|rs|go|java|c|cc|cpp|h|hpp|rb|lua|r|jl|sql|html|css|scss)$/i, 'code', styles.tintCode],
  [/\.(json|jsonl|ya?ml|toml|csv|tsv|xml|ini|env)$/i, 'data', styles.tintData],
  [/\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i, 'image', styles.tintMedia],
  [/\.pdf$/i, 'pdf', styles.tintMedia],
  [/\.(zip|gz|tgz|tar|bz2|xz|7z)$/i, 'archive', null],
];

const GLYPHS = {
  text: <path d="M6 8h4.5M6 10.25h4.5M6 12.5h2.5" />,
  tex: <path d="M5.75 8.25h4.5M8 8.25v4.5" />,
  code: <path d="m6.75 8.5-1.5 1.75 1.5 1.75M9.25 8.5l1.5 1.75-1.5 1.75" />,
  data: <path d="M7 8.25c-.75 0-1 .4-1 1v.25c0 .4-.25.75-.75.75.5 0 .75.35.75.75v.25c0 .6.25 1 1 1M9 8.25c.75 0 1 .4 1 1v.25c0 .4.25.75.75.75-.5 0-.75.35-.75.75v.25c0 .6-.25 1-1 1" />,
  image: <path d="m5.25 12.75 2-2.5 1.5 1.5 1-1 1.25 2M9.75 8.25h.01" />,
  pdf: <path d="M5.75 12.75v-4h1.5a1 1 0 0 1 0 2h-1.5M9.75 12.75v-4h.75a1.25 1.25 0 0 1 1.25 1.25v1.5a1.25 1.25 0 0 1-1.25 1.25z" />,
  archive: <path d="M8 2v1.5M8 5v1.5M8 8v1.5M7.25 10.5h1.5v2h-1.5z" />,
};

export function FileIcon({name}) {
  const [, kind, tint] = KINDS.find(([pattern]) => pattern.test(name)) ?? [];
  return (
    <svg className={clsx(styles.icon, tint)} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 1.75h5l3.25 3.25v9.25H4z" />
      <path d="M9 1.75V5h3.25" />
      {GLYPHS[kind]}
    </svg>
  );
}

function FolderIcon({open}) {
  return (
    <svg className={clsx(styles.icon, styles.folderIcon)} viewBox="0 0 16 16" aria-hidden="true">
      {open
        ? <path d="M1.75 12.75V3.25h4l1.5 1.5h5.5v2M1.75 12.75l2-5.5h10.5l-2 5.5z" />
        : <path d="M1.75 3.25h4l1.5 1.5h7v8H1.75z" />}
    </svg>
  );
}

function Chevron({open}) {
  return (
    <svg className={clsx(styles.icon, styles.chevron, open && styles.chevronOpen)} viewBox="0 0 16 16" aria-hidden="true">
      <path d="m6 4 4 4-4 4" />
    </svg>
  );
}

/** One guide per level above a row, the line under its parent folder's chevron. */
function Indent({depth}) {
  return Array.from({length: depth}, (_, index) => <span key={index} className={styles.indent} aria-hidden="true" />);
}

/**
 * The inline input for a new or renamed entry. It checks the name as it is
 * typed and blocks Enter while it is invalid; it stays open, with what was
 * typed, until the workbench's `status` reports the server's answer.
 */
function NameInput({initial, depth, folder, status, validate, onCommit, onCancel, onRetype}) {
  const [value, setValue] = useState(initial);
  const input = useRef(null);
  const settled = useRef(false);
  const name = value.trim();
  const problem = name && name !== initial ? validate(name) : null;
  const error = problem ?? status.error ?? null;

  useEffect(() => {
    const element = input.current;
    element.focus();
    // Select the name without its extension, as VS Code does when renaming.
    const dot = initial.lastIndexOf('.');
    element.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [initial]);

  // A failed commit hands the input back for another try.
  useEffect(() => {
    if (!status.error) return;
    settled.current = false;
    input.current.focus();
  }, [status]);

  const finish = commit => {
    if (settled.current || (commit && problem)) return;
    settled.current = true;
    if (commit && name && name !== initial) onCommit(name);
    else onCancel();
  };

  return (
    <>
      <div className={clsx(styles.row, status === 'pending' && styles.rowPending)}>
        <Indent depth={depth} />
        {folder ? <Chevron open={false} /> : <span className={styles.chevronSpace} />}
        {folder ? <FolderIcon open={false} /> : <FileIcon name={value} />}
        <input
          ref={input}
          className={clsx(styles.nameInput, error && styles.nameInputInvalid)}
          value={value}
          readOnly={status === 'pending'}
          onChange={event => {
            setValue(event.target.value);
            if (status.error) onRetype();
          }}
          onKeyDown={event => {
            event.stopPropagation();
            if (event.key === 'Enter') finish(true);
            if (event.key === 'Escape') finish(false);
          }}
          onBlur={() => finish(!error)}
          aria-label={folder ? 'Folder name' : 'File name'}
          aria-invalid={Boolean(error)}
        />
      </div>
      {error && <p className={styles.nameError} style={{'--depth': depth}} role="alert">{error}</p>}
    </>
  );
}

export function ContextMenu({menu, onClose}) {
  const element = useRef(null);
  useEffect(() => {
    const close = event => {
      if (event.type === 'keydown' && event.key !== 'Escape') return;
      if (event.type === 'mousedown' && element.current?.contains(event.target)) return;
      // The Escape that closes the menu does nothing else, such as clearing the tree's selection.
      if (event.type === 'keydown') event.stopPropagation();
      onClose();
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close, true);
    window.addEventListener('blur', onClose);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close, true);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  // Kept inside the window: a menu opened near its right or bottom edge opens toward the middle.
  const [place, setPlace] = useState({left: menu.x, top: menu.y});
  React.useLayoutEffect(() => {
    const box = element.current.getBoundingClientRect();
    setPlace({
      left: Math.max(4, Math.min(menu.x, window.innerWidth - box.width - 4)),
      top: Math.max(4, Math.min(menu.y, window.innerHeight - box.height - 4)),
    });
  }, [menu]);

  return (
    <ul ref={element} className={styles.contextMenu} style={place} role="menu">
      {menu.items.map((item, index) => (item === 'separator'
        ? <li key={`separator-${index}`} className={styles.menuSeparator} role="separator" />
        : (
          <li key={item.label} role="none">
            <button
              type="button"
              role="menuitem"
              className={clsx(styles.menuItem, item.danger && styles.menuItemDanger)}
              onClick={() => { onClose(); item.run(); }}
            >
              <span>{item.label}</span>
              {item.shortcut && <kbd>{item.shortcut}</kbd>}
            </button>
          </li>
        )))}
    </ul>
  );
}

/** Where a file is, as a cloud drive shows it: in the cloud only, on this computer, kept, or waiting to upload. */
function LocalStatus({held}) {
  const [title, path, className] = held?.pending
    ? ['Edited offline; uploads when you reconnect', 'M8 12.5v-8M4.75 7.5 8 4.25l3.25 3.25', styles.localPending]
    : held?.pinned
      ? ['Kept on this computer', 'M5.5 8.25 7.25 10l3.25-3.75M8 14a6 6 0 1 0 0-12 6 6 0 0 0 0 12z', styles.localKept]
      : held
        ? ['On this computer', 'M8 14a6 6 0 1 0 0-12 6 6 0 0 0 0 12z', null]
        : ['In the cloud', 'M4.5 12.25a3 3 0 0 1-.4-5.97 4 4 0 0 1 7.75-.78 3.25 3.25 0 0 1 .4 6.75z', null];
  return (
    <span className={clsx(styles.localStatus, className)} title={title}>
      <svg className={styles.icon} viewBox="0 0 16 16" aria-label={title}><path d={path} /></svg>
    </span>
  );
}

// Who can see a node, when it is not just the workspace.
const ACCESS_TITLES = {
  public: 'Anyone can see this',
  private: 'Only you can see this',
  shared: 'Shared with specific people',
};

// What a row stands for between a listing that removed it and the tree's
// rebuild for that listing (the effect below), which drops the row; it is not drawn.
const GONE = Object.freeze({type: 'gone', label: '', children: []});

// The folder a drop or a new entry lands in, by its item: the root item is the folder ''.
const folderOf = item => (item.getId() === ROOT ? '' : item.getId());
const resolve = (updater, current) => (typeof updater === 'function' ? updater(current) : updater);
// ⌘ on macOS, Ctrl elsewhere: headless-tree's MetaOrControl is either.
const command = (key, handler, options = {}) => ({hotkey: `MetaOrControl+${key}`, preventDefault: true, handler, ...options});

export default function Explorer({
  tree, home = null, expanded, selection, focused, reveal, activePath, dirtyPaths, held = new Map(), cut = new Set(), editing, readOnly,
  onExpanded, onSelection, onFocused, onOpen, onCommitEdit, onCancelEdit, onRetypeEdit, onContextMenu, onMove, onUpload,
  onRename, onDelete, onCopy, onCut, onPaste, onUndo,
}) {
  // While an entry is being named its folder has a row of its own, so folders are not compacted.
  const items = useMemo(() => treeIndex(tree, {compact: !editing, home}), [tree, editing, home]);
  const expandedItems = useMemo(() => [...expanded], [expanded]);
  const selectedItems = useMemo(() => selection.filter(path => items.has(path)), [selection, items]);
  const nodeOf = item => item.getItemData();
  const selectedPaths = () => topmost(selectedItems);
  // The focused folder, or the focused file's folder: where a paste lands.
  const pasteFolder = current => (current.isFolder() ? folderOf(current) : dirname(current.getId()));

  const ht = useTree({
    rootItemId: ROOT,
    state: {expandedItems, selectedItems, focusedItem: items.has(focused) ? focused : null},
    setExpandedItems: updater => onExpanded(current => new Set(resolve(updater, [...current]))),
    setSelectedItems: updater => onSelection(resolve(updater, selectedItems)),
    setFocusedItem: updater => onFocused(resolve(updater, focused)),
    dataLoader: {
      getItem: id => items.get(id) ?? GONE,
      getChildren: id => items.get(id)?.children ?? [],
    },
    getItemName: item => nodeOf(item).label,
    isItemFolder: item => nodeOf(item).type === 'folder',
    indent: 14,
    canReorder: false,
    openOnDropDelay: 600,
    canDrag: () => !readOnly && !editing,
    canDrop: (_, target) => !readOnly && target.item.isFolder(),
    canDragForeignDragObjectOver: dataTransfer => !readOnly && dataTransfer.types.includes('Files'),
    canDropForeignDragObject: dataTransfer => !readOnly && dataTransfer.types.includes('Files'),
    onDrop: (dragged, target) => onMove(topmost(dragged.map(item => item.getId())), folderOf(target.item)),
    onDropForeignDragObject: (dataTransfer, target) => onUpload(droppedEntries(dataTransfer), folderOf(target.item)),
    isSearchMatchingItem: (search, item) => nodeOf(item).label.toLowerCase().includes(search.toLowerCase()),
    hotkeys: {
      customOpen: {
        hotkey: 'Enter',
        isEnabled: current => !current.isSearchOpen(),
        handler: (_, current) => {
          const item = current.getFocusedItem();
          if (!item) return;
          if (!item.isFolder()) onOpen(nodeOf(item));
          else if (item.isExpanded()) item.collapse();
          else item.expand();
        },
      },
      // Space shows a file without keeping its tab, as a click does.
      customPreview: {
        hotkey: 'Space',
        preventDefault: true,
        isEnabled: current => !current.isSearchOpen(),
        handler: (_, current) => {
          const item = current.getFocusedItem();
          if (item && !item.isFolder()) onOpen(nodeOf(item), {preview: true});
        },
      },
      customRename: {
        hotkey: 'F2',
        isEnabled: () => !readOnly,
        handler: (_, current) => current.getFocusedItem() && onRename(nodeOf(current.getFocusedItem())),
      },
      customDelete: {hotkey: 'Delete', isEnabled: () => !readOnly && selectedItems.length > 0, handler: () => onDelete(selectedPaths())},
      customDeleteMac: command('Backspace', () => onDelete(selectedPaths()), {isEnabled: () => !readOnly && selectedItems.length > 0}),
      customClear: {
        hotkey: 'Escape',
        isEnabled: current => !current.isSearchOpen() && selectedItems.length > 0,
        handler: () => onSelection([]),
      },
      customSelectAll: command('KeyA', (_, current) => onSelection(current.getItems().map(item => item.getId()))),
      customCopy: command('KeyC', () => onCopy(selectedPaths()), {isEnabled: () => selectedItems.length > 0}),
      customCut: command('KeyX', () => onCut(selectedPaths()), {isEnabled: () => !readOnly && selectedItems.length > 0}),
      customPaste: command('KeyV', (_, current) => onPaste(current.getFocusedItem() ? pasteFolder(current.getFocusedItem()) : ''), {
        isEnabled: () => !readOnly,
      }),
      customUndo: command('KeyZ', () => onUndo(), {isEnabled: () => !readOnly}),
    },
    features: [syncDataLoaderFeature, selectionFeature, hotkeysCoreFeature, dragAndDropFeature, searchFeature],
  });

  // A new listing is new data for the same tree.
  useEffect(() => ht.rebuildTree(), [ht, items]);

  // A press anywhere but on a row or in the context menu drops the selection.
  const hasSelection = selectedItems.length > 0;
  useEffect(() => {
    if (!hasSelection) return undefined;
    const clear = event => {
      if (event.target.closest?.('[role="treeitem"], [role="menu"]')) return;
      onSelection([]);
    };
    document.addEventListener('mousedown', clear);
    return () => document.removeEventListener('mousedown', clear);
  }, [hasSelection, onSelection]);

  // The row the workbench asks to show (the active file, or a breadcrumb's folder) is scrolled to.
  useEffect(() => {
    if (!reveal || !items.has(reveal.path)) return;
    ht.getItemInstance(reveal.path).scrollTo({block: 'nearest'}).catch(() => {});
  }, [ht, items, reveal]);

  const target = ht.getDragTarget();
  const rows = ht.getItems();
  const editingParent = editing && editing.mode !== 'rename' ? editing.parent : null;

  const newEntryInput = depth => (
    <NameInput
      key="new-entry"
      initial=""
      depth={depth}
      folder={editing.mode === 'folder'}
      status={editing.status}
      validate={name => entryProblem(tree, editing.parent, name)}
      onCommit={onCommitEdit}
      onCancel={onCancelEdit}
      onRetype={onRetypeEdit}
    />
  );

  const container = ht.getContainerProps('Files');
  return (
    <div
      {...container}
      className={clsx(styles.tree, target?.item.getId() === ROOT && styles.dropRoot)}
      tabIndex={rows.length ? -1 : 0}
      onContextMenu={event => onContextMenu(event, null)}
    >
      {ht.isSearchOpen() && (
        <div className={styles.treeFind}>
          <input {...ht.getSearchInputElementProps()} aria-label="Find in the tree" placeholder="Find" />
          <span>{ht.getSearchMatchingItems().length} found</span>
        </div>
      )}
      {editingParent === '' && newEntryInput(0)}
      {rows.map(item => {
        const node = nodeOf(item);
        if (node === GONE) return null;
        const folder = node.type === 'folder';
        const open = folder && item.isExpanded();
        const depth = item.getItemMeta().level;
        if (editing?.mode === 'rename' && editing.node.path === node.path) {
          return (
            <NameInput
              key={node.path}
              initial={node.name}
              depth={depth}
              folder={folder}
              status={editing.status}
              validate={name => entryProblem(tree, dirname(node.path), name, node.path)}
              onCommit={onCommitEdit}
              onCancel={onCancelEdit}
              onRetype={onRetypeEdit}
            />
          );
        }
        const props = item.getProps();
        return (
          <React.Fragment key={item.getKey()}>
            <div
              {...props}
              className={clsx(
                styles.row,
                item.isSelected() && styles.rowSelected,
                item.isFocused() && styles.rowFocused,
                activePath === node.path && styles.rowActive,
                folder && item.isUnorderedDragTarget() && styles.rowDrop,
                item.isMatchingSearch() && styles.rowFound,
                cut.has(node.path) && styles.rowCut,
              )}
              title={node.path}
              draggable={!readOnly && !editing}
              onClick={event => {
                props.onClick(event);
                // A click shows a file in a tab that the next click replaces; ⌘ or Shift only selects.
                if (!folder && !event.shiftKey && !event.metaKey && !event.ctrlKey) onOpen(node, {preview: true});
              }}
              onDoubleClick={() => { if (!folder) onOpen(node); }}
              onContextMenu={event => {
                event.stopPropagation();
                if (!item.isSelected()) onSelection([node.path]);
                onFocused(node.path);
                onContextMenu(event, node);
              }}
            >
              <Indent depth={depth} />
              {folder ? <Chevron open={open} /> : <span className={styles.chevronSpace} />}
              {folder ? <FolderIcon open={open} /> : <FileIcon name={node.name} />}
              <span className={styles.rowName}>{node.label}</span>
              <span className={styles.rowMeta}>
                {ACCESS_TITLES[node.access] && <span className={styles.accessBadge} title={ACCESS_TITLES[node.access]}>{node.access}</span>}
                {dirtyPaths.has(node.path) && <span className={styles.dirtyDot} title="Unsaved changes" />}
                {!folder && <LocalStatus held={held.get(node.path)} />}
              </span>
            </div>
            {folder && open && editingParent === node.path && newEntryInput(depth + 1)}
          </React.Fragment>
        );
      })}
      {!rows.length && editingParent === null && (
        <div className={styles.emptyTree}>
          <p className={styles.emptyTitle}>No files yet</p>
          {!readOnly && <p>Drop files here, or right-click to create one.</p>}
        </div>
      )}
    </div>
  );
}
