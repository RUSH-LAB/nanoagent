import React, {useState, useEffect, useCallback, useMemo, useRef} from 'react';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import FileTree from './FileTree';
import RecentFiles from './RecentFiles';
import TipTapEditor from './TipTapEditor';
import FileSearchDialog from './FileSearchDialog';
import TemplateModal from './TemplateModal';
import styles from './styles.module.css';
import API_BASE from '@site/src/utils/api';
import {toast} from '@site/src/components/Toast/toast';

function filePathToPageUrl(filePath) {
  if (!filePath) return null;
  let p = filePath
    .replace(/^content\/books\//, '/')
    .replace(/^content\/posts\//, '/')
    .replace(/\/index\.(md|mdx)$/, '')
    .replace(/\.(md|mdx)$/, '');
  const name = p.split('/').pop();
  if (/^\d+-/.test(name)) {
    p = p.replace(/\/\d+-([^/]+)$/, '/$1');
  }
  return p;
}

export default function Editor({initialFile}) {
  const {siteConfig} = useDocusaurusContext();
  const authEnabled = siteConfig.customFields?.authEnabled;
  const [files, setFiles] = useState([]);
  const [selectedFile, setSelectedFile] = useState(initialFile || null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [saveStatus, setSaveStatus] = useState(null);
  const [expandedPaths, setExpandedPaths] = useState(new Set());
  const [searchOpen, setSearchOpen] = useState(false);
  const [newFileOpen, setNewFileOpen] = useState(false);
  const [preselectedTemplate, setPreselectedTemplate] = useState(null);
  const [userRole, setUserRole] = useState(null);
  const [roleLoading, setRoleLoading] = useState(true);
  const [serverOnline, setServerOnline] = useState(true);
  const [showReconnected, setShowReconnected] = useState(false);
  const wasOfflineRef = useRef(false);

  const isReadOnly = userRole === 'viewer';

  useEffect(() => {
    if (!authEnabled) {
      setUserRole('owner');
      setRoleLoading(false);
      return;
    }
    setRoleLoading(true);
    const userId = typeof sessionStorage !== 'undefined'
      ? sessionStorage.getItem('mochi-presence-userId') || 'anonymous'
      : 'anonymous';
    fetch(`${API_BASE}/api/users/me?userId=${encodeURIComponent(userId)}`)
      .then(r => r.json())
      .then(data => {
        setUserRole(data.role || 'viewer');
        setRoleLoading(false);
      })
      .catch(() => {
        setUserRole('owner');
        setRoleLoading(false);
      });
  }, [authEnabled]);

  // Periodic health check — ping /api/health every 15s
  useEffect(() => {
    let timer;
    let abortTimeout;
    let reconnectedTimeout;
    const checkHealth = () => {
      const controller = new AbortController();
      abortTimeout = setTimeout(() => controller.abort(), 5000);
      fetch(`${API_BASE}/api/health`, {signal: controller.signal})
        .then(res => {
          clearTimeout(abortTimeout);
          if (res.ok) {
            if (wasOfflineRef.current) {
              setShowReconnected(true);
              reconnectedTimeout = setTimeout(() => setShowReconnected(false), 3000);
            }
            wasOfflineRef.current = false;
            setServerOnline(true);
          } else {
            wasOfflineRef.current = true;
            setServerOnline(false);
          }
        })
        .catch(() => {
          clearTimeout(abortTimeout);
          wasOfflineRef.current = true;
          setServerOnline(false);
        });
    };
    checkHealth();
    timer = setInterval(checkHealth, 15000);
    return () => {
      clearInterval(timer);
      clearTimeout(abortTimeout);
      clearTimeout(reconnectedTimeout);
    };
  }, []);

  const loadFiles = useCallback(() => {
    fetch(`${API_BASE}/api/files`)
      .then(res => res.json())
      .then(data => setFiles(data.files || []))
      .catch(() => setFiles([]));
  }, []);

  useEffect(() => {
    loadFiles();
  }, [loadFiles]);

  // Sync selected file to URL query param
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location);
    if (selectedFile) {
      url.searchParams.set('file', selectedFile);
    } else {
      url.searchParams.delete('file');
    }
    window.history.replaceState({}, '', url);
  }, [selectedFile]);

  const expandPathTo = useCallback((filePath) => {
    const parts = filePath.split('/');
    setExpandedPaths(prev => {
      const newExpanded = new Set(prev);
      let current = '';
      for (let i = 0; i < parts.length - 1; i++) {
        current = current ? `${current}/${parts[i]}` : parts[i];
        newExpanded.add(current);
      }
      return newExpanded;
    });
  }, []);

  const handleSelectFile = useCallback((filePath) => {
    setSelectedFile(filePath);
    if (typeof localStorage !== 'undefined' && filePath) {
      try {
        const recent = JSON.parse(localStorage.getItem('mochi-recent-files') || '[]');
        const filtered = recent.filter(f => f !== filePath);
        filtered.unshift(filePath);
        localStorage.setItem('mochi-recent-files', JSON.stringify(filtered.slice(0, 10)));
        window.dispatchEvent(new Event('mochi-recent-updated'));
      } catch {}
    }
  }, []);

  const handleNewFile = useCallback((template) => {
    // Guard against receiving a DOM event (e.g. from onClick={handleNewFile})
    const tpl = (template && typeof template === 'object' && template.name) ? template : null;
    setPreselectedTemplate(tpl);
    setNewFileOpen(true);
  }, []);

  const handleCreateFile = useCallback(async (filePath, content) => {
    try {
      const res = await fetch(`${API_BASE}/api/file`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({path: filePath, content}),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to create file');
      }
      loadFiles();
      setSelectedFile(filePath);
      expandPathTo(filePath);
    } catch (err) {
      toast.error(err.message);
    }
  }, [loadFiles, expandPathTo]);

  const handleDeleteFile = useCallback(async (filePath) => {
    if (!window.confirm(`Delete ${filePath}?`)) return;
    try {
      const res = await fetch(`${API_BASE}/api/file?path=${encodeURIComponent(filePath)}`, {method: 'DELETE'});
      if (!res.ok) throw new Error('Delete failed');
      const data = await res.json();
      if (selectedFile === filePath) setSelectedFile(null);
      loadFiles();
      if (data.trashPath) {
        toast.info(`Deleted ${filePath.split('/').pop()}`, {
          duration: 8000,
          actionLabel: 'Undo',
          action: async () => {
            try {
              const restoreRes = await fetch(`${API_BASE}/api/trash/restore`, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({trashPath: data.trashPath}),
              });
              if (restoreRes.ok) {
                loadFiles();
                setSelectedFile(filePath);
                expandPathTo(filePath);
                toast.success('File restored');
              }
            } catch {}
          },
        });
      }
    } catch (err) {
      toast.error(err.message);
    }
  }, [selectedFile, loadFiles, expandPathTo]);

  const handleRenameFile = useCallback(async (oldPath) => {
    const newName = window.prompt('New file name:', oldPath.split('/').pop());
    if (!newName) return;
    const dir = oldPath.substring(0, oldPath.lastIndexOf('/'));
    const newPath = `${dir}/${newName}`;
    try {
      const res = await fetch(`${API_BASE}/api/file/rename`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({oldPath, newPath}),
      });
      if (!res.ok) throw new Error('Rename failed');
      if (selectedFile === oldPath) setSelectedFile(newPath);
      loadFiles();
    } catch (err) {
      window.alert(err.message);
    }
  }, [selectedFile, loadFiles]);

  const handleMoveFile = useCallback(async (oldPath, newPath) => {
    try {
      const res = await fetch(`${API_BASE}/api/file/rename`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({oldPath, newPath}),
      });
      if (!res.ok) throw new Error('Move failed');
      if (selectedFile === oldPath) setSelectedFile(newPath);
      loadFiles();
      expandPathTo(newPath);
    } catch (err) {
      window.alert(err.message);
    }
  }, [selectedFile, loadFiles, expandPathTo]);

  // Cmd+O file search shortcut
  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'o') {
        e.preventDefault();
        setSearchOpen(prev => !prev);
      }
      if (e.key === 'Escape') setSearchOpen(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  const flatFiles = useMemo(() => {
    const result = [];
    function walk(nodes) {
      for (const node of nodes) {
        if (node.type === 'file') result.push(node);
        else if (node.children) walk(node.children);
      }
    }
    walk(files);
    return result;
  }, [files]);

  return (
    <div className={styles.layout}>
      {sidebarOpen && (
        <div className={styles.sidebarWrap}>
          <RecentFiles
            onSelectFile={(path) => {
              handleSelectFile(path);
              expandPathTo(path);
            }}
            selectedFile={selectedFile}
          />
          <FileTree
            files={files}
            selectedFile={selectedFile}
            onSelectFile={handleSelectFile}
            onNewFile={handleNewFile}
            onDeleteFile={handleDeleteFile}
            onRenameFile={handleRenameFile}
            onMoveFile={handleMoveFile}
            expandedPaths={expandedPaths}
            onRestore={loadFiles}
            onToggleExpand={(path) => {
              setExpandedPaths(prev => {
                const next = new Set(prev);
                if (next.has(path)) next.delete(path);
                else next.add(path);
                return next;
              });
            }}
          />
        </div>
      )}
      <div className={styles.main}>
        <div className={styles.topBar}>
          <button
            className={styles.sidebarToggle}
            onClick={() => setSidebarOpen(!sidebarOpen)}
            title={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <line x1="9" y1="3" x2="9" y2="21" />
            </svg>
          </button>
          {selectedFile && filePathToPageUrl(selectedFile) && (
            <a
              className={styles.backBtn}
              href={filePathToPageUrl(selectedFile)}
              title="Back to page"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="15 18 9 12 15 6" />
              </svg>
              View Page
            </a>
          )}
          <button
            className={styles.backBtn}
            onClick={() => setSearchOpen(true)}
            title="Search files (Cmd+O)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            Search
          </button>
        </div>
        {saveStatus === 'saved' && (
          <div className={styles.toast}>Saved</div>
        )}
        {searchOpen && (
          <FileSearchDialog
            files={flatFiles}
            onSelect={(path) => {
              handleSelectFile(path);
              expandPathTo(path);
              setSearchOpen(false);
            }}
            onClose={() => setSearchOpen(false)}
          />
        )}
        {!roleLoading && isReadOnly && (
          <div style={{
            padding: '10px 16px',
            background: 'rgba(234, 179, 8, 0.08)',
            color: '#a16207',
            fontSize: '0.85rem',
            borderBottom: '1px solid rgba(234, 179, 8, 0.15)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            You have view-only access. Contact an admin for edit permissions.
          </div>
        )}
        {!serverOnline && (
          <div className={`${styles.serverBanner} ${styles.serverOffline}`}>
            Editor server is offline. Changes will be saved locally.
          </div>
        )}
        {showReconnected && serverOnline && (
          <div className={`${styles.serverBanner} ${styles.serverReconnected}`}>
            Server reconnected
          </div>
        )}
        <TipTapEditor
          filePath={selectedFile}
          onSaveStatus={setSaveStatus}
          readOnly={isReadOnly}
          onSelectFile={handleSelectFile}
          onNewFile={handleNewFile}
          onCreateFile={handleCreateFile}
          onNavigate={(dirPath) => {
            // Expand the directory in the file tree and open the sidebar
            const parts = dirPath.split('/');
            const newExpanded = new Set(expandedPaths);
            let current = '';
            for (const part of parts) {
              current = current ? `${current}/${part}` : part;
              newExpanded.add(current);
            }
            setExpandedPaths(newExpanded);
            setSidebarOpen(true);
          }}
        />
      </div>
      <TemplateModal
        open={newFileOpen}
        onClose={() => {
          setNewFileOpen(false);
          setPreselectedTemplate(null);
        }}
        onCreate={handleCreateFile}
        preselectedTemplate={preselectedTemplate}
      />
    </div>
  );
}
