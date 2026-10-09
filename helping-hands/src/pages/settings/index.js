import React, { useCallback, useEffect, useState } from 'react';
import Layout from '@theme/Layout';
import BrowserOnly from '@docusaurus/BrowserOnly';
import Link from '@docusaurus/Link';
import {useLocation} from '@docusaurus/router';
import Avatar from '@site/src/components/Avatar';
import ErrorBoundary from '@site/src/components/ErrorBoundary';
import {clientPlatform} from '@site/src/platform/client';
import useWorkspaceSite from '@site/src/hooks/useWorkspaceSite';
import useWorkspaceSubscriptions, {
  isBookSubscribed, isGroupSubscribed, orderByPreference,
} from '@site/src/hooks/useWorkspaceSubscriptions';
import pageStyles from '@site/src/css/page.module.css';
import API_BASE, {apiJson} from '@site/src/utils/api';
import {WORKSPACE_CONTENT_CACHE_MS} from '@site/src/utils/workspaceContent';
import {
  loadWorkspaces, workspaceSlugFromPath,
} from '@site/src/utils/workspaces';
import {PaneHeading, Skeleton} from './_parts';
import WorkspaceControls from './_WorkspaceControls';
import DangerZone from './_DangerZone';
import styles from './styles.module.css';

/** GitHub's mark (Octicons mark-github). */
function GitHubMark() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

