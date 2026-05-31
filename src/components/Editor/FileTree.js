import React, {useState, useEffect, useCallback, useMemo, useRef} from 'react';
import styles from './styles.module.css';
import API_BASE from '@site/src/utils/api';

function ChevronIcon({open}) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      style={{transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s'}}>
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

function FolderIcon({open}) {
  if (open) {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
      </svg>
    );
  }
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </svg>
  );
}

function relativeTime(mtimeMs) {
  if (!mtimeMs) return '';
  const diff = Date.now() - mtimeMs;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return 'now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

function TreeNode({node, depth, selectedFile, onSelectFile, onDeleteFile, onRenameFile, onMoveFile, expandedPaths, onToggleExpand, bulkSelected, onToggleBulkSelect, selectMode, focusedPath}) {
  const [dropOver, setDropOver] = useState(false);
  const [hovered, setHovered] = useState(false);
  const isDir = node.type === 'directory';
  const isSelected = !isDir && node.path === selectedFile;
  const isReview = node.name.startsWith('_') && node.name.includes('.review.');
  const open = expandedPaths ? expandedPaths.has(node.path) : depth < 1;
  const isBulkSelected = !isDir && bulkSelected.has(node.path);
  const isFocused = node.path === focusedPath;

  if (isReview) return null;

  // Drag & drop handlers for directories (drop targets)
  const handleDragOver = (e) => {
    if (!isDir) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDropOver(true);
  };

  const handleDragLeave = (e) => {
    if (!isDir) return;
    setDropOver(false);
  };

  const handleDrop = (e) => {
    if (!isDir) return;
    e.preventDefault();
    setDropOver(false);
    const oldPath = e.dataTransfer.getData('text/plain');
    if (!oldPath) return;
    // Extract filename from the old path
    const fileName = oldPath.split('/').pop();
    // Compute parent directory of the dragged file
    const oldDir = oldPath.substring(0, oldPath.lastIndexOf('/'));
    // Don't move if dropping on the same parent directory
    if (oldDir === node.path) return;
    const newPath = `${node.path}/${fileName}`;
    onMoveFile?.(oldPath, newPath);
  };

  if (isDir) {
    const children = (node.children || []).filter(c => {
      if (c.type === 'file' && c.name.startsWith('_') && c.name.includes('.review.')) return false;
      return true;
    });
    if (children.length === 0) return null;

    return (
      <div role="treeitem" aria-expanded={open} aria-label={node.name}>
        <button
          className={`${styles.treeItem} ${dropOver ? styles.treeItemDropTarget : ''} ${isFocused ? styles.treeItemFocused : ''}`}
          style={{paddingLeft: 8 + depth * 16}}
          onClick={() => onToggleExpand ? onToggleExpand(node.path) : null}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          data-tree-path={node.path}
          aria-label={`${open ? 'Collapse' : 'Expand'} folder ${node.name}`}
        >
          <ChevronIcon open={open} />
          <FolderIcon open={open} />
          <span className={styles.treeName}>{node.name}</span>
        </button>
        {open && children.map(child => (
          <TreeNode
            key={child.path}
            node={child}
            depth={depth + 1}
            selectedFile={selectedFile}
            onSelectFile={onSelectFile}
            onDeleteFile={onDeleteFile}
            onRenameFile={onRenameFile}
            onMoveFile={onMoveFile}
            expandedPaths={expandedPaths}
            onToggleExpand={onToggleExpand}
            bulkSelected={bulkSelected}
            onToggleBulkSelect={onToggleBulkSelect}
            selectMode={selectMode}
            focusedPath={focusedPath}
          />
        ))}
      </div>
    );
  }

  // Drag handlers for files (drag sources)
  const handleDragStart = (e) => {
    e.dataTransfer.setData('text/plain', node.path);
    e.dataTransfer.effectAllowed = 'move';
  };

  const showCheckbox = selectMode || hovered || isBulkSelected;

  return (
    <div
      className={styles.treeFileRow}
      role="treeitem"
      aria-selected={isSelected}
      aria-label={node.name}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {showCheckbox && (
        <input
          type="checkbox"
          className={styles.bulkCheckbox}
          checked={isBulkSelected}
          onChange={() => onToggleBulkSelect(node.path)}
          onClick={(e) => e.stopPropagation()}
          title="Select for bulk action"
        />
      )}
      <button
        className={`${styles.treeItem} ${isSelected ? styles.treeItemSelected : ''} ${isBulkSelected ? styles.treeItemBulkSelected : ''} ${isFocused ? styles.treeItemFocused : ''}`}
        style={{paddingLeft: showCheckbox ? 4 + depth * 16 : 8 + depth * 16}}
        data-tree-path={node.path}
        onClick={(e) => {
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            onToggleBulkSelect(node.path);
          } else {
            onSelectFile(node.path);
          }
        }}
        draggable="true"
        onDragStart={handleDragStart}
        aria-label={`File ${node.name.replace(/\.(md|mdx)$/, '')}`}
      >
        <span style={{width: 12}} />
        <FileIcon />
        <span className={styles.treeName}>{node.name.replace(/\.(md|mdx)$/, '')}</span>
        {hovered && node.mtime && !selectMode && (
          <span style={{
            marginLeft: 'auto',
            fontSize: 11,
            color: 'var(--text-muted, #888)',
            opacity: 0.7,
            whiteSpace: 'nowrap',
            paddingLeft: 8,
          }}>{relativeTime(node.mtime)}</span>
        )}
      </button>
      {isSelected && bulkSelected.size === 0 && (
        <div className={styles.treeActions}>
          <button
            className={styles.treeActionBtn}
            onClick={(e) => { e.stopPropagation(); onRenameFile?.(node.path); }}
            title="Rename"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
            </svg>
          </button>
          <button
            className={styles.treeActionBtn}
            onClick={(e) => { e.stopPropagation(); onDeleteFile?.(node.path); }}
            title="Delete"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 6h18" /><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
              <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}

function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18" /><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
    </svg>
  );
}

function RestoreIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="1 4 1 10 7 10" />
      <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
    </svg>
  );
}

