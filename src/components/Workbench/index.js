import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {useHistory, useLocation} from '@docusaurus/router';
import {toast} from '@site/src/components/Toast/toast';
import * as api from './api';
import Editor from './Editor';
import Explorer, {ContextMenu} from './Explorer';
import {basename, buildTree, dirname, invalidName, join, movedPath, within} from './tree';
import styles from './styles.module.css';

/**
 * The workspace file system as a small VS Code: an explorer of every file and
 * folder on the left, open files in tabs on the right. Everything lives in the
 * workspace file system (docs/plans/workspace-filesystem.md); this component
 * holds the listing, the open tabs and their unsaved text, and carries out
 * every explorer action through ./api. The open file is kept in ?path=.
 *
 * A save names the revision the tab was read at, so an edit made elsewhere in
 * the meantime is reported rather than overwritten. Who can see a file or
 * folder (the workspace, only you, or anyone) is set from its context menu.
 */

const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
const PDF = /\.pdf$/i;
// Past this a file is downloaded rather than loaded into the editor.
const EDIT_LIMIT = 2 * 1024 * 1024;

function kindOf(file) {
  if (IMAGE.test(file.path)) return 'image';
  if (PDF.test(file.path)) return 'pdf';
  return file.size > EDIT_LIMIT ? 'large' : 'text';
}

