import React, { useCallback, useEffect, useState } from 'react';
import Layout from '@theme/Layout';
import BrowserOnly from '@docusaurus/BrowserOnly';
import Link from '@docusaurus/Link';
import {useLocation} from '@docusaurus/router';
import ErrorBoundary from '@site/src/components/ErrorBoundary';
import useWorkspaceSite from '@site/src/hooks/useWorkspaceSite';
import useWorkspaceSubscriptions, {
  isBookSubscribed, isGroupSubscribed, orderByPreference,
} from '@site/src/hooks/useWorkspaceSubscriptions';
import pageStyles from '@site/src/css/page.module.css';
import API_BASE, {apiJson} from '@site/src/utils/api';
import {WORKSPACE_CONTENT_CACHE_MS} from '@site/src/utils/workspaceContent';
import {
  loadWorkspaces, switchWorkspace, createWorkspace, workspaceSlugFromPath,
} from '@site/src/utils/workspaces';
import styles from './styles.module.css';

function SettingsApp() {
  const { authClient } = require('@site/src/utils/authClient');
  const location = useLocation();
  const workspaceSlug = workspaceSlugFromPath(location.pathname);

  // undefined is loading, null is a confirmed signed-out development session.
  const [session, setSession] = useState(undefined);
  // undefined until the request answers, then the list, or null if it failed.
  // Three states rather than two, so a slow load does not read as a failed one.
  const [workspaces, setWorkspaces] = useState(undefined);
  const [activeId, setActiveId] = useState(null);
  const [newWorkspace, setNewWorkspace] = useState('');
  const [switching, setSwitching] = useState(false);
  const [workspaceError, setWorkspaceError] = useState(null);
  const [subscriptionGroups, setSubscriptionGroups] = useState({});
  const [subscriptionsLoading, setSubscriptionsLoading] = useState(false);
  const [subscriptionsSaving, setSubscriptionsSaving] = useState(false);
  const [subscriptionsStatus, setSubscriptionsStatus] = useState(null);
  const activeWorkspace = Array.isArray(workspaces)
    ? workspaces.find(workspace => workspace.id === activeId)
    : null;
  const {workspace: routeWorkspace, site} = useWorkspaceSite();
  const preferenceWorkspace = routeWorkspace?.id === activeId ? routeWorkspace : activeWorkspace;
  const {
    subscriptions, loading: preferencesLoading, error: preferencesError, saveSubscriptions,
  } = useWorkspaceSubscriptions(preferenceWorkspace);
  const books = (site?.collections ?? []).filter(collection => collection.type === 'docs');
  const blogs = (site?.collections ?? []).filter(collection => collection.type === 'blog');
  const orderedBooks = orderByPreference(books, subscriptions?.bookOrder, book => book.key);

  useEffect(() => {
    let cancelled = false;
    // getSession rather than the useSession hook: the hook silently never
    // issued its request, which is what left the auth gate showing the sign-in
    // form to people who were signed in.
    authClient.getSession()
      .then((r) => { if (!cancelled) setSession(r?.data ?? null); })
      .catch(() => { if (!cancelled) setSession(null); });

    loadWorkspaces()
      .then((d) => {
        if (cancelled) return;
        const memberships = d.workspaces || d.memberships || [];
        setWorkspaces(memberships);
        setActiveId(memberships.find(workspace => workspace.slug === workspaceSlug)?.id
          ?? d.defaultWorkspaceId ?? d.activeId ?? null);
      })
      .catch(() => { if (!cancelled) setWorkspaces(null); });

    return () => { cancelled = true; };
  }, [authClient, workspaceSlug]);

  useEffect(() => {
    let cancelled = false;
    if (!preferenceWorkspace?.id || !site) {
      setSubscriptionGroups({});
      return () => { cancelled = true; };
    }
    const blogCollections = site.collections.filter(collection => collection.type === 'blog');
    setSubscriptionsLoading(blogCollections.length > 0);
    Promise.all(blogCollections.map(async collection => {
      const configured = (collection.groups ?? []).map(group => group.title);
      const result = await apiJson(
        `${API_BASE}/api/workspaces/${encodeURIComponent(preferenceWorkspace.id)}/documents/tree?prefix=${encodeURIComponent(collection.pathPrefix)}&include=metadata`,
        {cacheMs: WORKSPACE_CONTENT_CACHE_MS},
      );
      const derived = result.ok
        ? (result.data.documents ?? [])
          .map(document => document.frontmatter?.group?.trim() || 'Ungrouped')
        : [];
      const seen = new Set();
      const titles = [...configured, ...derived.sort((a, b) => a.localeCompare(b))]
        .filter(title => {
          const identity = title.toLocaleLowerCase();
          if (seen.has(identity)) return false;
          seen.add(identity);
          return true;
        });
      return [collection.key, titles];
    }))
      .then(entries => {
        if (!cancelled) setSubscriptionGroups(Object.fromEntries(entries));
      })
      .catch(error => {
        if (!cancelled) setSubscriptionsStatus({type: 'error', message: error.message});
      })
      .finally(() => {
        if (!cancelled) setSubscriptionsLoading(false);
      });
    return () => { cancelled = true; };
  }, [preferenceWorkspace?.id, site]);

  const saveSubscriptionChoice = useCallback(async next => {
    setSubscriptionsSaving(true);
    setSubscriptionsStatus(null);
    try {
      await saveSubscriptions(next);
      setSubscriptionsStatus({type: 'success', message: 'Saved'});
    } catch (error) {
      setSubscriptionsStatus({type: 'error', message: error.message});
    } finally {
      setSubscriptionsSaving(false);
    }
  }, [saveSubscriptions]);

  const toggleBookSubscription = key => {
    const selected = orderedBooks
      .filter(book => isBookSubscribed(subscriptions, book.key))
      .map(book => book.key);
    const nextBooks = selected.includes(key)
      ? selected.filter(item => item !== key)
      : [...selected, key];
    void saveSubscriptionChoice({...subscriptions, books: nextBooks});
  };

  const toggleGroupSubscription = (collectionKey, title) => {
    const available = orderByPreference(
      subscriptionGroups[collectionKey] ?? [],
      subscriptions?.groupOrder?.[collectionKey],
    );
    const selected = available.filter(group => isGroupSubscribed(subscriptions, collectionKey, group));
    const nextGroups = selected.includes(title)
      ? selected.filter(group => group !== title)
      : [...selected, title];
    void saveSubscriptionChoice({
      ...subscriptions,
      groups: {...subscriptions?.groups, [collectionKey]: nextGroups},
    });
  };

  const moveItem = (items, sourceIndex, direction) => {
    const targetIndex = sourceIndex + direction;
    if (sourceIndex < 0 || targetIndex < 0 || targetIndex >= items.length) return null;
    const next = [...items];
    const [moved] = next.splice(sourceIndex, 1);
    next.splice(targetIndex, 0, moved);
    return next;
  };

  const reorderBooks = (index, direction) => {
    const nextOrder = moveItem(orderedBooks.map(book => book.key), index, direction);
    if (nextOrder) void saveSubscriptionChoice({...subscriptions, bookOrder: nextOrder});
  };

  const reorderGroups = (collectionKey, index, direction) => {
    const orderedGroups = orderByPreference(
      subscriptionGroups[collectionKey] ?? [],
      subscriptions?.groupOrder?.[collectionKey],
    );
    const nextOrder = moveItem(orderedGroups, index, direction);
    if (!nextOrder) return;
    void saveSubscriptionChoice({
      ...subscriptions,
      groupOrder: {...subscriptions?.groupOrder, [collectionKey]: nextOrder},
    });
  };

  /**
   * Run one of the workspace writes. Both reload the page on success, from
   * within src/utils/workspaces, so there is nothing to do here but report a
   * refusal and hand the buttons back.
   */
  const workspaceAction = useCallback(async (write) => {
    setSwitching(true);
    setWorkspaceError(null);
    try {
      await write();
    } catch (err) {
      setWorkspaceError(err.message);
      setSwitching(false);
    }
  }, []);

  const user = session?.user;
  return (
    <div className={`${pageStyles.pageContainer} ${pageStyles.wide}`}>
      <header className={styles.pageHeader}>
        <span className={styles.eyebrow}>Settings</span>
        <div className={styles.headerRow}>
          <div>
            <h1 className={styles.heading}>Settings</h1>
            <p>Manage your account and workspace access.</p>
          </div>
          {activeWorkspace && (
            <div className={styles.workspaceContext}>
              <span className={styles.workspaceMark} aria-hidden="true">
                {activeWorkspace.name.trim().charAt(0).toUpperCase() || 'W'}
              </span>
              <span>
                <strong>{activeWorkspace.name}</strong>
                <small>{activeWorkspace.role}</small>
              </span>
            </div>
          )}
        </div>
      </header>

      <div className={styles.settingsLayout}>
        <nav className={styles.settingsNav} aria-label="Settings sections">
          <a href="#account"><strong>Account</strong><span>Identity and session</span></a>
          <a href="#subscriptions"><strong>Subscriptions</strong><span>Books and blog groups</span></a>
          <a href="#workspaces"><strong>Workspaces</strong><span>Access and switching</span></a>
        </nav>

        <div className={styles.settingsContent}>
          <section id="account" className={styles.section}>
            <div className={styles.sectionHeading}>
              <div><h2>Account</h2><p>Your personal identity and session.</p></div>
            </div>
            {session === undefined ? (
              <p className={styles.muted}>Loading account…</p>
            ) : user ? (
              <dl className={styles.account}>
                <dt>Email</dt><dd>{user.email}</dd>
                <dt>Name</dt><dd>{user.name || <em>Not set</em>}</dd>
              </dl>
            ) : (
              <p className={styles.muted}>Authentication is disabled; requests use the local development account.</p>
            )}
          </section>

          <section id="subscriptions" className={styles.section}>
            <div className={styles.sectionHeading}>
              <div><h2>Subscriptions</h2><p>Choose which books and blog groups appear in your navigation.</p></div>
            </div>
            {!preferenceWorkspace || !site || preferencesLoading || subscriptionsLoading ? (
              <p className={styles.muted}>Loading subscriptions…</p>
            ) : (
              <div className={styles.subscriptionColumns}>
                <div className={styles.subscriptionGroup}>
                  <h3>Books</h3>
                  {books.length ? orderedBooks.map((book, index) => (
                    <div className={styles.subscriptionOptionRow} key={book.key}>
                      <label className={styles.subscriptionOption}>
                        <input
                          type="checkbox"
                          checked={isBookSubscribed(subscriptions, book.key)}
                          disabled={subscriptionsSaving}
                          onChange={() => toggleBookSubscription(book.key)}
                        />
                        <span>{book.title}</span>
                      </label>
                      <span className={styles.orderButtons}>
                        <button
                          type="button"
                          disabled={subscriptionsSaving || index === 0}
                          aria-label={`Move ${book.title} up`}
                          title="Move up"
                          onClick={() => reorderBooks(index, -1)}
                        >↑</button>
                        <button
                          type="button"
                          disabled={subscriptionsSaving || index === orderedBooks.length - 1}
                          aria-label={`Move ${book.title} down`}
                          title="Move down"
                          onClick={() => reorderBooks(index, 1)}
                        >↓</button>
                      </span>
                    </div>
                  )) : <p className={styles.muted}>No books yet.</p>}
                </div>
                <div className={styles.subscriptionGroup}>
                  <h3>Blog groups</h3>
                  {blogs.length ? blogs.map(collection => (
                    <div className={styles.blogSubscriptions} key={collection.key}>
                      {blogs.length > 1 && <h4>{collection.title}</h4>}
                      {(subscriptionGroups[collection.key] ?? []).length
                        ? orderByPreference(
                          subscriptionGroups[collection.key],
                          subscriptions?.groupOrder?.[collection.key],
                        ).map((title, index, orderedGroups) => (
                          <div className={styles.subscriptionOptionRow} key={title}>
                            <label className={styles.subscriptionOption}>
                              <input
                                type="checkbox"
                                checked={isGroupSubscribed(subscriptions, collection.key, title)}
                                disabled={subscriptionsSaving}
                                onChange={() => toggleGroupSubscription(collection.key, title)}
                              />
                              <span>{title}</span>
                            </label>
                            <span className={styles.orderButtons}>
                              <button
                                type="button"
                                disabled={subscriptionsSaving || index === 0}
                                aria-label={`Move ${title} up`}
                                title="Move up"
                                onClick={() => reorderGroups(collection.key, index, -1)}
                              >↑</button>
                              <button
                                type="button"
                                disabled={subscriptionsSaving || index === orderedGroups.length - 1}
                                aria-label={`Move ${title} down`}
                                title="Move down"
                                onClick={() => reorderGroups(collection.key, index, 1)}
                              >↓</button>
                            </span>
                          </div>
                        ))
                        : <p className={styles.muted}>No groups yet.</p>}
                    </div>
                  )) : <p className={styles.muted}>No blog groups yet.</p>}
                </div>
              </div>
            )}
            {(preferencesError || subscriptionsStatus) && (
              <p
                className={subscriptionsStatus?.type === 'success' && !preferencesError ? styles.saved : styles.error}
                role={subscriptionsStatus?.type === 'error' || preferencesError ? 'alert' : 'status'}
              >{preferencesError || subscriptionsStatus.message}</p>
            )}
          </section>

          <section id="workspaces" className={styles.section}>
            <div className={styles.sectionTitleRow}>
              <div className={styles.sectionHeading}>
                <div><h2>Workspaces</h2><p>Switch organizations or create a new one.</p></div>
              </div>
              {activeWorkspace && <Link className={styles.textButton} to={`/w/${encodeURIComponent(activeWorkspace.slug)}/people`}>Manage people</Link>}
            </div>

            {workspaces === undefined ? <p className={styles.muted}>Loading workspaces…</p>
              : workspaces === null ? <p className={styles.error}>Could not load your workspaces.</p>
                : workspaces.length === 0 ? <p className={styles.muted}>You are not in a workspace yet. Create one or follow an invitation link.</p>
                  : (
                    <ul className={styles.workspaces}>
                      {workspaces.map((workspace) => (
                        <li key={workspace.id} className={`${styles.workspace} ${workspace.id === activeId ? styles.workspaceActive : ''}`}>
                          <span className={styles.workspaceMark} aria-hidden="true">{workspace.name.trim().charAt(0).toUpperCase() || 'W'}</span>
                          <span className={styles.workspaceIdentity}>
                            <strong>{workspace.name}</strong>
                            <em>{workspace.role} · {workspace.memberCount} {workspace.memberCount === 1 ? 'member' : 'members'}</em>
                          </span>
                          {workspace.id === activeId ? <span className={styles.currentBadge}>Current</span> : (
                            <button type="button" className={styles.secondaryButton} disabled={switching} onClick={() => workspaceAction(() => switchWorkspace(workspace))}>
                              Switch
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}

            <form className={styles.createWorkspace} onSubmit={(e) => {
              e.preventDefault();
              workspaceAction(() => createWorkspace({name: newWorkspace}));
            }}>
              <label htmlFor="new-workspace">Create workspace</label>
              <div className={styles.inlineForm}>
                <input id="new-workspace" type="text" value={newWorkspace} onChange={(e) => setNewWorkspace(e.target.value)} placeholder="Workspace name" minLength={2} maxLength={60} required />
                <button type="submit" className={styles.primaryButton} disabled={switching || newWorkspace.trim().length < 2}>Create</button>
              </div>
            </form>
            {workspaceError && <p className={styles.error} role="alert">{workspaceError}</p>}
          </section>

        </div>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  return (
    <Layout title="Settings" description="Your account and workspace access">
      <ErrorBoundary>
        <main>
          <BrowserOnly fallback={<div className={styles.placeholder}>Loading...</div>}>
            {() => <SettingsApp />}
          </BrowserOnly>
        </main>
      </ErrorBoundary>
    </Layout>
  );
}
