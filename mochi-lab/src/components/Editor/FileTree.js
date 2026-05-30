import React, {useState} from 'react';
import styles from './styles.module.css';

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

function TreeNode({node, depth, selectedFile, onSelectFile}) {
  const [open, setOpen] = useState(depth < 1);
  const isDir = node.type === 'directory';
  const isSelected = !isDir && node.path === selectedFile;
  const isReview = node.name.startsWith('_') && node.name.includes('.review.');

  if (isReview) return null;

  if (isDir) {
    const children = (node.children || []).filter(c => {
      if (c.type === 'file' && c.name.startsWith('_') && c.name.includes('.review.')) return false;
      return true;
    });
    if (children.length === 0) return null;

    return (
      <div>
        <button
          className={styles.treeItem}
          style={{paddingLeft: 8 + depth * 16}}
          onClick={() => setOpen(!open)}
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
          />
        ))}
      </div>
    );
  }

  return (
    <button
      className={`${styles.treeItem} ${isSelected ? styles.treeItemSelected : ''}`}
      style={{paddingLeft: 8 + depth * 16}}
      onClick={() => onSelectFile(node.path)}
    >
      <span style={{width: 12}} />
      <FileIcon />
      <span className={styles.treeName}>{node.name.replace(/\.(md|mdx)$/, '')}</span>
    </button>
  );
}

export default function FileTree({files, selectedFile, onSelectFile, onNewFile}) {
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
      <div className={styles.treeContainer}>
        {files.map(node => (
          <TreeNode
            key={node.path}
            node={node}
            depth={0}
            selectedFile={selectedFile}
            onSelectFile={onSelectFile}
          />
        ))}
      </div>
    </div>
  );
}
