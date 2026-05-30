import React, {useState, useEffect, useCallback} from 'react';
import FileTree from './FileTree';
import TipTapEditor from './TipTapEditor';
import styles from './styles.module.css';

const API_BASE = 'http://localhost:3001';

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
  const [files, setFiles] = useState([]);
  const [selectedFile, setSelectedFile] = useState(initialFile || null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [saveStatus, setSaveStatus] = useState(null);

  const loadFiles = useCallback(() => {
    fetch(`${API_BASE}/api/files`)
      .then(res => res.json())
      .then(data => setFiles(data.files || []))
      .catch(() => setFiles([]));
  }, []);

  useEffect(() => {
    loadFiles();
  }, [loadFiles]);

  const handleNewFile = useCallback(async () => {
    const name = window.prompt('File path (relative to content/):\ne.g. posts/blog/my-new-post.md');
    if (!name) return;
    const filePath = name.startsWith('content/') ? name : `content/${name}`;
    if (!filePath.endsWith('.md') && !filePath.endsWith('.mdx')) {
      window.alert('File must end with .md or .mdx');
      return;
    }

    const title = filePath.split('/').pop().replace(/\.(md|mdx)$/, '').replace(/-/g, ' ');
    const defaultContent = `---\ntitle: "${title}"\ndate: ${new Date().toISOString().split('T')[0]}\n---\n\n# ${title}\n\n`;

    try {
      const res = await fetch(`${API_BASE}/api/file`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({path: filePath, content: defaultContent}),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to create file');
      }
      loadFiles();
      setSelectedFile(filePath);
    } catch (err) {
      window.alert(err.message);
    }
  }, [loadFiles]);

  return (
    <div className={styles.layout}>
      {sidebarOpen && (
        <FileTree
          files={files}
          selectedFile={selectedFile}
          onSelectFile={setSelectedFile}
          onNewFile={handleNewFile}
        />
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
        </div>
        {saveStatus === 'saved' && (
          <div className={styles.toast}>Saved</div>
        )}
        <TipTapEditor filePath={selectedFile} onSaveStatus={setSaveStatus} />
      </div>
    </div>
  );
}
