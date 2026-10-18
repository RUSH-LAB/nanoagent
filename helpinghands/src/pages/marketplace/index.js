import React from 'react';
import BrowserOnly from '@docusaurus/BrowserOnly';
import Link from '@docusaurus/Link';
import {useHistory, useLocation} from '@docusaurus/router';
import Layout from '@theme/Layout';
import AppProduct from '@site/src/components/AppProduct';
import ErrorBoundary from '@site/src/components/ErrorBoundary';
import pageStyles from '@site/src/css/page.module.css';
import useWorkspaceSite from '@site/src/hooks/useWorkspaceSite';
import {forgetWorkspaceApps, prepareWorkspaceApps, workspaceAppsUrl} from '@site/src/hooks/useWorkspaceApps';
import {useClickOutside} from '@site/src/hooks/useClickOutside';
import {clientPlatform} from '@site/src/platform/client';
import API_BASE, {apiFetch, apiJson} from '@site/src/utils/api';
import styles from './styles.module.css';

/**
 * The plugin marketplace (server/routes/market.js), as a gallery: NanoAgent's
 * own plugins and the ones people publish from GitHub. A member installs a
 * plugin for themselves (server/routes/apps.js) and uses it on the Plugins page
 * of any workspace they are in, where NanoAgent runs it in a sandbox: it
 * reaches only the hosts it declares and writes only to the member's folder for
 * it. A tile opens the plugin's product page in place of the gallery;
 * `?plugin=` names it, so it can be linked. A plugin names no tags: a member
 * tags the ones they installed. A published plugin is checked against the
 * plugin rules but not reviewed, so the page says so.
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

/** Whether the member's install of `plugin`, `added`, runs an older version than its latest. */
const behind = added => Boolean(added?.latest && added.version !== added.latest);

