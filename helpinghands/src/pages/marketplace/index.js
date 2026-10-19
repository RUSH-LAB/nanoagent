import React from 'react';
import BrowserOnly from '@docusaurus/BrowserOnly';
import Link from '@docusaurus/Link';
import {useHistory, useLocation} from '@docusaurus/router';
import clsx from 'clsx';
import Layout from '@theme/Layout';
import AppProduct from '@site/src/components/AppProduct';
import ErrorBoundary from '@site/src/components/ErrorBoundary';
import TwoColumnLayout from '@site/src/components/TwoColumnLayout';
// The Plugins page's sidebar, reused so the two read as one design.
import sidebar from '@site/src/components/BlogGroupSidebar/styles.module.css';
import pluginSidebar from '@site/src/components/PluginSidebar/styles.module.css';
import {SidebarFoot} from '@site/src/components/PluginSidebar';
import useWorkspaceSite from '@site/src/hooks/useWorkspaceSite';
import {forgetWorkspaceApps, prepareWorkspaceApps, workspaceAppsUrl} from '@site/src/hooks/useWorkspaceApps';
import {useClickOutside} from '@site/src/hooks/useClickOutside';
import {clientPlatform} from '@site/src/platform/client';
import API_BASE, {apiFetch, apiJson} from '@site/src/utils/api';
import styles from './styles.module.css';

/**
 * The plugin marketplace (server/routes/market.js), as a store beside the
 * Plugins page and shaped like it: a sidebar of views (every plugin, the ones
 * the member installed, the installs a newer version is out for, the ones they
 * published), and a column of cards, each with the one thing to do with it:
 * install, update or open. NanoAgent's own plugins and the ones people publish
 * from GitHub are listed together. A member installs a plugin for themselves
 * (server/routes/apps.js) and uses it on the Plugins page of any workspace they
 * are in, where NanoAgent runs it in a sandbox: it reaches only the hosts it
 * declares and writes only to the member's folder for it. Where the reader is
 * lives in the URL: `?view=` the view, `?plugin=` the plugin whose page is
 * open, so each can be linked. A published plugin is checked against the
 * plugin rules but not reviewed, so its page says so.
 */

const kilobytes = size => `${Math.max(1, Math.round(size / 1024))} KB`;
const githubAccount = login => ({name: `@${login}`, href: `https://github.com/${login}`});
// A plugin is by a GitHub account: NanoAgent's own are its author's, @zeyuyang8; a published one is its publisher's.
const authorOf = plugin => (plugin.source === 'nanoagent'
  ? {...githubAccount('zeyuyang8'), official: true}
  : githubAccount(plugin.owner.github));

/** The URL to publish `repository` from again: its ref, at its folder. */
function publishUrl({owner, repo, ref, path}) {
  const base = `https://github.com/${owner}/${repo}`;
  return ref === 'HEAD' && !path ? base : `${base}/tree/${ref}${path ? `/${path}` : ''}`;
}

/** Where `repository`'s folder is on GitHub at the commit it was published from. */
const commitUrl = ({owner, repo, commit, path}) => `https://github.com/${owner}/${repo}/tree/${commit}${path ? `/${path}` : ''}`;

async function send(path, init) {
  let response;
  try {
    response = await apiFetch(`${API_BASE}${path}`, init);
  } catch {
    return {error: 'Could not reach the API server'};
  }
  const data = await response.json().catch(() => ({}));
  return response.ok ? {data} : {error: data.error || `The request failed (${response.status})`};
}

const publish = url => send('/api/market', {
  method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({url}),
});

/** Whether the member's install of `plugin`, `added`, runs an older version than its latest, and that one runs. */
const updatable = (plugin, added) => Boolean(added?.latest && added.version !== added.latest && plugin.status !== 'refused');

/** The sidebar's views: what each lists, of the plugins and the member's installs. */
const VIEWS = [
  {id: 'discover', title: 'Discover', shows: () => true},
  {id: 'installed', title: 'Installed', installs: true, shows: (plugin, added) => Boolean(added)},
  {id: 'updates', title: 'Updates', installs: true, shows: updatable},
  {id: 'mine', title: 'Published by You', shows: plugin => plugin.mine},
];