function TrashSection({trashFiles, onRestore}) {
  const [open, setOpen] = useState(false);
  const [restoring, setRestoring] = useState(null);

  if (!trashFiles || trashFiles.length === 0) return null;

  const handleRestore = async (trashPath) => {
    setRestoring(trashPath);
    try {
      const res = await fetch(`${API_BASE}/api/trash/restore`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({trashPath}),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Restore failed');
      }
      onRestore?.();
    } catch (err) {
      window.alert(err.message);
    } finally {
      setRestoring(null);
    }
  };

  return (
    <>
      <div style={{
        borderTop: '1px solid var(--ifm-toc-border-color, #e3e3e3)',
        margin: '8px 0 0',
        padding: '4px 0 0',
      }} />
      <button
        className={styles.treeItem}
        style={{paddingLeft: 8, opacity: 0.7}}
        onClick={() => setOpen(!open)}
      >
        <ChevronIcon open={open} />
        <TrashIcon />
        <span className={styles.treeName} style={{fontStyle: 'italic'}}>
          Recently Deleted ({trashFiles.length})
        </span>
      </button>
      {open && trashFiles.map(file => (
        <div
          key={file.trashPath}
          className={styles.treeFileRow}
          style={{opacity: 0.5}}
        >
          <div
            className={styles.treeItem}
            style={{paddingLeft: 24, cursor: 'default'}}
          >
            <FileIcon />
            <span className={styles.treeName} style={{fontStyle: 'italic'}}>
              {file.originalName.replace(/\.(md|mdx)$/, '')}
            </span>
            <span style={{
              marginLeft: 'auto',
              fontSize: 11,
              color: 'var(--text-muted, #888)',
              whiteSpace: 'nowrap',
              paddingLeft: 8,
            }}>
              {relativeTime(new Date(file.deletedAt).getTime())}
            </span>
          </div>
          <div className={styles.treeActions} style={{display: 'flex'}}>
            <button
              className={styles.treeActionBtn}
              onClick={() => handleRestore(file.trashPath)}
              title="Restore"
              disabled={restoring === file.trashPath}
            >
              <RestoreIcon />
            </button>
          </div>
        </div>
      ))}
    </>
  );
}

