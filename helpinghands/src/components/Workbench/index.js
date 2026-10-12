import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {useHistory, useLocation} from '@docusaurus/router';
import {toast} from '@site/src/components/Toast/toast';
import API_BASE, {apiJson} from '@site/src/utils/api';
import {isOffline} from '@site/src/utils/documentCache';
import {followWorkspaceChanges} from '@site/src/utils/fsEvents';
import {FS_SYNC_EVENT, fsReplica, startFsSync} from '@site/src/utils/fsReplica';
import {loadWorkspaces, navigateClient} from '@site/src/utils/workspaces';
import * as api from './api';
import Editor from './Editor';
import {openLiveDocument} from './liveDocument';
import {appFor} from './apps';
import Explorer, {ContextMenu} from './Explorer';
import {basename, buildTree, dirname, invalidName, join, movedPath, tabChanges, within} from './tree';
import styles from './styles.module.css';

/**
 * The workspace file system as a small VS Code: an explorer of every file and
 * folder on the left, open files in tabs on the right. Everything lives in the
 * workspace file system (docs/plans/workspace-filesystem.md); this component
 * holds the listing, the open tabs and their unsaved text, and carries out
 * every explorer action through ./api. The open file is kept in ?path=.
 *
 * A save names the revision the tab was read at, so an edit made elsewhere in
 * the meantime is reported rather than overwritten. Open tabs follow what the
 * workspace's push channel reports was done elsewhere: renames, deletes, and
 * writes, which a tab without unsaved edits reads in. Who can see a file or
 * folder (the workspace, only you, or anyone) is set from its context menu.
 *
 * This browser keeps a replica (utils/fsReplica.js): the tree, and the text
 * files opened or kept on this computer. Without a network the explorer shows
 * the replica, kept files open, and saves wait to upload; each row says
 * whether its file is in the cloud only, on this computer, kept, or waiting.
 */

const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
const MARKDOWN = /\.mdx?$/i;
const PDF = /\.pdf$/i;
// Past this a file is downloaded rather than loaded into the editor.
const EDIT_LIMIT = 2 * 1024 * 1024;