/** The views, each a plain link with its count, then where to publish one, then the collapse control. */
function MarketSidebar({views, view, href, publishLink, collapsed, onCollapse}) {
  return (
    <div className={clsx(sidebar.sidebar, collapsed && sidebar.sidebarHidden)}>
      <nav className={clsx('menu thin-scrollbar', sidebar.menu)} aria-label="Marketplace">
        <ul className="menu__list">
          {views.map(item => (
            <li className="menu__list-item" key={item.id}>
              <Link
                className={clsx('menu__link', sidebar.categoryLink, item.id === view.id && 'menu__link--active')}
                to={href({view: item.id === 'discover' ? null : item.id, plugin: null})}
              >
                <span className={sidebar.taxonomyTitle}>{item.title}</span>
                {item.id === 'updates' && item.count > 0
                  ? <span className={styles.updateCount}>{item.count}</span>
                  : <span className={sidebar.itemCount}>{item.count}</span>}
              </Link>
            </li>
          ))}
          {publishLink && (
            <li className="menu__list-item">
              <Link className={clsx('menu__link', sidebar.categoryLink, pluginSidebar.marketplace)} to={publishLink.to}>
                <svg className={pluginSidebar.plus} viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10" /></svg>
                <span className={sidebar.taxonomyTitle}>{publishLink.label}</span>
              </Link>
            </li>
          )}
        </ul>
      </nav>
      <SidebarFoot label="Collapse marketplace navigation" onCollapse={onCollapse} />
    </div>
  );
}

/** A card's one action: update an install a newer version is out for, open an install, or install. */
function CardAction({plugin, added, slug, busy, onInstall, onUpdate}) {
  if (updatable(plugin, added)) {
    return (
      <button type="button" className={clsx('button button--primary button--sm', styles.action)} disabled={busy} onClick={onUpdate}>
        Update
      </button>
    );
  }
  if (added) {
    return (
      <Link className={clsx('button button--secondary button--sm', styles.action)} to={`/w/${encodeURIComponent(slug)}/apps?app=${encodeURIComponent(plugin.id)}`}>
        Open
      </Link>
    );
  }
  return (
    <button
      type="button"
      className={clsx('button button--outline button--secondary button--sm', styles.action)}
      disabled={busy || plugin.status === 'refused'}
      onClick={onInstall}
    >
      Install
    </button>
  );
}

/** What the member's install is at: the version they run and the one it moves to, or that it is current. */
function InstallState({plugin, added}) {
  if (!added) return null;
  if (updatable(plugin, added)) return <span className={styles.stateUpdate}>v{added.version} → v{added.latest}</span>;
  return <span className={styles.stateInstalled}>Installed{added.version ? ` · v${added.version}` : ''}</span>;
}

/** A store card: the plugin, which opens its page, and its action at the right edge. */
function Card({plugin, added, slug, busy, href, onInstall, onUpdate}) {
  const author = authorOf(plugin);
  return (
    <article className={styles.card}>
      <Link className={styles.cardOpen} to={href({plugin: plugin.id})}>
        {/* A data: URL checked by NanoAgent, in an <img>, where an SVG cannot run anything. */}
        <img className={styles.icon} src={plugin.product.icon} alt="" />
        <span className={styles.cardBody}>
          <span className={styles.name}>
            <span className={styles.nameText}>{plugin.name}</span>
            {author.official && <span className={clsx(styles.badge, styles.official)}>Official</span>}
            {plugin.status === 'refused' && <span className={styles.badge}>Outdated</span>}
          </span>
          <span className={styles.tagline}>{plugin.product.tagline}</span>
          <span className={styles.meta}>
            by {author.name}
            <InstallState plugin={plugin} added={added} />
          </span>
        </span>
      </Link>
      {added !== undefined && (
        <CardAction plugin={plugin} added={added} slug={slug} busy={busy} onInstall={onInstall} onUpdate={onUpdate} />
      )}
    </article>
  );
}