export default function FileTree({files, selectedFile, onSelectFile, onNewFile, onDeleteFile, onRenameFile, onMoveFile, expandedPaths, onToggleExpand, onRestore}) {
  const [trashFiles, setTrashFiles] = useState([]);
  const [bulkSelected, setBulkSelected] = useState(new Set());
  const [selectMode, setSelectMode] = useState(false);
  const [bulkLoading, setBulkLoading] = useState(false);
  const [streak, setStreak] = useState(null);
  const [focusedPath, setFocusedPath] = useState(null);
  const treeContainerRef = useRef(null);

  // Build a flat list of visible items (respecting expanded/collapsed directories)
  const visibleItems = useMemo(() => {
    const items = [];
    const walk = (nodes, depth) => {
      for (const node of nodes) {
        // Skip review files
        if (node.name.startsWith('_') && node.name.includes('.review.')) continue;

        const isDir = node.type === 'directory';
        if (isDir) {
          const children = (node.children || []).filter(c => {
            if (c.type === 'file' && c.name.startsWith('_') && c.name.includes('.review.')) return false;
            return true;
          });
          // Skip empty directories (matches TreeNode behavior)
          if (children.length === 0) continue;
          items.push({path: node.path, type: 'directory', node});
          const open = expandedPaths ? expandedPaths.has(node.path) : depth < 1;
          if (open) {
            walk(children, depth + 1);
          }
        } else {
          items.push({path: node.path, type: 'file', node});
        }
      }
    };
    walk(files, 0);
    return items;
  }, [files, expandedPaths]);

  // Keyboard navigation handler
  const handleTreeKeyDown = useCallback((e) => {
    const {key} = e;
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter'].includes(key)) return;
    e.preventDefault();

    if (visibleItems.length === 0) return;

    const currentIndex = focusedPath
      ? visibleItems.findIndex(item => item.path === focusedPath)
      : -1;

    if (key === 'ArrowDown') {
      const nextIndex = currentIndex < visibleItems.length - 1 ? currentIndex + 1 : 0;
      const nextPath = visibleItems[nextIndex].path;
      setFocusedPath(nextPath);
      // Scroll into view
      const el = treeContainerRef.current?.querySelector(`[data-tree-path="${CSS.escape(nextPath)}"]`);
      el?.scrollIntoView({block: 'nearest'});
    } else if (key === 'ArrowUp') {
      const prevIndex = currentIndex > 0 ? currentIndex - 1 : visibleItems.length - 1;
      const prevPath = visibleItems[prevIndex].path;
      setFocusedPath(prevPath);
      const el = treeContainerRef.current?.querySelector(`[data-tree-path="${CSS.escape(prevPath)}"]`);
      el?.scrollIntoView({block: 'nearest'});
    } else if (key === 'Enter') {
      if (currentIndex < 0) return;
      const item = visibleItems[currentIndex];
      if (item.type === 'file') {
        onSelectFile(item.path);
      } else {
        onToggleExpand?.(item.path);
      }
    } else if (key === 'ArrowRight') {
      if (currentIndex < 0) return;
      const item = visibleItems[currentIndex];
      if (item.type === 'directory') {
        const isOpen = expandedPaths ? expandedPaths.has(item.path) : false;
        if (!isOpen) {
          onToggleExpand?.(item.path);
        }
      }
    } else if (key === 'ArrowLeft') {
      if (currentIndex < 0) return;
      const item = visibleItems[currentIndex];
      if (item.type === 'directory') {
        const isOpen = expandedPaths ? expandedPaths.has(item.path) : false;
        if (isOpen) {
          onToggleExpand?.(item.path);
        }
      }
    }
  }, [visibleItems, focusedPath, onSelectFile, onToggleExpand, expandedPaths]);

  useEffect(() => {
    fetch(`${API_BASE}/api/streak?userId=default`)
      .then(r => r.json())
      .then(d => setStreak(d))
      .catch(() => {});
  }, []);

  const loadTrash = useCallback(() => {
    fetch(`${API_BASE}/api/trash`)
      .then(res => res.json())
      .then(data => setTrashFiles(data.files || []))
      .catch(() => setTrashFiles([]));
  }, []);

  // Load trash on mount and whenever the file list changes (which means loadFiles was called)
  useEffect(() => {
    loadTrash();
  }, [loadTrash, files]);

  // Track Ctrl/Cmd key to reveal checkboxes
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Control' || e.key === 'Meta') setSelectMode(true);
    };
    const handleKeyUp = (e) => {
      if (e.key === 'Control' || e.key === 'Meta') setSelectMode(false);
    };
    const handleBlur = () => setSelectMode(false);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
    };
  }, []);

  const toggleBulkSelect = useCallback((filePath) => {
    setBulkSelected(prev => {
      const next = new Set(prev);
      if (next.has(filePath)) next.delete(filePath);
      else next.add(filePath);
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => {
    setBulkSelected(new Set());
  }, []);

  const handleBulkDelete = useCallback(async () => {
    const count = bulkSelected.size;
    if (!window.confirm(`Delete ${count} file${count > 1 ? 's' : ''}? They will be moved to trash.`)) return;
    setBulkLoading(true);
    try {
      const resp = await fetch(`${API_BASE}/api/files/bulk`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({action: 'delete', paths: [...bulkSelected]}),
      });
      const data = await resp.json();
      if (data.errors && data.errors.length > 0) {
        alert(`Deleted ${data.processed} file${data.processed !== 1 ? 's' : ''}. ${data.errors.length} failed.`);
      }
      setBulkSelected(new Set());
      onRestore?.(); // triggers file list reload
    } catch {
      alert('Bulk delete failed');
    } finally {
      setBulkLoading(false);
    }
  }, [bulkSelected, onRestore]);

  const handleBulkMove = useCallback(async () => {
    const targetDir = window.prompt('Move files to directory (e.g. content/archive):');
    if (!targetDir) return;
    setBulkLoading(true);
    try {
      const resp = await fetch(`${API_BASE}/api/files/bulk`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({action: 'move', paths: [...bulkSelected], targetDir}),
      });
      const data = await resp.json();
      if (!resp.ok) {
        alert(data.error || 'Move failed');
        return;
      }
      if (data.errors && data.errors.length > 0) {
        alert(`Moved ${data.processed} file${data.processed !== 1 ? 's' : ''}. ${data.errors.length} failed:\n${data.errors.map(e => `${e.path}: ${e.error}`).join('\n')}`);
      }
      setBulkSelected(new Set());
      onRestore?.(); // triggers file list reload
    } catch {
      alert('Bulk move failed');
    } finally {
      setBulkLoading(false);
    }
  }, [bulkSelected, onRestore]);

  const handleRestore = useCallback(() => {
    loadTrash();
    onRestore?.();
  }, [loadTrash, onRestore]);

  const selectionCount = bulkSelected.size;

  return (
    <div className={styles.sidebar}>
      <div className={styles.sidebarHeader}>
        <span>Files</span>
        {onNewFile && (
          <button className={styles.newFileBtn} onClick={onNewFile} title="New file">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
        )}
      </div>
      <div
        className={styles.treeContainer}
        role="tree"
        aria-label="File tree"
        tabIndex={0}
        ref={treeContainerRef}
        onKeyDown={handleTreeKeyDown}
      >
        {files.map(node => (
          <TreeNode
            key={node.path}
            node={node}
            depth={0}
            selectedFile={selectedFile}
            onSelectFile={onSelectFile}
            onDeleteFile={onDeleteFile}
            onRenameFile={onRenameFile}
            onMoveFile={onMoveFile}
            expandedPaths={expandedPaths}
            onToggleExpand={onToggleExpand}
            bulkSelected={bulkSelected}
            onToggleBulkSelect={toggleBulkSelect}
            selectMode={selectMode}
            focusedPath={focusedPath}
          />
        ))}
        <TrashSection trashFiles={trashFiles} onRestore={handleRestore} />
      </div>
      {selectionCount > 0 && (
        <div className={styles.bulkBar}>
          <span className={styles.bulkBarCount}>
            {selectionCount} file{selectionCount > 1 ? 's' : ''} selected
          </span>
          <div className={styles.bulkBarActions}>
            <button
              className={styles.bulkBarBtn}
              onClick={handleBulkMove}
              disabled={bulkLoading}
              title="Move selected files"
            >
              Move
            </button>
            <button
              className={`${styles.bulkBarBtn} ${styles.bulkBarBtnDanger}`}
              onClick={handleBulkDelete}
              disabled={bulkLoading}
              title="Delete selected files"
            >
              Delete
            </button>
            <button
              className={styles.bulkBarBtnCancel}
              onClick={clearSelection}
              disabled={bulkLoading}
              title="Clear selection"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Writing streak widget */}
      {streak && (
        <div style={{
          padding: '10px 14px', borderTop: '1px solid var(--ifm-toc-border-color)',
          fontSize: '0.78rem', color: 'var(--ifm-color-emphasis-600)',
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <span style={{fontSize: '1.1rem'}}>
            {streak.currentStreak > 0 ? '\u{1F525}' : '\u{1F4DD}'}
          </span>
          <div style={{flex: 1}}>
            <div style={{fontWeight: 600, fontSize: '0.82rem'}}>
              {streak.currentStreak > 0
                ? `${streak.currentStreak} day streak`
                : 'Start writing!'}
            </div>
            <div style={{fontSize: '0.72rem', color: 'var(--ifm-color-emphasis-500)'}}>
              {(streak.totalWords || 0).toLocaleString()} total words
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
