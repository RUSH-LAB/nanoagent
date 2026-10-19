import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import clsx from 'clsx';
import {useHistory, useLocation} from '@docusaurus/router';
import {toast} from '@site/src/components/Toast/toast';
import API_BASE, {apiJson} from '@site/src/utils/api';
import {browserStore, isOffline} from '@site/src/utils/documentCache';
import {followWorkspaceChanges} from '@site/src/utils/fsEvents';
import {FS_SYNC_EVENT, fsReplica, startFsSync} from '@site/src/utils/fsReplica';
import {navigateClient} from '@site/src/utils/workspaces';
import {useAccount} from '@site/src/utils/account';
import * as api from './api';
import Editor from './Editor';
import {openLiveDocument} from './liveDocument';
import {appFor} from './apps';
import Explorer, {ContextMenu} from './Explorer';
import QuickOpen from './QuickOpen';
import Search from './Search';
import {basename, buildTree, comparePath, copyName, dirname, join, movedPath, nodeMap, tabChanges, topmost, trashRows, within} from './tree';
import {uploadsOf} from './upload';
import {closeIn, dropPaths, moveAll, moveTab, newGroup, showIn} from './groups';
import {editorViews} from './viewState';
import {clientPlatform} from '@site/src/platform/client';
import {useShell} from '@site/src/components/Shell/context';
import Sash from '@site/src/components/Shell/Sash';
import styles from './styles.module.css';

/**
 * The workspace file system as a small VS Code: an explorer of every file and
 * folder on the left, open files in tabs on the right. Everything lives in the
 * workspace file system (docs/plans/workspace-filesystem.md); this component
 * holds the listing, the open tabs and their unsaved text, and carries out
 * every explorer action through ./api. The open file is kept in ?path=.
 *
 * A save names the revision the tab was read at, so an edit made elsewhere in
 * the meantime is merged rather than overwritten. Open tabs follow what the
 * workspace's push channel reports was done elsewhere: renames, deletes, and
 * writes, which a tab without unsaved edits reads in. Who can see a file or
 * folder (the workspace, only you, or anyone) is set from its context menu,
 * which also compares a text file with an earlier revision and restores it.
 *
 * This browser keeps a replica (utils/fsReplica.js): the tree, and the text
 * files opened or kept on this computer. Without a network the explorer shows
 * the replica, kept files open, and saves wait to upload; each row says
 * whether its file is in the cloud only, on this computer, kept, or waiting.
 * It also keeps where each tab's editor was left (viewState.js): switching
 * tabs keeps the selection, scroll and undo history, and reopening a file
 * after a reload keeps the selection and scroll.
 */

const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
const MARKDOWN = /\.mdx?$/i;
const PDF = /\.pdf$/i;
// Past this a file is downloaded rather than loaded into the editor.
const EDIT_LIMIT = 2 * 1024 * 1024;
// How many recently opened files quick open remembers per workspace.
const RECENT_LIMIT = 20;
// The largest file the server takes (MAX_BODY_SIZE in src/server/server-utils.js).
const UPLOAD_LIMIT = 10 * 1024 * 1024;
// How many file operations ⌘Z can take back.
const UNDO_LIMIT = 50;

const unsaved = tab => tab.kind === 'text' && tab.text !== tab.saved;

function kindOf(file) {
  if (IMAGE.test(file.path)) return 'image';
  if (PDF.test(file.path)) return 'pdf';
  return file.size > EDIT_LIMIT ? 'large' : 'text';
}

