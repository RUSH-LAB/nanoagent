import React, {useEffect, useRef, useState} from 'react';
import clsx from 'clsx';
import {basename, dirname, visibleRows, within} from './tree';
import styles from './styles.module.css';

/**
 * The workbench's file tree, modelled on VS Code's explorer: folders first,
 * chevrons to open them, inline inputs for new and renamed entries, a context
 * menu, drag-and-drop moves and keyboard navigation. It owns no data; every
 * action is a callback the workbench carries out.
 */

const DRAG_TYPE = 'application/x-mochi-workspace-path';

// Extension → the tint of its file icon, so kinds of file read at a glance.
const TINTS = [
  [/\.(md|markdown|txt)$/i, styles.tintText],
  [/\.(tex|sty|cls|bib|bbl)$/i, styles.tintTex],
  [/\.(py|js|mjs|cjs|jsx|ts|tsx|sh|bash|zsh)$/i, styles.tintCode],
  [/\.(json|ya?ml|toml|csv)$/i, styles.tintData],
  [/\.(png|jpe?g|gif|webp|svg|pdf)$/i, styles.tintMedia],
];

function FileIcon({name}) {
  const tint = TINTS.find(([pattern]) => pattern.test(name))?.[1];
  return (
    <svg className={clsx(styles.fileIcon, tint)} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 1.75h5l3.25 3.25v9.25H4z" />
      <path d="M9 1.75V5h3.25" />
    </svg>
  );
}

function Chevron({open}) {
  return (
    <svg className={clsx(styles.chevron, open && styles.chevronOpen)} viewBox="0 0 16 16" aria-hidden="true">
      <path d="m6 4 4 4-4 4" />
    </svg>
  );
}