const unsaved = tab => tab.kind === 'text' && tab.text !== tab.saved;

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
  const [scope, setScope] = useState(null);
  const [held, setHeld] = useState(() => new Map());
  const [offline, setOffline] = useState(false);
  const [plugins, setPlugins] = useState([]);
  const tabsRef = useRef(tabs);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  tabsRef.current = tabs;

  const tree = useMemo(() => (listing ? buildTree(listing.files, listing.folders) : null), [listing]);
  const dirtyPaths = useMemo(
    () => new Set(tabs.filter(unsaved).map(tab => tab.path)),
    [tabs],
  );

  const refreshHeld = useCallback(async () => {
    if (scopeRef.current) setHeld(await fsReplica().held(scopeRef.current));
  }, []);

  // The server's tree when it answers, this browser's copy when it cannot be reached.
  const load = useCallback(async () => {
    const replica = fsReplica();
    try {
      const data = await api.listFiles();
      if (scopeRef.current) await replica.rememberTree(scopeRef.current, data.nodes);
      setListing(data);
      setLoadError(null);
      setOffline(false);
      refreshHeld();
      return data;
    } catch (error) {
      const nodes = isOffline(error) && scopeRef.current ? await replica.tree(scopeRef.current) : null;
      if (!nodes) {
        setLoadError(error.message);
        return null;
      }
      const data = api.listingOf(nodes);
      setListing(data);
      setLoadError(null);
      setOffline(true);
      refreshHeld();
      return data;
    }
  }, [refreshHeld]);

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

  // Markdown opens live once this browser knows whose replica it is.
  const openLive = useCallback(file => {
    setTabs(current => [...current, {path: file.path, kind: 'live', loading: true}]);
    openLiveDocument({
      scope: scopeRef.current, workspaceId: workspace.id, path: file.path, readOnly,
      onStatus: liveStatus => updateTab(file.path, {liveStatus}),
    })
      .then(live => {
        // A tab closed while it opened takes its document with it.
        if (!tabsRef.current.some(tab => tab.path === file.path)) {
          live.close();
          return;
        }
        updateTab(file.path, {live, loading: false});
      })
      .catch(error => updateTab(file.path, {loading: false, error: isOffline(error)
        ? `${basename(file.path)} is not kept on this computer, and the server cannot be reached.`
        : error.message}));
  }, [readOnly, workspace.id]);

  const open = useCallback(file => {
    setActivePath(file.path);
    if (tabsRef.current.some(tab => tab.path === file.path)) return;
    if (MARKDOWN.test(file.path) && scopeRef.current) {
      openLive(file);
      return;
    }
    const kind = kindOf(file);
    setTabs(current => [...current, {path: file.path, kind, loading: kind === 'text', text: '', saved: ''}]);
    if (kind !== 'text') return;
    (async () => {
      const replica = fsReplica();
      const current = scopeRef.current;
      const kept = current ? await replica.read(current, file.path) : null;
      // This browser's copy is current when it holds the listed revision or an unsent edit.
      if (kept && (kept.pending || kept.rev === file.rev)) {
        updateTab(file.path, {text: kept.text, saved: kept.text, loading: false, rev: kept.rev});
        return;
      }
      try {
        const result = await api.readFile(file.path);
        if (result.binary) {
          updateTab(file.path, {kind: 'binary', loading: false, rev: result.rev});
          return;
        }
        updateTab(file.path, {text: result.text, saved: result.text, loading: false, rev: result.rev});
        if (current) await replica.remember(current, file.path, result);
        refreshHeld();
      } catch (error) {
        if (kept && isOffline(error)) {
          updateTab(file.path, {text: kept.text, saved: kept.text, loading: false, rev: kept.rev});
          return;
        }
        updateTab(file.path, {loading: false, error: isOffline(error)
          ? `${basename(file.path)} is not kept on this computer, and the server cannot be reached.`
          : error.message});
      }
    })();
  }, [openLive, refreshHeld]);

  // The installed plugins, for which app opens which file.
  useEffect(() => {
    apiJson(`${API_BASE}/api/workspaces/${encodeURIComponent(workspace.id)}/site`, {cacheMs: 5 * 60_000})
      .then(result => { if (result.ok) setPlugins(result.data.plugins ?? []); })
      .catch(error => console.error('[workspace] Could not list the installed apps:', error));
  }, [workspace.id]);
  const appLink = path => {
    const app = appFor(path, plugins);
    return app ? {title: app.title, href: `/w/${encodeURIComponent(workspace.slug)}/${app.page}`} : null;
  };

  // Leaving the page closes every live document and its stream.
  useEffect(() => () => { for (const tab of tabsRef.current) tab.live?.close(); }, []);

  // Who this replica belongs to, then keep it in step with the server.
  useEffect(() => {
    let cancelled = false;
    loadWorkspaces().then(({userId}) => {
      if (!cancelled && userId) setScope({userId, workspaceId: workspace.id});
    }).catch(error => console.error('[workspace] This browser cannot keep files without an account:', error));
    return () => { cancelled = true; };
  }, [workspace.id]);

  useEffect(() => {
    if (!scope) return undefined;
    const onSync = ({detail}) => {
      if (detail.scope.workspaceId !== scope.workspaceId || detail.scope.userId !== scope.userId) return;
      if (detail.uploaded) {
        updateTab(detail.path, {rev: detail.rev});
        toast.success(`Uploaded your offline edit to ${basename(detail.path)}.`);
      } else if (detail.conflictedCopy) {
        toast.warning(`${detail.path} changed while you were offline, so your edit was saved as ${detail.conflictedCopy}.`, {duration: 0});
      } else if (detail.error) {
        toast.error(`Your offline edit to ${detail.path} could not be uploaded: ${detail.error}`, {duration: 0});
      } else if (detail.disconnected) {
        toast.error('The server stopped sending this workspace\'s changes. Reload the page to follow them again.', {duration: 0});
      }
      load();
    };
    window.addEventListener(FS_SYNC_EVENT, onSync);
    const stop = startFsSync(scope);
    load();
    return () => {
      stop();
      window.removeEventListener(FS_SYNC_EVENT, onSync);
    };
  }, [scope, load]);

  const togglePinned = node => {
    const pinned = !held.get(node.path)?.pinned;
    fsReplica().setPinned(scope, node.path, pinned)
      .then(() => {
        refreshHeld();
        toast.success(pinned ? `${node.path} is kept on this computer` : `${node.path} may be removed from this computer`);
      })
      .catch(error => toast.error(error.message));
  };

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
    if (tab?.kind === 'live') {
      tab.live?.flush();
      return;
    }
    if (!tab || tab.kind !== 'text' || readOnly || tab.saving) return;
    const text = tab.text;
    updateTab(path, {saving: true});
    api.saveFile(path, text, {baseRev: tab.rev})
      .then(entry => {
        updateTab(path, {saving: false, saved: text, rev: entry.rev});
        if (scopeRef.current) fsReplica().remember(scopeRef.current, path, {text, rev: entry.rev});
        load();
      })
      .catch(async error => {
        updateTab(path, {saving: false});
        if (isOffline(error) && scopeRef.current) {
          await fsReplica().queueWrite(scopeRef.current, {path, text, baseRev: tab.rev});
          updateTab(path, {saved: text});
          refreshHeld();
          toast.info(`You are offline. ${basename(path)} is saved on this computer and will upload when you reconnect.`);
          return;
        }
        toast.error(error.code === 'stale-revision'
          ? `${basename(path)} was changed elsewhere. Copy your edits, close the tab, and open it again.`
          : error.message);
      });
  };

  // `discard` closes a tab with unsaved edits without asking.
  const close = (path, {discard = false} = {}) => {
    const tab = tabsRef.current.find(item => item.path === path);
    if (!discard && tab && unsaved(tab) && !window.confirm(`Discard unsaved changes to ${basename(path)}?`)) return;
    const index = tabsRef.current.findIndex(item => item.path === path);
    const remaining = tabsRef.current.filter(item => item.path !== path);
    tab?.live?.close();
    setTabs(remaining);
    if (activePath === path) setActivePath(remaining[Math.min(index, remaining.length - 1)]?.path ?? null);
  };

  // Renames and moves, `[from, to]` in order, carry open tabs, the selection and open folders along.
  const followMoves = moves => {
    const moved = path => moves.reduce((current, [from, to]) => movedPath(current, from, to), path);
    // A live document is bound to its path, so a moved one is opened again there.
    const reopen = tabsRef.current.filter(tab => tab.kind === 'live' && moved(tab.path) !== tab.path);
    for (const tab of reopen) tab.live?.close();
    setTabs(current => current
      .filter(tab => !reopen.includes(tab))
      .map(tab => ({...tab, path: moved(tab.path)})));
    for (const tab of reopen) openLive({path: moved(tab.path)});
    setActivePath(current => current && moved(current));
    setSelected(current => current && {...current, path: moved(current.path)});
    setExpanded(current => new Set([...current].map(moved)));
    return moved;
  };

  // Changes made elsewhere, in feed order. Open tabs follow renames. A deleted
  // tab closes, unless it has unsaved edits, which it then offers to save as a
  // new file. A write is read into a tab without unsaved edits, and marks one
  // with them as changed elsewhere. Live tabs read in writes themselves
  // (liveDocument.js).
  const followElsewhere = changes => {
    const {moves, deleted, written} = tabChanges(changes);
    const moved = moves.length ? followMoves(moves) : path => path;
    const opened = tabsRef.current.map(tab => ({tab, path: moved(tab.path)}));
    const closing = [];
    for (const {tab, path} of opened) {
      if (![...deleted].some(gone => within(path, gone))) continue;
      if (unsaved(tab)) {
        updateTab(path, {deleted: true});
        continue;
      }
      closing.push(path);
      // A moved live tab was closed and is opening again; it closes itself once it finds its tab gone.
      if (path === tab.path) tab.live?.close();
    }
    if (closing.length) {
      const remaining = opened.map(({path}) => path).filter(path => !closing.includes(path));
      setTabs(current => current.filter(tab => !closing.includes(tab.path)));
      setActivePath(current => (current && closing.includes(current) ? remaining.at(-1) ?? null : current));
    }
    for (const {tab, path} of opened) {
      const rev = written.get(path);
      if (rev === undefined || tab.kind !== 'text' || tab.loading || tab.saving || !(rev > tab.rev)) continue;
      if (unsaved(tab)) {
        updateTab(path, {changedElsewhere: true, deleted: false});
        continue;
      }
      api.readFile(path).then(result => {
        if (result.binary) return;
        // Edits typed while it was read keep the tab, which is then marked instead.
        setTabs(current => current.map(item => {
          if (item.path !== path || !(result.rev > item.rev)) return item;
          return unsaved(item)
            ? {...item, changedElsewhere: true, deleted: false}
            : {...item, text: result.text, saved: result.text, rev: result.rev, changedElsewhere: false};
        }));
        if (scopeRef.current) fsReplica().remember(scopeRef.current, path, result);
      }).catch(error => toast.error(`Could not read the change to ${path}: ${error.message}`));
    }
  };
  const followRef = useRef(followElsewhere);
  followRef.current = followElsewhere;

  useEffect(() => followWorkspaceChanges(workspace.id, {
    changes: list => followRef.current(list),
    missed: api.changesBetween,
    failed: error => toast.error(`Could not read what changed in the workspace while it was disconnected, so open tabs may be out of date: ${error.message}`, {duration: 0}),
  }), [workspace.id]);

  // A tab with unsaved edits whose file was deleted elsewhere saves them as the file again.
  const saveAsNew = path => {
    const tab = tabsRef.current.find(item => item.path === path);
    const text = tab.text;
    api.saveFile(path, text, {create: true})
      .then(entry => {
        updateTab(path, {saved: text, rev: entry.rev, deleted: false, changedElsewhere: false});
        if (scopeRef.current) fsReplica().remember(scopeRef.current, path, {text, rev: entry.rev});
        load();
      })
      .catch(error => toast.error(error.message));
  };

  const move = (from, folder) => {
    const to = join(folder, basename(from));
    run(() => api.moveEntry(from, to), () => { followMoves([[from, to]]); expandTo(folder); });
  };

  const remove = node => {
    const folder = node.type === 'folder';
    const unsaved = [...dirtyPaths].filter(path => within(path, node.path));
    const warning = unsaved.length ? `\n\nUnsaved changes in ${unsaved.map(basename).join(', ')} will be lost.` : '';
    if (!window.confirm(`Delete ${folder ? `the folder ${node.path} and everything in it` : node.path}?${warning}`)) return;
    run(() => (folder ? api.deleteFolder(node.path) : api.deleteFile(node.path)), () => {
      const remaining = tabsRef.current.filter(tab => !within(tab.path, node.path));
      for (const tab of tabsRef.current) if (within(tab.path, node.path)) tab.live?.close();
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
      run(() => api.moveEntry(edit.node.path, to), () => followMoves([[edit.node.path, to]]));
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
  const shareWithPeople = async node => {
    let members;
    try {
      members = (await api.listMembers()).filter(member => member.id !== scopeRef.current?.userId);
    } catch (error) {
      toast.error(error.message);
      return;
    }
    const answer = window.prompt(
      `Share ${node.path} with which members? Enter their emails, separated by commas.\n\n`
        + members.map(member => member.email).join('\n'),
    );
    if (answer === null) return;
    const wanted = answer.split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
    const unknown = wanted.filter(email => !members.some(member => member.email.toLowerCase() === email));
    if (unknown.length) {
      toast.error(`Not members of this workspace: ${unknown.join(', ')}`);
      return;
    }
    const ids = members.filter(member => wanted.includes(member.email.toLowerCase())).map(member => member.id);
    run(() => api.setAccess(node.path, 'shared', ids), () => toast.success(`${node.path} is shared with ${wanted.length} ${wanted.length === 1 ? 'member' : 'members'}`));
  };

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
        ...(appLink(node.path) ? [{label: `Open in ${appLink(node.path).title}`, run: () => navigateClient(appLink(node.path).href)}] : []),
        {label: 'Download', run: () => window.open(api.fileUrl(workspace.id, node.path, {download: true}), '_self')},
        ...(scope && kindOf(node) === 'text' ? [{
          label: held.get(node.path)?.pinned ? '✓ Kept on this computer' : 'Keep on this computer',
          run: () => togglePinned(node),
        }] : []),
      ] : [],
      !readOnly && !file ? [
        {label: 'New File…', run: () => startCreate('file', node?.path ?? '')},
        {label: 'New Folder…', run: () => startCreate('folder', node?.path ?? '')},
      ] : [],
      node ? [{label: 'Copy Path', run: () => copyPath(node.path)}] : [{label: 'Refresh', run: load}],
      node && !readOnly ? Object.entries(ACCESS_LABELS).map(([access, label]) => ({
        label: `${node.access === access ? '✓ ' : ''}Visible to: ${label}`,
        run: () => share(node, access),
      })).concat(
        [{label: `${node.access === 'shared' ? '✓ ' : ''}Visible to: specific people…`, run: () => shareWithPeople(node)}],
        node.accessExplicit ? [{label: 'Visible to: same as its folder', run: () => share(node, null)}] : [],
      ) : [],
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
        {offline && <p className={styles.offlineNote}>Offline: showing the files kept on this computer.</p>}
        {loadError && <p className={styles.loadError}>{loadError}</p>}
        {tree && (
          <Explorer
            tree={tree}
            expanded={expanded}
            selected={selected}
            activePath={activePath}
            dirtyPaths={dirtyPaths}
            held={held}
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
          appLink={appLink}
          onActivate={setActivePath}
          onClose={close}
          onSaveAsNew={saveAsNew}
          onDiscard={path => close(path, {discard: true})}
          onChange={(path, text) => updateTab(path, {text})}
        />
      </section>
      {menu && <ContextMenu menu={menu} onClose={closeMenu} />}
    </div>
  );
}