function Tile({plugin, added, onOpen}) {
  const author = authorOf(plugin);
  return (
    <button type="button" className={styles.tile} onClick={() => onOpen(plugin)}>
      {/* A data: URL checked by NanoAgent, in an <img>, where an SVG cannot run anything. */}
      <img className={styles.icon} src={plugin.product.icon} alt="" />
      <div className={styles.tileBody}>
        <h2 className={styles.name}>
          <span className={styles.nameText}>{plugin.name}</span>
          {added && <span className={`${styles.badge} ${styles.added}`}>{behind(added) ? 'Update available' : 'Added'}</span>}
          {plugin.status === 'refused' && <span className={`${styles.badge} ${styles.maintenance}`}>Under maintenance</span>}
        </h2>
        <p className={styles.tagline}>{plugin.product.tagline}</p>
        <p className={styles.author}>
          by {author.name}
          {author.official && <span className={`${styles.badge} ${styles.official}`}>Official</span>}
        </p>
      </div>
    </button>
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
    <section className={styles.publish}>
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

/** The page's one button: open the plugin, or install it for yourself. */
function WorkspaceAction({plugin, added, workspace, slug, busy, onAdd}) {
  if (!workspace) return null;
  if (added) {
    const appsHref = `/w/${encodeURIComponent(slug)}/apps?app=${encodeURIComponent(plugin.id)}`;
    return <Link className="button button--primary" to={appsHref}>Open</Link>;
  }
  return <button type="button" className="button button--primary" disabled={busy || plugin.status === 'refused'} onClick={onAdd}>Install</button>;
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

function Detail({plugin, added, workspace, slug, onBack, onChanged, onAdded}) {
  const [state, setState] = React.useState({busy: false, error: null});
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

  const act = async (request, after) => {
    setState({busy: true, error: null});
    const result = await request();
    if (result.error) return setState({busy: false, error: result.error});
    setState({busy: false, error: null});
    return after(result.data);
  };
  const add = () => act(() => send(`/api/apps/${plugin.id}`, {method: 'PUT'}), data => onAdded(data.app));
  const uninstall = async () => {
    if (!(await clientPlatform.dialogs.confirm(`Uninstall ${plugin.name}? Your files from it stay in your folder.`))) return;
    act(() => send(`/api/apps/${plugin.id}`, {method: 'DELETE'}), () => onAdded(null));
  };
  const update = () => act(() => publish(publishUrl(plugin.repository)), data => onChanged(data.plugin.id));
  const updateInstall = () => act(
    () => send(`/api/apps/${plugin.id}`, {
      method: 'PATCH', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({version: added.latest}),
    }),
    data => onAdded(data.app),
  );
  const remove = async () => {
    if (!(await clientPlatform.dialogs.confirm(`Remove ${plugin.name} from the Marketplace? People can no longer download it, and it is uninstalled for everyone.`))) return;
    act(() => send(`/api/market/${plugin.id}`, {method: 'DELETE'}), () => onChanged(null));
  };

  const more = [
    ...(behind(added) ? [{label: `Update to v${added.latest}`, onSelect: updateInstall}] : []),
    ...(plugin.mine && plugin.repository ? [{label: 'Publish again from GitHub', onSelect: update}] : []),
    ...(added ? [{label: 'Uninstall', onSelect: uninstall, danger: true}] : []),
    ...(plugin.mine ? [{label: 'Remove from Marketplace', onSelect: remove, danger: true}] : []),
  ];
  const actions = (
    <>
      <WorkspaceAction plugin={plugin} added={added} workspace={workspace} slug={slug} busy={state.busy} onAdd={add} />
      <MoreMenu items={more} busy={state.busy} />
      {state.busy && <span className={styles.hint}>Working…</span>}
    </>
  );
  const meta = (
    <>
      v{plugin.version}
      {behind(added) && ` (you have v${added.version})`}
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
      <button type="button" className={styles.back} onClick={onBack}>← Marketplace</button>
      {state.error && <div className={styles.error}>{state.error}</div>}
      {newer?.error && <div className={styles.error}>Could not ask GitHub about newer commits: {newer.error}</div>}
      {plugin.status === 'refused' && (
        <div className={styles.maintenanceNotice}>
          <strong>Under maintenance.</strong> v{plugin.version} does not run on this version of RUSH Lab, so it can't be installed
          until {plugin.mine ? 'you publish' : 'its author publishes'} it again. NanoAgent says: {plugin.refusal}.
          {plugin.mine && ' Fix that on GitHub, raise its version, then choose Publish again from GitHub in the ⋯ menu.'}
        </div>
      )}
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
  const openId = params.get('plugin');
  const [state, setState] = React.useState({plugins: null, error: null});
  const [query, setQuery] = React.useState('');
  const [publishing, setPublishing] = React.useState(false);

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

  const navigate = changes => {
    const next = new URLSearchParams(location.search);
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    const search = next.toString();
    history.push(`${location.pathname}${search ? `?${search}` : ''}`);
  };

  const plugins = state.plugins ?? [];
  const needle = query.trim().toLowerCase();
  const shown = plugins.filter(plugin => !needle
    || [plugin.name, plugin.product.tagline, plugin.product.summary, authorOf(plugin).name]
      .some(text => text.toLowerCase().includes(needle)));
  const open = plugins.find(plugin => plugin.id === openId);

  if (open) {
    return (
      <main className={`${pageStyles.pageContainer} ${pageStyles.wide}`}>
        <Detail
          plugin={open}
          added={added?.get(open.id) ?? null}
          workspace={added ? workspace : null}
          slug={slug}
          onAdded={app => markAdded(open.id, app)}
          onBack={() => navigate({plugin: null})}
          onChanged={async id => {
            await load();
            navigate({plugin: id});
          }}
        />
      </main>
    );
  }

  return (
    <main className={`${pageStyles.pageContainer} ${pageStyles.wide}`}>
      <header className={styles.header}>
        <h1>Marketplace</h1>
        {/* A workspace that takes submissions publishes through its Submit page,
            which records what the submitter agrees to (pages/submit). */}
        {site?.submissions ? (
          <Link className="button button--primary" to={`/w/${encodeURIComponent(slug)}/submit`}>
            Submit your artifact
          </Link>
        ) : (
          <button type="button" className="button button--primary" onClick={() => setPublishing(value => !value)}>
            {publishing ? 'Cancel' : '+ Publish a plugin'}
          </button>
        )}
      </header>
      {publishing && (
        <Publish onPublished={async plugin => {
          setPublishing(false);
          await load();
          navigate({plugin: plugin.id});
        }}
        />
      )}

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
      {state.error && <div className={styles.error}>{state.error}</div>}
      {state.plugins && !shown.length && <p className={styles.empty}>No plugins match.</p>}
      <div className={styles.grid}>
        {shown.map(plugin => (
          <Tile
            key={plugin.id}
            plugin={plugin}
            added={added?.get(plugin.id) ?? null}
            onOpen={chosen => navigate({plugin: chosen.id})}
          />
        ))}
      </div>
    </main>
  );
}

export default function MarketplacePage() {
  return (
    <Layout title="Marketplace" description="NanoAgent plugins to add to your workspace and share">
      <BrowserOnly fallback={<div style={{padding: 40, textAlign: 'center'}}>Loading...</div>}>
        {() => <ErrorBoundary><Marketplace /></ErrorBoundary>}
      </BrowserOnly>
    </Layout>
  );
}