const EMPTY_ICONS = {
  check: <path d="m6.5 12.5 3.5 3.5 7.5-8" />,
  search: <><circle cx="11" cy="11" r="6" /><path d="m15.5 15.5 4 4" /></>,
  store: <path d="M4.5 9.5h15l-1.2 10h-12.6zM8.5 9.5v-2a3.5 3.5 0 0 1 7 0v2" />,
  upload: <path d="M12 16V5M7.5 9.5 12 5l4.5 4.5M5 19h14" />,
};

/** A view with nothing to show: what that means, and the next step, a link `to` or a button `onClick`. */
function EmptyState({icon, title, text, label, to, onClick}) {
  return (
    <section className={styles.emptyState}>
      <span className={styles.emptyIcon}>
        <svg viewBox="0 0 24 24" aria-hidden="true">{EMPTY_ICONS[icon]}</svg>
      </span>
      <h2 className={styles.emptyTitle}>{title}</h2>
      <p className={styles.emptyText}>{text}</p>
      {to && <Link className="button button--secondary button--sm" to={to}>{label}</Link>}
      {onClick && <button type="button" className="button button--secondary button--sm" onClick={onClick}>{label}</button>}
    </section>
  );
}

function Publish({onPublished}) {
  const [url, setUrl] = React.useState('');
  const [state, setState] = React.useState({busy: false, error: null});
  const submit = async event => {
    event.preventDefault();
    setState({busy: true, error: null});
    const result = await publish(url);
    if (result.error) return setState({busy: false, error: result.error});
    setUrl('');
    setState({busy: false, error: null});
    return onPublished(result.data.plugin);
  };
  return (
    <section>
      <header className={clsx(styles.header, styles.stacked)}>
        <h1>Publish a Plugin</h1>
        <p className={styles.lead}>
          Paste the GitHub URL of a public repository, or of a folder in one. RUSH checks every plugin rule without
          running it, then lists it here. To publish a newer version, raise its version and publish it again.
        </p>
      </header>
      <form className={styles.publishForm} onSubmit={submit}>
        <input
          type="url"
          required
          aria-label="GitHub URL of the plugin to publish"
          placeholder="https://github.com/you/your-plugin"
          value={url}
          onChange={event => setUrl(event.target.value)}
          disabled={state.busy}
        />
        <button type="submit" className="button button--primary" disabled={state.busy}>
          {state.busy ? 'Checking…' : 'Publish'}
        </button>
      </form>
      {state.error && <div className={styles.error}>{state.error}</div>}
    </section>
  );
}