function SettingsApp() {
  const { authClient, signOutAndForget } = require('@site/src/utils/authClient');
  const location = useLocation();
  const workspaceSlug = workspaceSlugFromPath(location.pathname);

  // undefined is loading, null is a confirmed signed-out development session.
  const [session, setSession] = useState(undefined);
  // undefined until the request answers, then the list, or null if it failed.
  // Three states rather than two, so a slow load does not read as a failed one.
  const [workspaces, setWorkspaces] = useState(undefined);
  const [activeId, setActiveId] = useState(null);
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

  const user = session?.user;
  const [signingOut, setSigningOut] = useState(false);
  const signOut = async () => {
    setSigningOut(true);
    try {
      await signOutAndForget();
    } finally {
      clientPlatform.location.assign('/');
    }
  };
  const panes = [
    {id: 'account', group: 'account', label: 'Account'},
    {id: 'navigation', group: 'account', label: 'Navigation'},
    ...(activeWorkspace ? [{id: 'workspace', group: 'workspace', label: 'General'}] : []),
    ...(activeWorkspace ? [{id: 'danger', group: 'danger', label: 'Danger zone'}] : []),
  ];
  const [visible, setVisible] = useState(panes[0].id);
  const paneIds = panes.map(item => item.id).join(' ');
  // Highlights the section nearest the top of the viewport as the page scrolls.
  useEffect(() => {
    const sections = paneIds.split(' ').map(id => document.getElementById(id)).filter(Boolean);
    const observer = new IntersectionObserver(entries => {
      const top = entries.filter(entry => entry.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (top) setVisible(top.target.id);
    }, {rootMargin: '-20% 0px -60% 0px'});
    sections.forEach(section => observer.observe(section));
    return () => observer.disconnect();
  }, [paneIds]);
  const navItem = item => (
    <a
      key={item.id}
      href={`#${item.id}`}
      className={item.id === visible ? styles.navActive : undefined}
      aria-current={item.id === visible ? 'location' : undefined}
    >{item.label}</a>
  );
  const subscriptionsFeedback = (preferencesError || subscriptionsStatus) && (
    <span
      className={subscriptionsStatus?.type === 'success' && !preferencesError ? styles.saved : styles.error}
      role={subscriptionsStatus?.type === 'error' || preferencesError ? 'alert' : 'status'}
    >{preferencesError || subscriptionsStatus.message}</span>
  );
  const orderButtons = (title, index, count, move) => (
    <span className={styles.orderButtons}>
      <button
        type="button"
        disabled={subscriptionsSaving || index === 0}
        aria-label={`Move ${title} up`}
        title="Move up"
        onClick={() => move(index, -1)}
      >↑</button>
      <button
        type="button"
        disabled={subscriptionsSaving || index === count - 1}
        aria-label={`Move ${title} down`}
        title="Move down"
        onClick={() => move(index, 1)}
      >↓</button>
    </span>
  );

  return (
    <div className={`${pageStyles.pageContainer} ${pageStyles.wide}`}>
      <header className={styles.pageHeader}>
        <h1 className={styles.heading}>Settings</h1>
        <p>Manage your account and workspace access.</p>
      </header>

      <div className={styles.settingsLayout}>
        <nav className={styles.settingsNav} aria-label="Settings sections">
          <span className={styles.navGroup}>Account</span>
          {panes.filter(item => item.group === 'account').map(navItem)}
          <span className={styles.navGroup}>{activeWorkspace ? `Workspace · ${activeWorkspace.name}` : 'Workspace'}</span>
          {panes.filter(item => item.group === 'workspace').map(navItem)}
          <span className={styles.navDivider} />
          {panes.filter(item => item.group === 'danger').map(navItem)}
          {activeWorkspace && (
            <Link to={`/w/${encodeURIComponent(activeWorkspace.slug)}/people`}>Members ↗</Link>
          )}
        </nav>

        <div className={styles.settingsContent}>
          <section id="account" className={styles.pane}>
            <PaneHeading title="Account" description="Your name and picture come from GitHub each time you sign in." />
            {session === undefined ? <Skeleton rows={1} /> : user ? (
              <section className={styles.group}>
                <div className={styles.identity}>
                  <Avatar user={user} size={48} />
                  <div className={styles.identityText}>
                    <strong>{user.name}</strong>
                    <span><GitHubMark /> Signed in with GitHub</span>
                  </div>
                  <button type="button" className="button button--secondary button--sm" disabled={signingOut} onClick={signOut}>
                    {signingOut ? 'Signing out…' : 'Sign out'}
                  </button>
                </div>
              </section>
            ) : (
              <p className={styles.notice}>Authentication is disabled; requests use the local development account.</p>
            )}
          </section>

          <section id="navigation" className={styles.pane}>
            <PaneHeading
              title="Navigation"
              description="Choose which books and blog groups appear in your navigation, and in what order."
              aside={subscriptionsFeedback}
            />
            {!preferenceWorkspace || !site || preferencesLoading || subscriptionsLoading ? <Skeleton rows={4} /> : (
              <>
                <section className={styles.group}>
                  <h2 className={styles.groupTitle}>Books</h2>
                  {books.length ? orderedBooks.map((book, index) => (
                    <div className={styles.optionRow} key={book.key}>
                      <label className={styles.option}>
                        <input
                          type="checkbox"
                          checked={isBookSubscribed(subscriptions, book.key)}
                          disabled={subscriptionsSaving}
                          onChange={() => toggleBookSubscription(book.key)}
                        />
                        <span>{book.title}</span>
                      </label>
                      {orderButtons(book.title, index, orderedBooks.length, reorderBooks)}
                    </div>
                  )) : <p className={styles.empty}>No books yet.</p>}
                </section>
                {blogs.length ? blogs.map(collection => {
                  const orderedGroups = orderByPreference(
                    subscriptionGroups[collection.key] ?? [],
                    subscriptions?.groupOrder?.[collection.key],
                  );
                  return (
                    <section className={styles.group} key={collection.key}>
                      <h2 className={styles.groupTitle}>{blogs.length > 1 ? collection.title : 'Blog groups'}</h2>
                      {orderedGroups.length ? orderedGroups.map((title, index) => (
                        <div className={styles.optionRow} key={title}>
                          <label className={styles.option}>
                            <input
                              type="checkbox"
                              checked={isGroupSubscribed(subscriptions, collection.key, title)}
                              disabled={subscriptionsSaving}
                              onChange={() => toggleGroupSubscription(collection.key, title)}
                            />
                            <span>{title}</span>
                          </label>
                          {orderButtons(title, index, orderedGroups.length,
                            (from, direction) => reorderGroups(collection.key, from, direction))}
                        </div>
                      )) : <p className={styles.empty}>No groups yet.</p>}
                    </section>
                  );
                }) : (
                  <section className={styles.group}>
                    <h2 className={styles.groupTitle}>Blog groups</h2>
                    <p className={styles.empty}>No blog groups yet.</p>
                  </section>
                )}
              </>
            )}
          </section>

          {activeWorkspace && (
            <section id="workspace" className={styles.pane}>
              <PaneHeading
                title={activeWorkspace.name}
                description={`You are ${/^[aeiou]/i.test(activeWorkspace.role) ? 'an' : 'a'} ${activeWorkspace.role} of this workspace.`}
              />
              <WorkspaceControls key={activeWorkspace.id} workspace={activeWorkspace} />
            </section>
          )}

          {activeWorkspace && (
            <section id="danger" className={styles.pane}>
              <PaneHeading title="Danger zone" description="Leaving this workspace." />
              <DangerZone key={activeWorkspace.id} workspace={activeWorkspace} />
            </section>
          )}
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