export default function Workbench({workspace}) {
  const location = useLocation();
  const history = useHistory();
  const readOnly = workspace.role === 'viewer';
  const expandedKey = `mochi:workbench-expanded:${workspace.id}`;

  const [listing, setListing] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [expanded, setExpanded] = useState(() => new Set(JSON.parse(sessionStorage.getItem(expandedKey) ?? '[]')));
  const [selected, setSelected] = useState(null);
  const [tabs, setTabs] = useState([]);
  const [activePath, setActivePath] = useState(null);
  const [editing, setEditing] = useState(null);
  const [menu, setMenu] = useState(null);
  const [trash, setTrash] = useState(null);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  const tree = useMemo(() => (listing ? buildTree(listing.files, listing.folders) : null), [listing]);
  const dirtyPaths = useMemo(
    () => new Set(tabs.filter(tab => tab.kind === 'text' && tab.text !== tab.saved).map(tab => tab.path)),
    [tabs],
  );

  const load = useCallback(() => api.listFiles()
    .then(data => { setListing(data); setLoadError(null); return data; })
    .catch(error => { setLoadError(error.message); return null; }), []);

  useEffect(() => { sessionStorage.setItem(expandedKey, JSON.stringify([...expanded])); }, [expandedKey, expanded]);

  // ⌘S saves the open file wherever focus is, rather than saving the web page.
  useEffect(() => {
    const saveShortcut = event => {
      if (event.key.toLowerCase() !== 's' || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      if (activePath) save(activePath);
    };
    window.addEventListener('keydown', saveShortcut);
    return () => window.removeEventListener('keydown', saveShortcut);
  });

  // Unsaved text is lost with the tab, so leaving the page asks first.
  useEffect(() => {
    if (!dirtyPaths.size) return undefined;
    const warn = event => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirtyPaths]);

  const updateTab = (path, patch) => setTabs(current => current.map(tab => (tab.path === path ? {...tab, ...patch} : tab)));

  // Open `folder` and every folder above it.
  const expandTo = folder => setExpanded(current => {
    const next = new Set(current);
    for (let open = folder; open; open = dirname(open)) next.add(open);
    return next;
  });

  const open = useCallback(file => {
    setActivePath(file.path);
    if (tabsRef.current.some(tab => tab.path === file.path)) return;
    const kind = kindOf(file);
    setTabs(current => [...current, {path: file.path, kind, loading: kind === 'text', text: '', saved: ''}]);
    if (kind !== 'text') return;
    api.readFile(file.path)
      .then(result => updateTab(file.path, result.binary
        ? {kind: 'binary', loading: false, rev: result.rev}
        : {text: result.text, saved: result.text, loading: false, rev: result.rev}))
      .catch(error => updateTab(file.path, {loading: false, error: error.message}));
  }, []);

  // The first listing opens the file the URL names, and reveals it in the tree.
  useEffect(() => {
    load().then(data => {
      const requested = new URLSearchParams(location.search).get('path');
      const file = requested && data?.files.find(item => item.path === requested);
      if (!file) return;
      expandTo(dirname(file.path));
      setSelected(file);
      open(file);
    });
    // Only on arrival: later listings must not reopen the file the URL first named.
  }, [load]);

  useEffect(() => {
    const search = activePath ? `?path=${encodeURIComponent(activePath)}` : '';
    if (location.search !== search) history.replace({pathname: location.pathname, search});
    // The URL follows the active tab, never the reverse.
  }, [activePath]);

  const run = async (action, after) => {
    try {
      const result = await action();
      await load();
      after?.(result);
    } catch (error) {
      toast.error(error.message);
    }
  };

  const save = path => {
    const tab = tabsRef.current.find(item => item.path === path);
    if (!tab || tab.kind !== 'text' || readOnly || tab.saving) return;
    const text = tab.text;
    updateTab(path, {saving: true});
    api.saveFile(path, text, {baseRev: tab.rev})
      .then(entry => { updateTab(path, {saving: false, saved: text, rev: entry.rev}); load(); })
      .catch(error => {
        updateTab(path, {saving: false});
        toast.error(error.code === 'stale-revision'
          ? `${basename(path)} was changed elsewhere. Copy your edits, close the tab, and open it again.`
          : error.message);
      });
  };

  const close = path => {
    const tab = tabsRef.current.find(item => item.path === path);
    if (tab?.kind === 'text' && tab.text !== tab.saved && !window.confirm(`Discard unsaved changes to ${basename(path)}?`)) return;
    const index = tabsRef.current.findIndex(item => item.path === path);
    const remaining = tabsRef.current.filter(item => item.path !== path);
    setTabs(remaining);
    if (activePath === path) setActivePath(remaining[Math.min(index, remaining.length - 1)]?.path ?? null);
  };

  // A rename or move carries open tabs, the selection and open folders along.
  const followMove = (from, to) => {
    setTabs(current => current.map(tab => ({...tab, path: movedPath(tab.path, from, to)})));
    setActivePath(current => current && movedPath(current, from, to));
    setSelected(current => current && {...current, path: movedPath(current.path, from, to)});
    setExpanded(current => new Set([...current].map(path => movedPath(path, from, to))));
  };

  const move = (from, folder) => {
    const to = join(folder, basename(from));
    run(() => api.moveEntry(from, to), () => { followMove(from, to); expandTo(folder); });
  };

  const remove = node => {
    const folder = node.type === 'folder';
    const unsaved = [...dirtyPaths].filter(path => within(path, node.path));
    const warning = unsaved.length ? `\n\nUnsaved changes in ${unsaved.map(basename).join(', ')} will be lost.` : '';
    if (!window.confirm(`Delete ${folder ? `the folder ${node.path} and everything in it` : node.path}?${warning}`)) return;
    run(() => (folder ? api.deleteFolder(node.path) : api.deleteFile(node.path)), () => {
      const remaining = tabsRef.current.filter(tab => !within(tab.path, node.path));
      setTabs(remaining);
      setActivePath(current => (current && within(current, node.path) ? remaining.at(-1)?.path ?? null : current));
      setSelected(null);
    });
  };

  // Where a new entry goes: the selected folder, else the selected file's folder, else the root.
  const targetFolder = () => (selected?.type === 'folder' ? selected.path : selected ? dirname(selected.path) : '');

  const startCreate = (mode, parent = targetFolder()) => {
    expandTo(parent);
    setEditing({mode, parent});
  };

  const commitEdit = name => {
    const edit = editing;
    setEditing(null);
    const problem = invalidName(name);
    if (problem) {
      toast.error(problem);
      return;
    }
    if (edit.mode === 'rename') {
      const to = join(dirname(edit.node.path), name);
      run(() => api.moveEntry(edit.node.path, to), () => followMove(edit.node.path, to));
    } else if (edit.mode === 'folder') {
      const path = join(edit.parent, name);
      run(() => api.makeFolder(path), () => { setExpanded(current => new Set(current).add(path)); setSelected({type: 'folder', path}); });
    } else {
      const path = join(edit.parent, name);
      run(() => api.saveFile(path, '', {create: true}), entry => { setSelected({type: 'file', ...entry}); open(entry); });
    }
  };

  const toggle = path => setExpanded(current => {
    const next = new Set(current);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    return next;
  });

  const copyPath = path => navigator.clipboard.writeText(path).then(() => toast.success(`Copied ${path}`));

  const ACCESS_LABELS = {workspace: 'Workspace members', private: 'Only me', public: 'Anyone, signed in or not'};
  const share = (node, access) => run(() => api.setAccess(node.path, access), () => toast.success(access
    ? `${node.path}: ${ACCESS_LABELS[access].toLowerCase()} can see it`
    : `${node.path} now follows its folder`));

  const openTrash = () => api.listTrash()
    .then(nodes => setTrash(nodes.filter(node => !nodes.some(other => other !== node && within(node.path, other.path)
      && other.kind === 'folder' && other.deletedAt === node.deletedAt))))
    .catch(error => toast.error(error.message));
  const restoreNode = node => run(() => api.restore(node.id), () => { openTrash(); expandTo(dirname(node.path)); });
  const purgeTrash = () => {
    if (!window.confirm('Permanently delete everything in the trash? This cannot be undone.')) return;
    run(() => api.emptyTrash(), () => setTrash([]));
  };

  // The context menu: groups of actions for what was right-clicked (a file, a
  // folder, or the empty explorer), separated as VS Code separates them.
  const showMenu = (event, node) => {
    event.preventDefault();
    const file = node?.type === 'file';
    const groups = [
      file ? [
        {label: 'Open', run: () => open(node)},
        {label: 'Download', run: () => window.open(api.fileUrl(workspace.id, node.path, {download: true}), '_self')},
      ] : [],
      !readOnly && !file ? [
        {label: 'New File…', run: () => startCreate('file', node?.path ?? '')},
        {label: 'New Folder…', run: () => startCreate('folder', node?.path ?? '')},
      ] : [],
      node ? [{label: 'Copy Path', run: () => copyPath(node.path)}] : [{label: 'Refresh', run: load}],
      node && !readOnly ? Object.entries(ACCESS_LABELS).map(([access, label]) => ({
        label: `${node.access === access ? '✓ ' : ''}Visible to: ${label}`,
        run: () => share(node, access),
      })).concat(node.accessExplicit ? [{label: 'Visible to: same as its folder', run: () => share(node, null)}] : []) : [],
      node && !readOnly ? [
        {label: 'Rename…', shortcut: 'F2', run: () => setEditing({mode: 'rename', node})},
        {label: 'Delete', shortcut: '⌫', danger: true, run: () => remove(node)},
      ] : [],
      !node ? [{label: 'Show Trash', run: openTrash}] : [],
    ].filter(group => group.length);
    const items = groups.flatMap((group, index) => (index ? ['separator', ...group] : group));
    setMenu({x: event.clientX, y: event.clientY, items});
  };
  const closeMenu = useCallback(() => setMenu(null), []);

  return (
    <div className={styles.workbench}>
      <aside className={styles.explorer}>
        <div className={styles.explorerHeader}>
          <span>Explorer</span>
          <div className={styles.explorerActions}>
            {!readOnly && (
              <>
                <button type="button" title="New File" aria-label="New File" onClick={() => startCreate('file')}>
                  <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 1.75h5l3.25 3.25v9.25H4zM8 7.5v4M6 9.5h4" /></svg>
                </button>
                <button type="button" title="New Folder" aria-label="New Folder" onClick={() => startCreate('folder')}>
                  <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.75 3.75h4.5l1.5 1.5h6.5v7.5H1.75zM8 7.25v4M6 9.25h4" /></svg>
                </button>
              </>
            )}
            <button type="button" title="Refresh" aria-label="Refresh" onClick={load}>
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.46-3.54M13 2.5v3h-3" /></svg>
            </button>
            <button type="button" title="Collapse Folders" aria-label="Collapse Folders" onClick={() => setExpanded(new Set())}>
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 2.5h9v11h-9zM6 8h4" /></svg>
            </button>
            <button type="button" title="Trash" aria-label="Trash" onClick={() => (trash ? setTrash(null) : openTrash())}>
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.75 9h5.5l.75-9" /></svg>
            </button>
          </div>
        </div>
        {loadError && <p className={styles.loadError}>{loadError}</p>}
        {tree && (
          <Explorer
            tree={tree}
            expanded={expanded}
            selected={selected}
            activePath={activePath}
            dirtyPaths={dirtyPaths}
            editing={editing}
            readOnly={readOnly}
            onToggle={toggle}
            onSelect={setSelected}
            onOpen={open}
            onCommitEdit={commitEdit}
            onCancelEdit={() => setEditing(null)}
            onContextMenu={showMenu}
            onMove={move}
            onRename={node => setEditing({mode: 'rename', node})}
            onDelete={remove}
          />
        )}
        {trash && (
          <div className={styles.trash}>
            <div className={styles.explorerHeader}>
              <span>Trash</span>
              {!readOnly && trash.length > 0 && workspace.role === 'owner' && (
                <button type="button" className={styles.trashEmpty} onClick={purgeTrash}>Empty</button>
              )}
            </div>
            {trash.length === 0 && <p className={styles.emptyTree}>The trash is empty.</p>}
            {trash.map(node => (
              <div key={node.id} className={styles.trashRow} title={node.path}>
                <span className={styles.rowName}>{node.path}{node.kind === 'folder' ? '/' : ''}</span>
                {!readOnly && <button type="button" onClick={() => restoreNode(node)}>Restore</button>}
              </div>
            ))}
          </div>
        )}
      </aside>
      <section className={styles.editorArea}>
        <Editor
          tabs={tabs}
          activePath={activePath}
          readOnly={readOnly}
          fileUrl={(path, options) => api.fileUrl(workspace.id, path, options)}
          onActivate={setActivePath}
          onClose={close}
          onChange={(path, text) => updateTab(path, {text})}
        />
      </section>
      {menu && <ContextMenu menu={menu} onClose={closeMenu} />}
    </div>
  );
}
