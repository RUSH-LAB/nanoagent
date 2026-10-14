import React from 'react';
import BrowserOnly from '@docusaurus/BrowserOnly';
import Link from '@docusaurus/Link';
import {useHistory, useLocation} from '@docusaurus/router';
import Layout from '@theme/Layout';
import AppProduct from '@site/src/components/AppProduct';
import ErrorBoundary from '@site/src/components/ErrorBoundary';
import useWorkspaceSite from '@site/src/hooks/useWorkspaceSite';
import {forgetWorkspaceApps, prepareWorkspaceApps, workspaceAppsUrl} from '@site/src/hooks/useWorkspaceApps';
import {useClickOutside} from '@site/src/hooks/useClickOutside';
import API_BASE, {apiFetch, apiJson} from '@site/src/utils/api';
import styles from './styles.module.css';

/**
 * The plugin marketplace (server/routes/market.js), as a gallery: NanoAgent's
 * own plugins and the ones people publish from GitHub. A workspace's owner adds
 * a plugin to the workspace (server/routes/apps.js), and then every member uses
 * it on the Plugins page, where NanoAgent runs it in a sandbox: it reaches only
 * the hosts it declares and writes only to the member's agent folder. A tile
 * opens the plugin's product page in place of the gallery; `?plugin=` names
 * it, so it can be linked. A plugin names no tags: a workspace tags the ones it
 * added (Settings → Plugins). A published plugin is checked against the plugin
 * rules but not reviewed, so the page says so.
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

function Tile({plugin, added, onOpen}) {
  const author = authorOf(plugin);
  return (
    <button type="button" className={styles.tile} onClick={() => onOpen(plugin)}>
      <div className={styles.art}>
        {/* A data: URL checked by NanoAgent, in an <img>, where an SVG cannot run anything. */}
        <img src={plugin.product.icon} alt="" />
      </div>
      <div className={styles.tileBody}>
        <h2 className={styles.name}>
          {plugin.name}
          {added && <span className={styles.added}>Added</span>}
        </h2>
        <p className={styles.author}>
          by {author.name}
          {author.official && <span className={styles.official}>Official</span>}
        </p>
        <p className={styles.tagline}>{plugin.product.tagline}</p>
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

/**
 * The page's one button: open the plugin in the workspace, or add it there (an
 * owner's to do); anyone else is told to ask an owner.
 */
function WorkspaceAction({plugin, added, workspace, slug, busy, onAdd}) {
  if (!workspace) return null;
  if (added) {
    const appsHref = `/w/${encodeURIComponent(slug)}/apps?app=${encodeURIComponent(plugin.id)}`;
    return <Link className="button button--primary" to={appsHref}>Open in {workspace.name}</Link>;
  }
  if (workspace.role !== 'owner') return <span className={styles.hint}>Ask an owner of {workspace.name} to add it.</span>;
  return <button type="button" className="button button--primary" disabled={busy} onClick={onAdd}>Add to {workspace.name}</button>;
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
  const author = authorOf(plugin);

  const act = async (request, after) => {
    setState({busy: true, error: null});
    const result = await request();
    if (result.error) return setState({busy: false, error: result.error});
    setState({busy: false, error: null});
    return after(result.data);
  };
  const add = () => act(() => send(`/api/apps/${plugin.id}`, {method: 'PUT'}), () => onAdded(true));
  const removeFromWorkspace = () => {
    if (!window.confirm(`Remove ${plugin.name} from ${workspace.name}? Its members can no longer use it.`)) return;
    act(() => send(`/api/apps/${plugin.id}`, {method: 'DELETE'}), () => onAdded(false));
  };
  const update = () => act(() => publish(publishUrl(plugin.repository)), data => onChanged(data.plugin.id));
  const remove = () => {
    if (!window.confirm(`Remove ${plugin.name} from the Marketplace? People can no longer download it.`)) return;
    act(() => send(`/api/market/${plugin.id}`, {method: 'DELETE'}), () => onChanged(null));
  };

  const more = [
    ...(plugin.mine && plugin.repository ? [{label: 'Update from GitHub', onSelect: update}] : []),
    ...(added && workspace?.role === 'owner' ? [{label: `Remove from ${workspace.name}`, onSelect: removeFromWorkspace, danger: true}] : []),
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
      {plugin.repository && (
        <> · <a href={commitUrl(plugin.repository)} target="_blank" rel="noreferrer">Source</a></>
      )}
      {' · '}
      <a href={`${API_BASE}/api/market/${plugin.id}/package`} download>Download ({kilobytes(plugin.size)})</a>
      {!author.official && ' · Not reviewed: read its source before you add it.'}
    </>
  );

  return (
    <section className={styles.detail}>
      <button type="button" className={styles.back} onClick={onBack}>← Marketplace</button>
      {state.error && <div className={styles.error}>{state.error}</div>}
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
  const {slug, workspace} = useWorkspaceSite();
  const workspaceId = workspace?.id ?? null;
  // The ids of the plugins the workspace added, or null outside one.
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
      result => !cancelled && result.ok && setAdded(new Set(result.data.apps.map(app => app.id))),
      () => {},
    );
    return () => { cancelled = true; };
  }, [workspaceId]);
  const markAdded = (id, isAdded) => {
    forgetWorkspaceApps(workspaceId);
    if (isAdded) prepareWorkspaceApps(workspaceId, {again: true});
    setAdded(current => {
      const next = new Set(current);
      if (isAdded) next.add(id);
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
      <main className={styles.page}>
        <Detail
          plugin={open}
          added={Boolean(added?.has(open.id))}
          workspace={added ? workspace : null}
          slug={slug}
          onAdded={isAdded => markAdded(open.id, isAdded)}
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
    <main className={styles.page}>
      <header className={styles.header}>
        <h1>Marketplace</h1>
        <button type="button" className="button button--primary" onClick={() => setPublishing(value => !value)}>
          {publishing ? 'Cancel' : '+ Publish a plugin'}
        </button>
      </header>
      {publishing && (
        <Publish onPublished={async plugin => {
          setPublishing(false);
          await load();
          navigate({plugin: plugin.id});
        }}
        />
      )}

      <div className={styles.toolbar}>
        <input
          type="search"
          className={styles.search}
          placeholder="Search plugins"
          value={query}
          onChange={event => setQuery(event.target.value)}
        />
      </div>
      {state.error && <div className={styles.error}>{state.error}</div>}
      {state.plugins && !shown.length && <p className={styles.empty}>No plugins match.</p>}
      <div className={styles.grid}>
        {shown.map(plugin => (
          <Tile
            key={plugin.id}
            plugin={plugin}
            added={Boolean(added?.has(plugin.id))}
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