/** The rest of what the reader may do, behind one ⋯ button: `items` of {label, onSelect, danger}. */
function MoreMenu({items, busy}) {
  const [open, setOpen] = React.useState(false);
  const wrapper = React.useRef(null);
  useClickOutside(wrapper, () => setOpen(false), open);
  if (!items.length) return null;
  return (
    <div className={styles.more} ref={wrapper}>
      <button
        type="button"
        className={`button button--outline button--secondary ${styles.moreButton}`}
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy}
        onClick={() => setOpen(value => !value)}
      >
        ⋯
      </button>
      {open && (
        <ul className={styles.menu} role="menu">
          {items.map(({label, onSelect, danger}) => (
            <li key={label} role="none">
              <button
                type="button"
                role="menuitem"
                className={`${styles.menuItem} ${danger ? styles.menuDanger : ''}`}
                onClick={() => {
                  setOpen(false);
                  onSelect();
                }}
              >
                {label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Detail({plugin, added, slug, back, busy, onInstall, onUpdate, act, onChanged, onAdded}) {
  // For its uploader: the newest commit on GitHub that changed the plugin since its latest version.
  const [newer, setNewer] = React.useState(null);
  const author = authorOf(plugin);
  const fromGithub = Boolean(plugin.mine && plugin.repository);
  React.useEffect(() => {
    if (!fromGithub) return undefined;
    let cancelled = false;
    send(`/api/market/${plugin.id}/source`).then(result => !cancelled && setNewer(result.error ? {error: result.error} : {commit: result.data.newer}));
    return () => { cancelled = true; };
  }, [fromGithub, plugin.id, plugin.version]);

  const uninstall = async () => {
    if (!(await clientPlatform.dialogs.confirm(`Uninstall ${plugin.name}? Your files from it stay in your folder.`))) return;
    act(() => send(`/api/apps/${plugin.id}`, {method: 'DELETE'}), () => onAdded(null));
  };
  const republish = () => act(() => publish(publishUrl(plugin.repository)), data => onChanged(data.plugin.id));
  const remove = async () => {
    if (!(await clientPlatform.dialogs.confirm(`Remove ${plugin.name} from the Marketplace? People can no longer download it, and it is uninstalled for everyone.`))) return;
    act(() => send(`/api/market/${plugin.id}`, {method: 'DELETE'}), () => onChanged(null));
  };

  const update = updatable(plugin, added);
  const appsHref = `/w/${encodeURIComponent(slug)}/apps?app=${encodeURIComponent(plugin.id)}`;
  const more = [
    ...(plugin.mine && plugin.repository ? [{label: 'Publish again from GitHub', onSelect: republish}] : []),
    ...(added ? [{label: 'Uninstall', onSelect: uninstall, danger: true}] : []),
    ...(plugin.mine ? [{label: 'Remove from Marketplace', onSelect: remove, danger: true}] : []),
  ];
  const actions = added === undefined ? <MoreMenu items={more} busy={busy} /> : (
    <>
      {update && (
        <button type="button" className="button button--primary" disabled={busy} onClick={onUpdate}>
          Update to v{added.latest}
        </button>
      )}
      {added ? (
        <Link className={clsx('button', update ? 'button--secondary' : 'button--primary')} to={appsHref}>Open</Link>
      ) : (
        <button type="button" className="button button--primary" disabled={busy || plugin.status === 'refused'} onClick={onInstall}>
          Install
        </button>
      )}
      <MoreMenu items={more} busy={busy} />
      {busy && <span className={styles.hint}>Working…</span>}
    </>
  );
  const meta = (
    <>
      v{plugin.version}
      {added && added.version !== plugin.version && ` (you have v${added.version})`}
      {plugin.repository && (
        <> · <a href={commitUrl(plugin.repository)} target="_blank" rel="noreferrer">Source</a></>
      )}
      {' · '}
      <a href={`${API_BASE}/api/market/${plugin.id}/package`} download>Download ({kilobytes(plugin.size)})</a>
      {!author.official && ' · Not reviewed: read its source before you install it.'}
    </>
  );

  return (
    <section className={styles.detail}>
      <Link className={styles.back} to={back.to}>← {back.title}</Link>
      {update && added.status === 'refused' && (
        <div className={styles.updateNotice}>
          Your version, v{added.version}, no longer runs here. Update to v{added.latest} to use {plugin.name} again.
        </div>
      )}
      {plugin.status === 'refused' && (
        <div className={styles.notice}>
          v{plugin.version} no longer runs here{plugin.refusal ? `: ${plugin.refusal}` : '.'} It installs again once its author publishes a version that does.
        </div>
      )}
      {newer?.error && <div className={styles.error}>Could not ask GitHub about newer commits: {newer.error}</div>}
      {newer?.commit && (
        <div className={styles.notice}>
          GitHub has <a href={`https://github.com/${plugin.repository.owner}/${plugin.repository.repo}/compare/${plugin.repository.commit}...${newer.commit}`} target="_blank" rel="noreferrer">changes to {plugin.name}</a> since
          v{plugin.version}. Raise its version, then choose Publish again from GitHub in the ⋯ menu.
        </div>
      )}
      <AppProduct
        app={plugin}
        byline={<>by <a href={author.href} target="_blank" rel="noreferrer">{author.name}</a></>}
        actions={actions}
        meta={meta}
      />
    </section>
  );
}

function Marketplace() {
  const location = useLocation();
  const history = useHistory();
  const {slug, workspace, site} = useWorkspaceSite();
  const workspaceId = workspace?.id ?? null;
  // The plugins the member installed, by id, as they run them, or null outside a workspace.
  const [added, setAdded] = React.useState(null);
  const params = new URLSearchParams(location.search);
  const [state, setState] = React.useState({plugins: null, error: null});
  const [query, setQuery] = React.useState('');
  // The plugin a request is under way for, and the last request's error.
  const [action, setAction] = React.useState({busy: null, error: null});

  const load = React.useCallback(async () => {
    const result = await apiJson(`${API_BASE}/api/market`, {fresh: true}).catch(() => null);
    if (!result) return setState({plugins: null, error: 'Could not reach the API server'});
    return setState(result.ok
      ? {plugins: result.data.plugins, error: null}
      : {plugins: null, error: result.data.error || `Could not load the marketplace (${result.status})`});
  }, []);
  React.useEffect(() => { load(); }, [load]);
  React.useEffect(() => {
    if (!workspaceId) return undefined;
    let cancelled = false;
    apiJson(workspaceAppsUrl(workspaceId), {fresh: true}).then(
      result => !cancelled && result.ok && setAdded(new Map(result.data.apps.map(app => [app.id, app]))),
      () => {},
    );
    return () => { cancelled = true; };
  }, [workspaceId]);
  /** The member's install of `id` is now `app`, or with null they uninstalled it. */
  const markAdded = (id, app) => {
    forgetWorkspaceApps(workspaceId);
    if (app) prepareWorkspaceApps(workspaceId, {again: true});
    setAdded(current => {
      const next = new Map(current);
      if (app) next.set(id, app);
      else next.delete(id);
      return next;
    });
  };

  /** This page's URL with `changes` to its query: a key set to null leaves it. */
  const href = changes => {
    const next = new URLSearchParams(location.search);
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    const search = next.toString();
    return `${location.pathname}${search ? `?${search}` : ''}`;
  };

  /** Run `request` for `plugin`, then `after` with its data, or show its error. */
  const act = (plugin, request, after) => async () => {
    setAction({busy: plugin.id, error: null});
    const result = await request();
    if (result.error) return setAction({busy: null, error: result.error});
    setAction({busy: null, error: null});
    return after(result.data);
  };
  const install = plugin => act(plugin, () => send(`/api/apps/${plugin.id}`, {method: 'PUT'}), data => markAdded(plugin.id, data.app));
  const update = plugin => act(
    plugin,
    () => send(`/api/apps/${plugin.id}`, {
      method: 'PATCH', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({version: added.get(plugin.id).latest}),
    }),
    data => markAdded(plugin.id, data.app),
  );

  const plugins = state.plugins ?? [];
  // Inside a workspace each plugin's install, or null for none; outside one, undefined: nothing to install into.
  const addedOf = plugin => (added ? added.get(plugin.id) ?? null : undefined);
  const views = VIEWS
    .filter(item => (!item.installs || added) && (item.id !== 'mine' || plugins.some(plugin => plugin.mine)))
    .map(item => ({...item, count: plugins.filter(plugin => item.shows(plugin, addedOf(plugin))).length}));
  const publishing = params.get('view') === 'publish';
  const view = views.find(item => item.id === params.get('view')) ?? views[0];
  // A workspace that takes submissions publishes through its Submit page, which records what the
  // submitter agrees to (pages/submit).
  const publishLink = site?.submissions
    ? {label: 'Submit Your Artifact', to: `/w/${encodeURIComponent(slug)}/submit`}
    : {label: 'Publish a Plugin', to: href({view: 'publish', plugin: null})};

  const open = plugins.find(plugin => plugin.id === params.get('plugin'));
  const needle = query.trim().toLowerCase();
  const shown = plugins
    .filter(plugin => view.shows(plugin, addedOf(plugin)))
    .filter(plugin => !needle
      || [plugin.name, plugin.product.tagline, plugin.product.summary, authorOf(plugin).name]
        .some(text => text.toLowerCase().includes(needle)));
  const updates = views.find(item => item.id === 'updates')?.count ?? 0;
  const discover = {label: 'Browse Discover', to: href({view: null, plugin: null})};
  const empty = needle ? {
    icon: 'search',
    title: `No plugins match “${query.trim()}”`,
    text: 'Try another name, or what the plugin does.',
    onClick: () => setQuery(''),
    label: 'Clear search',
  } : {
    discover: {icon: 'store', title: 'No plugins yet', text: 'Plugins people publish from GitHub appear here.'},
    installed: {icon: 'store', title: 'Nothing installed yet', text: 'Install a plugin and it runs on the Plugins page of every workspace you are in.', ...discover},
    updates: {icon: 'check', title: 'You are up to date', text: 'Every plugin you installed runs its latest version.', ...discover},
    mine: {icon: 'upload', title: 'Nothing published yet', text: 'Publish a plugin from its GitHub repository and it is listed here.', label: publishLink.label, to: publishLink.to},
  }[view.id];

  let content;
  if (publishing) {
    content = (
      <Publish onPublished={async plugin => {
        await load();
        history.push(href({view: null, plugin: plugin.id}));
      }}
      />
    );
  } else if (open) {
    content = (
      <Detail
        plugin={open}
        added={addedOf(open)}
        slug={slug}
        back={{title: view.title, to: href({plugin: null})}}
        busy={action.busy === open.id}
        onInstall={install(open)}
        onUpdate={update(open)}
        act={(request, after) => act(open, request, after)()}
        onAdded={app => markAdded(open.id, app)}
        onChanged={async id => {
          await load();
          history.push(href({plugin: id}));
        }}
      />
    );
  } else {
    content = (
      <>
        <header className={styles.header}>
          <h1>{view.title}</h1>
          {view.count > 0 && (
            <label className={styles.search}>
              <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                <circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="1.5" />
                <path d="M11 11l3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              <input
                type="search"
                aria-label="Search plugins"
                placeholder="Search plugins"
                value={query}
                onChange={event => setQuery(event.target.value)}
              />
            </label>
          )}
        </header>
        {/* Where the window is too narrow for the sidebar, the views are these chips. */}
        <nav className={styles.chips} aria-label="Marketplace views">
          {views.map(item => (
            <Link
              key={item.id}
              className={clsx(styles.chip, item.id === view.id && styles.chipActive)}
              to={href({view: item.id === 'discover' ? null : item.id, plugin: null})}
            >
              {item.title} <span className={styles.chipCount}>{item.count}</span>
            </Link>
          ))}
        </nav>
        {view.id !== 'updates' && updates > 0 && (
          <Link className={styles.updatesBanner} to={href({view: 'updates', plugin: null})}>
            <span>{updates === 1 ? 'An update is' : `${updates} updates are`} available for plugins you installed.</span>
            <span className={styles.updatesLink}>Review →</span>
          </Link>
        )}
        {state.plugins && !shown.length && <EmptyState {...empty} />}
        <div className={styles.grid}>
          {shown.map(plugin => (
            <Card
              key={plugin.id}
              plugin={plugin}
              added={addedOf(plugin)}
              slug={slug}
              busy={action.busy === plugin.id}
              href={href}
              onInstall={install(plugin)}
              onUpdate={update(plugin)}
            />
          ))}
        </div>
      </>
    );
  }

  return (
    <TwoColumnLayout
      sidebarKey="marketplace"
      evenGutters
      renderSidebar={({collapsed, onCollapse}) => (
        <MarketSidebar
          views={views}
          view={publishing ? {id: null} : view}
          href={href}
          publishLink={publishLink}
          collapsed={collapsed}
          onCollapse={onCollapse}
        />
      )}
    >
      {state.error && <div className={styles.error}>{state.error}</div>}
      {action.error && <div className={styles.error}>{action.error}</div>}
      {content}
    </TwoColumnLayout>
  );
}

/** The page's title and description, for its Layout here and in the shell (components/Shell/Sections.js). */
export const page = {title: 'Marketplace', description: 'NanoAgent plugins to add to your workspace and share'};

export function MarketplaceSection() {
  return (
    <BrowserOnly fallback={<div style={{padding: 40, textAlign: 'center'}}>Loading...</div>}>
      {() => <ErrorBoundary><Marketplace /></ErrorBoundary>}
    </BrowserOnly>
  );
}

export default function MarketplacePage() {
  return (
    <Layout {...page}>
      <MarketplaceSection />
    </Layout>
  );
}