function NameInput({initial, depth, folder, onCommit, onCancel}) {
  const [value, setValue] = useState(initial);
  const input = useRef(null);
  const settled = useRef(false);

  useEffect(() => {
    const element = input.current;
    element.focus();
    // Select the name without its extension, as VS Code does when renaming.
    const dot = initial.lastIndexOf('.');
    element.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [initial]);

  const finish = commit => {
    if (settled.current) return;
    settled.current = true;
    if (commit && value.trim() && value !== initial) onCommit(value.trim());
    else onCancel();
  };

  return (
    <div className={styles.row} style={{paddingLeft: `${0.5 + depth * 0.9}rem`}}>
      {folder ? <Chevron open={false} /> : <span className={styles.chevronSpace} />}
      {folder ? <span className={styles.folderIcon} aria-hidden="true" /> : <FileIcon name={value} />}
      <input
        ref={input}
        className={styles.nameInput}
        value={value}
        onChange={event => setValue(event.target.value)}
        onKeyDown={event => {
          event.stopPropagation();
          if (event.key === 'Enter') finish(true);
          if (event.key === 'Escape') finish(false);
        }}
        onBlur={() => finish(true)}
        aria-label={folder ? 'Folder name' : 'File name'}
      />
    </div>
  );
}

export function ContextMenu({menu, onClose}) {
  const element = useRef(null);
  useEffect(() => {
    const close = event => {
      if (event.type === 'keydown' && event.key !== 'Escape') return;
      if (event.type === 'mousedown' && element.current?.contains(event.target)) return;
      onClose();
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    window.addEventListener('blur', onClose);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  return (
    <ul ref={element} className={styles.contextMenu} style={{left: menu.x, top: menu.y}} role="menu">
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

export default function Explorer({
  tree, expanded, selected, activePath, dirtyPaths, editing, readOnly,
  onToggle, onSelect, onOpen, onCommitEdit, onCancelEdit, onContextMenu, onMove, onRename, onDelete,
}) {
  const [dropTarget, setDropTarget] = useState(null);
  const rows = visibleRows(tree, expanded);
  const editingParent = editing && editing.mode !== 'rename' ? editing.parent : null;

  const keyDown = event => {
    if (editing) return;
    const index = rows.findIndex(row => row.node.path === selected?.path);
    const current = rows[index]?.node;
    const select = row => row && onSelect(row.node);
    if (event.key === 'ArrowDown') select(rows[Math.min(index + 1, rows.length - 1)] ?? rows[0]);
    else if (event.key === 'ArrowUp') select(rows[Math.max(index - 1, 0)]);
    else if (event.key === 'ArrowRight' && current?.type === 'folder' && !expanded.has(current.path)) onToggle(current.path);
    else if (event.key === 'ArrowLeft' && current?.type === 'folder' && expanded.has(current.path)) onToggle(current.path);
    else if (event.key === 'Enter' && current) (current.type === 'folder' ? onToggle(current.path) : onOpen(current));
    else if (event.key === 'F2' && current && !readOnly) onRename(current);
    else if ((event.key === 'Delete' || (event.key === 'Backspace' && event.metaKey)) && current && !readOnly) onDelete(current);
    else return;
    event.preventDefault();
  };

  // Where a dragged entry may land: a folder (or the root, '') it is not already in or under.
  const canDrop = (from, folder) => from && !within(folder, from) && dirname(from) !== folder;
  const dropProps = folder => (readOnly ? {} : {
    onDragOver: event => {
      if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
      event.preventDefault();
      event.stopPropagation();
      setDropTarget(folder);
    },
    onDragLeave: event => {
      event.stopPropagation();
      setDropTarget(current => (current === folder ? null : current));
    },
    onDrop: event => {
      event.preventDefault();
      event.stopPropagation();
      setDropTarget(null);
      const from = event.dataTransfer.getData(DRAG_TYPE);
      if (canDrop(from, folder)) onMove(from, folder);
    },
  });

  const newEntryInput = depth => (
    <NameInput
      key="new-entry"
      initial=""
      depth={depth}
      folder={editing.mode === 'folder'}
      onCommit={onCommitEdit}
      onCancel={onCancelEdit}
    />
  );

  return (
    <div
      className={clsx(styles.tree, dropTarget === '' && styles.dropRoot)}
      tabIndex={0}
      role="tree"
      aria-label="Files"
      onKeyDown={keyDown}
      onContextMenu={event => onContextMenu(event, null)}
      {...dropProps('')}
    >
      {editingParent === '' && newEntryInput(0)}
      {rows.map(({node, depth}) => {
        const folder = node.type === 'folder';
        const open = folder && expanded.has(node.path);
        if (editing?.mode === 'rename' && editing.node.path === node.path) {
          return (
            <NameInput key={node.path} initial={node.name} depth={depth} folder={folder} onCommit={onCommitEdit} onCancel={onCancelEdit} />
          );
        }
        return (
          <React.Fragment key={node.path}>
            <div
              className={clsx(
                styles.row,
                selected?.path === node.path && styles.rowSelected,
                activePath === node.path && styles.rowActive,
                folder && dropTarget === node.path && styles.rowDrop,
              )}
              style={{paddingLeft: `${0.5 + depth * 0.9}rem`}}
              role="treeitem"
              aria-expanded={folder ? open : undefined}
              aria-selected={selected?.path === node.path}
              title={node.path}
              draggable={!readOnly}
              onDragStart={event => {
                event.dataTransfer.setData(DRAG_TYPE, node.path);
                event.dataTransfer.effectAllowed = 'move';
              }}
              onClick={() => {
                onSelect(node);
                if (folder) onToggle(node.path);
                else onOpen(node);
              }}
              onContextMenu={event => {
                event.stopPropagation();
                onSelect(node);
                onContextMenu(event, node);
              }}
              {...(folder ? dropProps(node.path) : {})}
            >
              {folder ? <Chevron open={open} /> : <span className={styles.chevronSpace} />}
              {folder ? <span className={clsx(styles.folderIcon, open && styles.folderOpen)} aria-hidden="true" /> : <FileIcon name={node.name} />}
              <span className={styles.rowName}>{basename(node.path)}</span>
              {node.access === 'public' && <span className={styles.accessBadge} title="Anyone can see this">public</span>}
              {node.access === 'private' && <span className={styles.accessBadge} title="Only you can see this">private</span>}
              {dirtyPaths.has(node.path) && <span className={styles.dirtyDot} title="Unsaved changes" />}
            </div>
            {folder && open && editingParent === node.path && newEntryInput(depth + 1)}
          </React.Fragment>
        );
      })}
      {!rows.length && editingParent === null && (
        <p className={styles.emptyTree}>No files yet. {readOnly ? '' : 'Right-click to create one, or ask a plugin to save something.'}</p>
      )}
    </div>
  );
}