export default function Workbench({workspace}) {
  // Inside the shell, the explorer is the Filesystem section's side bar: the activity bar hides and shows it, and its edge sets its width.
  const shell = useShell();
  const location = useLocation();
  const history = useHistory();
  const readOnly = workspace.role === 'viewer';
  const expandedKey = `mochi:workbench-expanded:${workspace.id}`;
  const recentKey = `mochi:workbench-recent:${workspace.id}`;

  const [listing, setListing] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [expanded, setExpanded] = useState(() => new Set(JSON.parse(sessionStorage.getItem(expandedKey) ?? '[]')));
  // The explorer's selected paths, the row keys act on (`focused`), and the row to scroll to.
  const [selection, setSelection] = useState([]);
  const [focused, setFocused] = useState(null);
  const [reveal, setReveal] = useState(null);
  // What ⌘C or ⌘X took, `{mode: 'copy' | 'cut', paths}`, for ⌘V.
  const [clipboard, setClipboard] = useState(null);
  // File operations to take back with ⌘Z, newest last: `{label, undo, after}`.
  const undoStack = useRef([]);
  const uploadInput = useRef(null);
  const uploadTarget = useRef('');
  // Each open file's tab state, by path; `groups` (groups.js) say which editor shows which, in what order.
  const [tabs, setTabs] = useState([]);
  const [groups, setGroups] = useState(() => [newGroup()]);
  const [currentGroup, setCurrentGroup] = useState(0);
  const current = Math.min(currentGroup, groups.length - 1);
  const activePath = groups[current].active;
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const currentRef = useRef(current);
  currentRef.current = current;
  // Show `path` in the group keys and clicks act on.
  const setActivePath = path => setGroups(all => showIn(all, currentRef.current, path));
  // Where a search result sends the editor: `{path, line, column, length}`, until the editor is there.
  const [goto, setGoto] = useState(null);
  const [editing, setEditing] = useState(null);
  const [menu, setMenu] = useState(null);
  const [trash, setTrash] = useState(null);
  // Who this replica belongs to: the account the gate knows, in this workspace.
  const {userId} = useAccount();
  const scope = useMemo(() => (userId ? {userId, workspaceId: workspace.id} : null), [userId, workspace.id]);
  const [held, setHeld] = useState(() => new Map());
  const [offline, setOffline] = useState(false);
  const [plugins, setPlugins] = useState([]);
  const [quickOpen, setQuickOpen] = useState(false);
  // What the side bar shows below its title: the explorer, or Search (⌘⇧F), and a count that moves the cursor into Search.
  const [sideView, setSideView] = useState('files');
  const [searchFocus, setSearchFocus] = useState(0);
  const [recent, setRecent] = useState(() => JSON.parse(localStorage.getItem(recentKey) ?? '[]'));
  const tabsRef = useRef(tabs);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  tabsRef.current = tabs;
  const views = useMemo(() => editorViews(browserStore(), () => scopeRef.current), []);

  const tree = useMemo(() => (listing ? buildTree(listing.files, listing.folders) : null), [listing]);
  const nodes = useMemo(() => (tree ? nodeMap(tree) : new Map()), [tree]);
  const focusedNode = nodes.get(focused) ?? null;
  const selectOnly = path => {
    setSelection([path]);
    setFocused(path);
  };
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
  useEffect(() => { localStorage.setItem(recentKey, JSON.stringify(recent)); }, [recentKey, recent]);

  // ⌘S saves the open file wherever focus is, rather than saving the web page;
  // ⌘P opens quick open rather than printing it.
  useEffect(() => {
    const shortcut = event => {
      if (!(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      if (key === 's') {
        event.preventDefault();
        if (activePath) save(activePath);
      } else if (key === 'f' && event.shiftKey) {
        event.preventDefault();
        shell?.setOpen(true);
        setSideView('search');
        setSearchFocus(count => count + 1);
      } else if (key === 'p' && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        setQuickOpen(current => !current);
      } else if (key === '\\' && activePath) {
        event.preventDefault();
        openToSide(activePath);
      }
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
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
  const openLive = useCallback((file, add = tab => setTabs(current => [...current, tab])) => {
    add({path: file.path, kind: 'live', loading: true});
    Promise.all([
      openLiveDocument({
        scope: scopeRef.current, workspaceId: workspace.id, path: file.path, readOnly,
        onStatus: liveStatus => updateTab(file.path, {liveStatus}),
      }),
      views.load(file.path),
    ])
      .then(([live]) => {
        // A tab closed while it opened takes its document with it.
        if (!tabsRef.current.some(tab => tab.path === file.path)) {
          live.close();
          return;
        }
        updateTab(file.path, {live, opened: live.text.toString(), loading: false});
      })
      .catch(error => updateTab(file.path, {loading: false, error: isOffline(error)
        ? `${basename(file.path)} is not kept on this computer, and the server cannot be reached.`
        : error.message}));
  }, [readOnly, workspace.id, views]);

  // A `preview` tab, as VS Code's, shows a file until another is previewed in
  // its place; opening it otherwise, editing it or double-clicking its tab keeps it.
  const open = useCallback((file, {preview = false, group = currentRef.current, at = null} = {}) => {
    setRecent(current => [file.path, ...current.filter(path => path !== file.path)].slice(0, RECENT_LIMIT));
    if (at) setGoto({path: file.path, ...at});
    const shown = groupsRef.current[group]?.paths ?? [];
    const elsewhere = path => groupsRef.current.some((item, index) => index !== group && item.paths.includes(path));
    const replaced = preview && !shown.includes(file.path)
      ? tabsRef.current.find(tab => tab.preview && !unsaved(tab) && shown.includes(tab.path))
      : null;
    setCurrentGroup(group);
    setGroups(all => showIn(all, group, file.path, {replacing: replaced?.path}));
    if (replaced && !elsewhere(replaced.path)) {
      replaced.live?.close();
      views.close(replaced.path);
      setTabs(current => current.filter(tab => tab.path !== replaced.path));
    }
    const existing = tabsRef.current.find(tab => tab.path === file.path);
    if (existing) {
      if (!preview && existing.preview) updateTab(file.path, {preview: false});
      return;
    }
    const add = tab => setTabs(current => [...current, {...tab, preview}]);
    if (MARKDOWN.test(file.path) && scopeRef.current) {
      openLive(file, add);
      return;
    }
    const kind = kindOf(file);
    add({path: file.path, kind, loading: kind === 'text', text: '', saved: ''});
    if (kind !== 'text') return;
    (async () => {
      const replica = fsReplica();
      const current = scopeRef.current;
      const [kept] = await Promise.all([current ? replica.read(current, file.path) : null, views.load(file.path)]);
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
  }, [openLive, refreshHeld, views]);

  // The members' names, for whose home a folder others shared from is (tree.js treeIndex).
  const [names, setNames] = useState(null);
  useEffect(() => {
    api.listMembers()
      .then(members => setNames(new Map(members.map(member => [member.id, member.name || member.email]))))
      .catch(error => toast.error(error.message));
  }, [workspace.id]);
  const home = useMemo(() => (userId && names ? {userId, names} : null), [userId, names]);

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

  // Keep the replica in step with the server.
  useEffect(() => {
    if (!scope) return undefined;
    const onSync = ({detail}) => {
      if (detail.scope.workspaceId !== scope.workspaceId || detail.scope.userId !== scope.userId) return;
      if (detail.uploaded) {
        updateTab(detail.path, {rev: detail.rev});
        toast.success(`Uploaded your offline edit to ${basename(detail.path)}.`);
      } else if (detail.conflictedCopy) {
        toast.warning(`${detail.path} changed while you were offline, so your edit was saved as ${detail.conflictedCopy}.`, {
          duration: 0, actionLabel: 'Compare', action: () => compareCopy(detail.path, detail.conflictedCopy),
        });
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
      open(file);
    });
    // Only on arrival: later listings must not reopen the file the URL first named.
  }, [load]);

  // The active file is revealed in the tree, selected, as VS Code's explorer.autoReveal
  // does: once each time another becomes active, as soon as the listing has it.
  const revealed = useRef(null);
  useEffect(() => {
    if (revealed.current === activePath || nodes.get(activePath)?.type !== 'file') return;
    revealed.current = activePath;
    expandTo(dirname(activePath));
    selectOnly(activePath);
    setReveal({path: activePath});
  }, [activePath, nodes]);

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
        updateTab(path, {saving: false, saved: text, rev: entry.rev, conflict: false});
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
        if (error.code !== 'stale-revision') {
          toast.error(error.message);
          return;
        }
        // Saved elsewhere since it was read: the tab now compares the user's
        // text with that save, to merge change by change and save over it.
        try {
          const fresh = await api.readFile(path);
          if (fresh.binary) throw new Error(`${path} is no longer text`);
          setTabs(current => current.map(item => (item.path === path
            ? {...item, saved: fresh.text, rev: fresh.rev, conflict: item.text !== fresh.text, changedElsewhere: false}
            : item)));
        } catch (readError) {
          toast.error(`${basename(path)} was changed elsewhere, and that change could not be read: ${readError.message}`);
        }
      });
  };

  const readText = async path => {
    const result = await api.readFile(path);
    if (result.binary) throw new Error(`${path} is not text, so it cannot be compared`);
    return result;
  };

  // A compare tab at `path` (tree.js comparePath), whose texts `read` resolves.
  const compare = (path, title, read) => {
    setActivePath(path);
    if (tabsRef.current.some(tab => tab.path === path)) return;
    setTabs(current => [...current, {path, kind: 'diff', title, loading: true}]);
    read()
      .then(texts => updateTab(path, {...texts, loading: false}))
      .catch(error => updateTab(path, {loading: false, error: error.message}));
  };

  // The file now against its revision `seq`, the `number`th of its content.
  const compareRevision = (file, seq, number) => compare(comparePath(file, seq), `${basename(file)} ↔ revision ${number}`, async () => {
    const [original, current] = await Promise.all([api.readRevision(file, seq), readText(file)]);
    return {original, text: current.text, rev: current.rev, restorable: true};
  });

  // A conflicted copy against the file it was made from, which kept the path.
  const compareCopy = (file, copy) => compare(comparePath(copy, 'original'), `${basename(copy)} ↔ ${basename(file)}`, async () => {
    const [theirs, yours] = await Promise.all([readText(file), readText(copy)]);
    return {original: theirs.text, text: yours.text};
  });

  // The revisions to compare with, as a menu where the context menu was.
  const chooseRevision = async (node, position) => {
    let revisions;
    try {
      revisions = await api.history(node.path);
    } catch (error) {
      toast.error(error.message);
      return;
    }
    // The newest revision is the file as it is now.
    if (revisions.length < 2) {
      toast.info(`${node.path} has no earlier revisions.`);
      return;
    }
    setMenu({...position, items: revisions.slice(1).map((revision, index) => {
      const number = revisions.length - 1 - index;
      return {label: `Revision ${number}, ${new Date(revision.at).toLocaleString()}`, run: () => compareRevision(node.path, revision.seq, number)};
    })});
  };

  // The compared revision is written back over the file as it was when compared.
  const restoreRevision = path => {
    const tab = tabsRef.current.find(item => item.path === path);
    const file = dirname(path);
    run(() => api.saveFile(file, tab.original, {baseRev: tab.rev}), () => {
      close(path);
      toast.success(`Restored ${file} to that revision`);
    });
  };

  // Close `path` in `group`; its tab's state goes with the last group showing it.
  // `discard` closes a tab with unsaved edits without asking.
  const close = async (path, {discard = false, group = currentRef.current} = {}) => {
    if (groupsRef.current.some((item, index) => index !== group && item.paths.includes(path))) {
      setGroups(all => closeIn(all, group, path));
      return true;
    }
    const tab = tabsRef.current.find(item => item.path === path);
    if (!discard && tab && unsaved(tab) && !(await clientPlatform.dialogs.confirm(`Discard unsaved changes to ${basename(path)}?`))) return false;
    tab?.live?.close();
    views.close(path);
    setTabs(current => current.filter(item => item.path !== path));
    setGroups(all => closeIn(all, group, path));
    return true;
  };
  // Several tabs of `group`, one after another, each asking about its unsaved changes.
  const closeAll = async (group, paths) => {
    for (const path of paths) if (!(await close(path, {group}))) return;
  };

  // Renames and moves, `[from, to]` in order, carry open tabs, the selection, open folders and recent files along.
  const followMoves = moves => {
    const moved = path => moves.reduce((current, [from, to]) => movedPath(current, from, to), path);
    // A live document is bound to its path, so a moved one is opened again there.
    const reopen = tabsRef.current.filter(tab => tab.kind === 'live' && moved(tab.path) !== tab.path);
    for (const tab of reopen) tab.live?.close();
    views.move(moved).catch(error => console.error('[workspace] Could not move where the renamed tabs were left:', error));
    setTabs(current => current
      .filter(tab => !reopen.includes(tab))
      .map(tab => ({...tab, path: moved(tab.path)})));
    for (const tab of reopen) openLive({path: moved(tab.path)});
    setGroups(all => moveAll(all, moved));
    setGoto(current => current && {...current, path: moved(current.path)});
    setSelection(current => current.map(moved));
    setFocused(current => current && moved(current));
    setClipboard(current => current && {...current, paths: current.paths.map(moved)});
    setExpanded(current => new Set([...current].map(moved)));
    setRecent(current => current.map(moved));
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
      views.close(path);
      // A moved live tab was closed and is opening again; it closes itself once it finds its tab gone.
      if (path === tab.path) tab.live?.close();
    }
    if (closing.length) {
      setTabs(current => current.filter(tab => !closing.includes(tab.path)));
      setGroups(all => dropPaths(all, path => closing.includes(path)));
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

  /** Keep `entry` for ⌘Z: `undo` takes the operation back, then `after` runs once the listing is fresh. */
  const pushUndo = entry => { undoStack.current = [...undoStack.current, entry].slice(-UNDO_LIMIT); };
  const undo = () => {
    const entry = undoStack.current.pop();
    if (!entry) {
      toast.info('Nothing to undo');
      return;
    }
    run(entry.undo, () => {
      entry.after?.();
      toast.success(`Undid ${entry.label}`);
    });
  };
  const several = (paths, verb) => (paths.length === 1 ? `${verb} ${basename(paths[0])}` : `${verb} ${paths.length} items`);

  // Moves `paths` into `folder`, skipping any already there or that would go inside themselves.
  const move = (paths, folder) => {
    const moves = paths
      .filter(from => dirname(from) !== folder && !within(folder, from))
      .map(from => [from, join(folder, basename(from))]);
    if (!moves.length) return;
    const back = [...moves].reverse().map(([from, to]) => [to, from]);
    run(async () => { for (const [from, to] of moves) await api.moveEntry(from, to); }, () => {
      followMoves(moves);
      expandTo(folder);
      setSelection(moves.map(([, to]) => to));
      pushUndo({
        label: several(moves.map(([from]) => from), 'moving'),
        undo: async () => { for (const [from, to] of back) await api.moveEntry(from, to); },
        after: () => followMoves(back),
      });
    });
  };

  const remove = async paths => {
    const doomed = topmost(paths).map(path => nodes.get(path)).filter(Boolean);
    if (!doomed.length) return;
    const lost = [...dirtyPaths].filter(path => doomed.some(node => within(path, node.path)));
    const warning = lost.length ? `\n\nUnsaved changes in ${lost.map(basename).join(', ')} will be lost.` : '';
    const what = doomed.length > 1
      ? `these ${doomed.length} items`
      : doomed[0].type === 'folder' ? `the folder ${doomed[0].path} and everything in it` : doomed[0].path;
    if (!(await clientPlatform.dialogs.confirm(`Delete ${what}?${warning}\n\nIt goes to the Trash; ⌘Z brings it back.`))) return;
    const removed = [];
    const gone = path => doomed.some(node => within(path, node.path));
    run(async () => { for (const node of doomed) removed.push((await api.deleteFile(node.path)).node); }, () => {
      const remaining = tabsRef.current.filter(tab => !gone(tab.path));
      for (const tab of tabsRef.current) {
        if (!gone(tab.path)) continue;
        tab.live?.close();
        views.close(tab.path);
      }
      setTabs(remaining);
      setGroups(all => dropPaths(all, gone));
      setSelection([]);
      pushUndo({
        label: several(doomed.map(node => node.path), 'deleting'),
        undo: async () => { for (const node of removed) await api.restore(node.id); },
      });
    });
  };

  // Names taken in `folder`, for copies' names.
  const namesIn = folder => new Set((folder ? nodes.get(folder)?.children ?? [] : tree.children).map(child => child.name));

  /** Copy `node` to `to`: a file's bytes, or a folder with everything in it. */
  const copyEntry = async (node, to) => {
    if (node.type === 'file') {
      await api.writeBytes(to, await api.readBytes(node.path), {create: true});
      return;
    }
    await api.makeFolder(to);
    for (const folder of listing.folders) {
      if (folder.path !== node.path && within(folder.path, node.path)) await api.makeFolder(movedPath(folder.path, node.path, to));
    }
    for (const file of listing.files) {
      if (within(file.path, node.path)) await api.writeBytes(movedPath(file.path, node.path, to), await api.readBytes(file.path), {create: true});
    }
  };

  // Copies of `paths` in `folder`, each under its own name where that is free, else as VS Code names a copy.
  const copyInto = (paths, folder) => {
    const sources = topmost(paths).map(path => nodes.get(path)).filter(Boolean);
    if (sources.some(node => node.type === 'folder' && within(folder, node.path))) {
      toast.error('A folder cannot be copied into itself');
      return;
    }
    const taken = namesIn(folder);
    const created = [];
    run(async () => {
      for (const node of sources) {
        const name = taken.has(node.name) ? copyName(node.name, taken, {folder: node.type === 'folder'}) : node.name;
        taken.add(name);
        await copyEntry(node, join(folder, name));
        created.push(join(folder, name));
      }
    }, () => {
      expandTo(folder);
      setSelection(created);
      setFocused(created[0] ?? null);
      pushUndo({
        label: several(created, 'copying'),
        undo: async () => { for (const path of created) await api.deleteFile(path); },
      });
    });
  };

  const paste = folder => {
    if (!clipboard) return;
    if (clipboard.mode === 'cut') {
      move(clipboard.paths, folder);
      setClipboard(null);
    } else copyInto(clipboard.paths, folder);
  };

  // Files and folders from this computer into `folder`; a file already there is replaced only when the member agrees.
  const upload = async (entries, folder) => {
    const {folders, files} = await uploadsOf(entries);
    const tooLarge = files.filter(([, file]) => file.size > UPLOAD_LIMIT);
    if (tooLarge.length) toast.error(`Too large to upload (over 10 MB): ${tooLarge.map(([path]) => path).join(', ')}`);
    const wanted = files.filter(([, file]) => file.size <= UPLOAD_LIMIT).map(([path, file]) => [join(folder, path), file]);
    if (!wanted.length && !folders.length) return;
    const existing = wanted.filter(([path]) => nodes.has(path)).map(([path]) => path);
    const replace = existing.length > 0 && await clientPlatform.dialogs.confirm(existing.length === 1
      ? `${existing[0]} already exists. Replace it?`
      : `${existing.length} of these files already exist:\n\n${existing.join('\n')}\n\nReplace them?`);
    const created = [];
    run(async () => {
      for (const path of folders.map(name => join(folder, name))) {
        if (nodes.has(path)) continue;
        await api.makeFolder(path);
        created.push(path);
      }
      for (const [path, file] of wanted) {
        if (nodes.has(path) && !replace) continue;
        await api.writeBytes(path, file, {create: !nodes.has(path)});
        if (!nodes.has(path)) created.push(path);
      }
    }, () => {
      expandTo(folder);
      const count = wanted.filter(([path]) => replace || !nodes.has(path)).length;
      toast.success(`Uploaded ${count} ${count === 1 ? 'file' : 'files'}`);
      if (created.length) {
        pushUndo({
          label: several(topmost(created), 'uploading'),
          undo: async () => { for (const path of topmost(created)) await api.deleteFile(path); },
        });
      }
    });
  };
  const chooseUpload = folder => {
    uploadTarget.current = folder;
    uploadInput.current.click();
  };

  // Where a new entry goes: the selected folder, else the selected file's folder, else the root.
  const targetFolder = () => (focusedNode?.type === 'folder' ? focusedNode.path : focusedNode ? dirname(focusedNode.path) : '');

  const startCreate = (mode, parent = targetFolder()) => {
    expandTo(parent);
    setEditing({mode, parent, status: 'naming'});
  };

  // The input stays open, pending, until the server answers; a failure keeps
  // what was typed and shows why. An answer for an edit since replaced is dropped.
  const commitEdit = async name => {
    const edit = editing;
    const pending = {...edit, status: 'pending'};
    setEditing(pending);
    const path = join(edit.mode === 'rename' ? dirname(edit.node.path) : edit.parent, name);
    let result;
    try {
      if (edit.mode === 'rename') result = await api.moveEntry(edit.node.path, path);
      else if (edit.mode === 'folder') result = await api.makeFolder(path);
      else result = await api.saveFile(path, '', {create: true});
    } catch (error) {
      setEditing(current => (current === pending ? {...edit, status: {error: error.message}} : current));
      return;
    }
    setEditing(current => (current === pending ? null : current));
    if (edit.mode === 'rename') {
      const from = edit.node.path;
      run(() => result, () => {
        followMoves([[from, path]]);
        expandTo(dirname(path));
        pushUndo({label: `renaming ${basename(from)}`, undo: () => api.moveEntry(path, from), after: () => followMoves([[path, from]])});
      });
      return;
    }
    pushUndo({label: `creating ${name}`, undo: () => api.deleteFile(path)});
    if (edit.mode === 'folder') run(() => result, () => { expandTo(path); selectOnly(path); });
    else run(() => result, entry => { expandTo(dirname(path)); selectOnly(entry.path); open(entry); });
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
    const answer = await clientPlatform.dialogs.prompt(
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
    .then(setTrash)
    .catch(error => toast.error(error.message));
  const trashed = useMemo(() => (trash ? trashRows(trash, home) : []), [trash, home]);
  const restoreNode = node => run(() => api.restore(node.id), () => { openTrash(); expandTo(dirname(node.path)); });
  const purgeTrash = async () => {
    if (!(await clientPlatform.dialogs.confirm('Permanently delete everything in the trash? This cannot be undone.'))) return;
    run(() => api.emptyTrash(), () => setTrash([]));
  };

  // The context menu: groups of actions for what was right-clicked (a file, a
  // folder, several selected entries, or the empty explorer), separated as VS
  // Code separates them.
  const showMenu = (event, node) => {
    event.preventDefault();
    const position = {x: event.clientX, y: event.clientY};
    const file = node?.type === 'file';
    const many = node && selection.includes(node.path) && selection.length > 1 ? topmost(selection) : null;
    const into = file ? dirname(node.path) : node?.path ?? '';
    const pasteItem = clipboard && !readOnly ? [{label: 'Paste', shortcut: '⌘V', run: () => paste(into)}] : [];
    if (many) {
      const files = many.filter(path => nodes.get(path)?.type === 'file');
      const groups = [
        readOnly ? [] : [
          {label: 'Cut', shortcut: '⌘X', run: () => setClipboard({mode: 'cut', paths: many})},
          {label: 'Copy', shortcut: '⌘C', run: () => setClipboard({mode: 'copy', paths: many})},
          ...pasteItem,
        ],
        files.length === many.length ? [{label: `Download ${files.length} Files`, run: () => {
          for (const path of files) window.open(api.fileUrl(workspace.id, path, {download: true}), '_blank');
        }}] : [],
        [{label: 'Copy Paths', run: () => copyPath(many.join('\n'))}],
        readOnly ? [] : [{label: `Delete ${many.length} Items`, shortcut: '⌫', danger: true, run: () => remove(many)}],
      ].filter(group => group.length);
      setMenu({...position, items: groups.flatMap((group, index) => (index ? ['separator', ...group] : group))});
      return;
    }
    const groups = [
      file ? [
        {label: 'Open', run: () => open(node)},
        {label: 'Open to the Side', shortcut: '⌘\\', run: () => openToSide(node.path)},
        ...(appLink(node.path) ? [{label: `Open in ${appLink(node.path).title}`, run: () => navigateClient(appLink(node.path).href)}] : []),
        {label: 'Download', run: () => window.open(api.fileUrl(workspace.id, node.path, {download: true}), '_self')},
        ...(scope && kindOf(node) === 'text' ? [{
          label: held.get(node.path)?.pinned ? '✓ Kept on this computer' : 'Keep on this computer',
          run: () => togglePinned(node),
        }] : []),
        ...(kindOf(node) === 'text' ? [{label: 'Compare with Revision…', run: () => chooseRevision(node, position)}] : []),
      ] : [],
      !readOnly && !file ? [
        {label: 'New File…', run: () => startCreate('file', node?.path ?? '')},
        {label: 'New Folder…', run: () => startCreate('folder', node?.path ?? '')},
        {label: 'Upload Files…', run: () => chooseUpload(node?.path ?? '')},
      ] : [],
      node && !readOnly ? [
        {label: 'Cut', shortcut: '⌘X', run: () => setClipboard({mode: 'cut', paths: [node.path]})},
        {label: 'Copy', shortcut: '⌘C', run: () => setClipboard({mode: 'copy', paths: [node.path]})},
        ...pasteItem,
        {label: 'Duplicate', run: () => copyInto([node.path], dirname(node.path))},
      ] : pasteItem,
      node ? [{label: 'Copy Path', run: () => copyPath(node.path)}] : [{label: 'Refresh', run: load}],
      node && !readOnly ? Object.entries(ACCESS_LABELS).map(([access, label]) => ({
        label: `${node.access === access ? '✓ ' : ''}Visible to: ${label}`,
        run: () => share(node, access),
      })).concat(
        [{label: `${node.access === 'shared' ? '✓ ' : ''}Visible to: specific people…`, run: () => shareWithPeople(node)}],
        node.accessExplicit ? [{label: 'Visible to: same as its folder', run: () => share(node, null)}] : [],
      ) : [],
      node && !readOnly ? [
        {label: 'Rename…', shortcut: 'F2', run: () => setEditing({mode: 'rename', node, status: 'naming'})},
        {label: 'Delete', shortcut: '⌫', danger: true, run: () => remove([node.path])},
      ] : [],
      !node ? [
        ...(undoStack.current.length && !readOnly ? [{label: `Undo ${undoStack.current.at(-1).label}`, shortcut: '⌘Z', run: undo}] : []),
        {label: 'Show Trash', run: openTrash},
      ] : [],
    ].filter(group => group.length);
    const items = groups.flatMap((group, index) => (index ? ['separator', ...group] : group));
    setMenu({...position, items});
  };
  const closeMenu = useCallback(() => setMenu(null), []);

  // `path` in the group beside the current one, a new group when the current is the last.
  const openToSide = path => {
    const file = nodes.get(path);
    if (file?.type === 'file') open(file, {group: currentRef.current + 1});
  };

  // A breadcrumb's folder or file shown in the tree, its folders opened, the side bar shown.
  const revealPath = path => {
    shell?.setOpen(true);
    expandTo(nodes.get(path)?.type === 'folder' ? path : dirname(path));
    selectOnly(path);
    setReveal({path});
  };

  // A tab's context menu, as VS Code's: closing it and the tabs around it, keeping it, and where it is.
  const showTabMenu = (event, group, path) => {
    event.preventDefault();
    const paths = groupsRef.current[group].paths;
    const tab = tabsRef.current.find(item => item.path === path);
    const file = nodes.get(path)?.type === 'file';
    const after = paths.slice(paths.indexOf(path) + 1);
    const items = [
      {label: 'Close', run: () => close(path, {group})},
      {label: 'Close Others', run: () => closeAll(group, paths.filter(item => item !== path))},
      ...(after.length ? [{label: 'Close to the Right', run: () => closeAll(group, after)}] : []),
      {label: 'Close Saved', run: () => closeAll(group, paths.filter(item => !unsaved(tabsRef.current.find(other => other.path === item) ?? {})))},
      {label: 'Close All', run: () => closeAll(group, paths)},
      'separator',
      ...(tab?.preview ? [{label: 'Keep Open', run: () => updateTab(path, {preview: false})}] : []),
      ...(file ? [{label: 'Split Right', shortcut: '⌘\\', run: () => open(nodes.get(path), {group: group + 1})}] : []),
      ...(file || tab?.preview ? ['separator'] : []),
      {label: 'Copy Path', run: () => copyPath(file ? path : dirname(path))},
      ...(file ? [{label: 'Reveal in Explorer', run: () => revealPath(path)}] : []),
    ];
    setMenu({x: event.clientX, y: event.clientY, items});
  };

  return (
    <div className={styles.workbench}>
      <aside className={styles.explorer}>
        {shell && <Sash />}
        <div className={clsx(styles.explorerHeader, shell && styles.sectionHeader)}>
          <span className={styles.explorerTitle}>{shell?.title ?? 'Files'}</span>
        </div>
        <div className={styles.explorerToolbar}>
          <span className={styles.fileCount}>
            {sideView === 'search' ? 'Search' : listing && `${listing.files.length} ${listing.files.length === 1 ? 'file' : 'files'}`}
          </span>
          <div className={styles.explorerActions}>
            <button
              type="button"
              title={sideView === 'search' ? 'Show the files' : 'Search in files (⌘⇧F)'}
              aria-label="Search in files"
              aria-pressed={sideView === 'search'}
              onClick={() => {
                setSideView(view => (view === 'search' ? 'files' : 'search'));
                setSearchFocus(count => count + 1);
              }}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M7 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM10.75 10.75 14 14" /></svg>
            </button>
            {sideView === 'files' && (
              <>
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
            <button
              type="button"
              title="Trash"
              aria-label="Trash"
              aria-pressed={Boolean(trash)}
              onClick={() => (trash ? setTrash(null) : openTrash())}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.75 9h5.5l.75-9" /></svg>
            </button>
            </>
            )}
          </div>
        </div>
        <div className={styles.sideView} hidden={sideView !== 'search'}>
          <Search
            focusKey={sideView === 'search' ? searchFocus : 0}
            readOnly={readOnly}
            dirtyPaths={dirtyPaths}
            onOpen={(path, at) => {
              const file = nodes.get(path);
              if (file?.type === 'file') open(file, {at});
            }}
            onReplaced={(changed, label) => pushUndo({
              label,
              undo: async () => { for (const file of changed) await api.saveFile(file.path, file.before, {baseRev: file.rev}); },
            })}
          />
        </div>
        <div className={styles.sideView} hidden={sideView !== 'files'}>
          <button type="button" className={styles.searchButton} onClick={() => setQuickOpen(true)}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M7 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM10.75 10.75 14 14" /></svg>
            <span>Search files</span>
            <kbd>⌘P</kbd>
          </button>
          <input
            ref={uploadInput}
            type="file"
            multiple
            hidden
            onChange={event => {
              upload([...event.target.files], uploadTarget.current);
              event.target.value = '';
            }}
          />
          {offline && <p className={styles.offlineNote}>Offline: showing the files kept on this computer.</p>}
          {loadError && <p className={styles.loadError}>{loadError}</p>}
          {tree && (
            <Explorer
              tree={tree}
              home={home}
              expanded={expanded}
              selection={selection}
              focused={focused}
              reveal={reveal}
              activePath={activePath}
              dirtyPaths={dirtyPaths}
              held={held}
              cut={new Set(clipboard?.mode === 'cut' ? clipboard.paths : [])}
              editing={editing}
              readOnly={readOnly}
              onExpanded={setExpanded}
              onSelection={setSelection}
              onFocused={setFocused}
              onOpen={open}
              onCommitEdit={commitEdit}
              onCancelEdit={() => setEditing(null)}
              onRetypeEdit={() => setEditing(current => ({...current, status: 'naming'}))}
              onContextMenu={showMenu}
              onMove={move}
              onUpload={upload}
              onRename={node => setEditing({mode: 'rename', node, status: 'naming'})}
              onDelete={remove}
              onCopy={paths => setClipboard({mode: 'copy', paths})}
              onCut={paths => setClipboard({mode: 'cut', paths})}
              onPaste={paste}
              onUndo={undo}
            />
          )}
          {trash && (
            <div className={styles.trash}>
              <div className={styles.explorerHeader}>
                <span className={styles.explorerTitle}>
                  Trash
                  {trashed.length > 0 && <span className={styles.explorerCount}>{trashed.length}</span>}
                </span>
                {!readOnly && trash.length > 0 && workspace.role === 'owner' && (
                  <button type="button" className={clsx(styles.textButton, styles.textButtonDanger)} onClick={purgeTrash}>Empty</button>
                )}
              </div>
              {trashed.length === 0 && <p className={styles.trashNote}>The trash is empty.</p>}
              <div className={styles.trashList}>
                {trashed.map(({node, name, where, count}) => (
                  <div key={node.id} className={styles.trashRow} title={node.path}>
                    <span className={styles.trashText}>
                      <span className={styles.trashName}>{name}{node.kind === 'folder' ? '/' : ''}</span>
                      <span className={styles.trashWhere}>
                        {where || 'The workspace'}{count > 1 ? ` · ${count} deleted here; Restore brings back the newest` : ''}
                      </span>
                    </span>
                    {!readOnly && <button type="button" className={styles.textButton} onClick={() => restoreNode(node)}>Restore</button>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </aside>
      <section className={styles.editorArea}>
        {groups.map((group, index) => (
          <div
            key={group.id}
            className={clsx(styles.editorGroup, groups.length > 1 && index === current && styles.editorGroupCurrent)}
            onPointerDown={() => setCurrentGroup(index)}
          >
            <Editor
              group={index}
              tabs={group.paths.map(path => tabs.find(tab => tab.path === path)).filter(Boolean)}
              activePath={group.active}
              readOnly={readOnly}
              fileUrl={(path, options) => api.fileUrl(workspace.id, path, options)}
              appLink={appLink}
              viewOf={views.get}
              goto={goto}
              onGone={() => setGoto(null)}
              onActivate={path => {
                setCurrentGroup(index);
                setGroups(all => showIn(all, index, path));
              }}
              onPin={path => updateTab(path, {preview: false})}
              onClose={path => close(path, {group: index})}
              onTabMenu={(event, path) => showTabMenu(event, index, path)}
              onMoveTab={(from, path, before) => {
                setCurrentGroup(index);
                setGroups(all => moveTab(all, from, path, index, before));
              }}
              onReveal={revealPath}
              onSave={save}
              onSaveAsNew={saveAsNew}
              onRestore={restoreRevision}
              onDiscard={path => close(path, {discard: true, group: index})}
              onChange={(path, text) => updateTab(path, {text, preview: false})}
              onView={views.set}
            />
          </div>
        ))}
      </section>
      {menu && <ContextMenu menu={menu} onClose={closeMenu} />}
      {quickOpen && listing && (
        <QuickOpen
          files={listing.files}
          recent={recent}
          onPick={file => {
            setQuickOpen(false);
            open(file);
          }}
          onClose={() => setQuickOpen(false)}
        />
      )}
    </div>
  );
}
