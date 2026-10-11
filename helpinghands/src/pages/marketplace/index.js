import React from 'react';
import BrowserOnly from '@docusaurus/BrowserOnly';
import {useHistory, useLocation} from '@docusaurus/router';
import Layout from '@theme/Layout';
import AppProduct from '@site/src/components/AppProduct';
import ErrorBoundary from '@site/src/components/ErrorBoundary';
import API_BASE, {apiFetch, apiJson} from '@site/src/utils/api';
import styles from './styles.module.css';

/**
 * The plugin marketplace (server/routes/market.js), as a gallery: NanoAgent's
 * own plugins and the ones people publish from GitHub, as `nanoagent plugin
 * pack` packages to download and run on your own machine. A tile opens the
 * plugin's product page in place of the gallery; `?plugin=` names it and `?by=` an author's
 * shelf, so either can be linked. Nothing here runs a plugin, and a published
 * one is checked against the plugin rules but not reviewed, so the page says so.
 */

const kilobytes = size => `${Math.max(1, Math.round(size / 1024))} KB`;
const NANOAGENT = 'nanoagent';
const authorOf = plugin => (plugin.source === 'nanoagent' ? {id: NANOAGENT, name: 'NanoAgent'} : plugin.owner);

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

function Tile({plugin, onOpen}) {
  const author = authorOf(plugin);
  return (
    <button type="button" className={styles.tile} onClick={() => onOpen(plugin)}>
      <div className={styles.art}>
        {/* A data: URL checked by NanoAgent, in an <img>, where an SVG cannot run anything. */}
        <img src={plugin.product.icon} alt="" />
      </div>
      <div className={styles.tileBody}>
        <h2 className={styles.name}>{plugin.name}</h2>
        <p className={styles.author}>
          by {author.name}
          {author.id === NANOAGENT && <span className={styles.official}>Official</span>}
        </p>
        <p className={styles.tagline}>{plugin.product.tagline}</p>
        <p className={styles.meta}>{plugin.group} · v{plugin.version} · {kilobytes(plugin.size)}</p>
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
      <h2>Publish your plugin from GitHub</h2>
      <p>
        Build a plugin in the NanoAgent plugin format (<code>nanoagent plugin new &lt;folder&gt;</code> starts one,
        and <code>nanoagent plugin inspect &lt;folder&gt;</code> checks it), push it to a public GitHub repository, and
        paste its URL. For a plugin in a subfolder, use the folder's URL: <code>…/tree/&lt;branch&gt;/&lt;folder&gt;</code>.
        NanoAgent checks it against every plugin rule, and the listing is pinned to the commit it was published from.
        Publish again to update it.
      </p>
      <form className={styles.publishForm} onSubmit={submit}>
        <input
          type="url"
          required
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

function Detail({plugin, onBack, onAuthor, onChanged}) {
  const [state, setState] = React.useState({busy: false, error: null});
  const author = authorOf(plugin);

  const act = async (request, after) => {
    setState({busy: true, error: null});
    const result = await request();
    if (result.error) return setState({busy: false, error: result.error});
    setState({busy: false, error: null});
    return after(result.data);
  };
  const update = () => act(() => publish(publishUrl(plugin.repository)), data => onChanged(data.plugin.id));
  const remove = () => {
    if (!window.confirm(`Remove ${plugin.name} from the marketplace? People can no longer download it.`)) return;
    act(() => send(`/api/market/${plugin.id}`, {method: 'DELETE'}), () => onChanged(null));
  };

  const actions = (
    <>
      <a className="button button--primary button--lg" href={`${API_BASE}/api/market/${plugin.id}/package`} download>
        Download ({kilobytes(plugin.size)})
      </a>
      {plugin.repository && (
        <a className="button button--outline button--primary button--lg" href={commitUrl(plugin.repository)} target="_blank" rel="noreferrer">
          Source on GitHub
        </a>
      )}
      {plugin.mine && plugin.repository && (
        <button type="button" className="button button--outline button--primary button--lg" disabled={state.busy} onClick={update}>
          {state.busy ? 'Checking…' : 'Update from GitHub'}
        </button>
      )}
      {plugin.mine && (
        <button type="button" className="button button--outline button--danger button--lg" disabled={state.busy} onClick={remove}>
          Remove
        </button>
      )}
    </>
  );

  return (
    <section className={styles.detail}>
      <nav className={styles.crumbs}>
        <button type="button" className={styles.link} onClick={onBack}>← Marketplace</button>
        <span>
          by <button type="button" className={styles.link} onClick={() => onAuthor(author.id)}>{author.name}</button>
          {plugin.repository && (
            <> · {plugin.repository.owner}/{plugin.repository.repo} at <code>{plugin.repository.commit.slice(0, 7)}</code></>
          )}
        </span>
      </nav>
      {state.error && <div className={styles.error}>{state.error}</div>}
      <AppProduct app={plugin} actions={actions} />
      <p className={styles.notice}>
        Download it, unpack it with <code>tar xzf</code>, and run it with <code>nanoagent plugin</code> on your own
        machine.{author.id !== NANOAGENT && ' Published plugins are checked against the plugin rules but not reviewed, so read its code before you run it.'}
      </p>
    </section>
  );
}

function Marketplace() {
  const location = useLocation();
  const history = useHistory();
  const params = new URLSearchParams(location.search);
  const openId = params.get('plugin');
  const by = params.get('by');
  const [state, setState] = React.useState({plugins: null, error: null});
  const [query, setQuery] = React.useState('');
  const [group, setGroup] = React.useState(null);
  const [publishing, setPublishing] = React.useState(false);

  const load = React.useCallback(async () => {
    const result = await apiJson(`${API_BASE}/api/market`, {fresh: true}).catch(() => null);
    if (!result) return setState({plugins: null, error: 'Could not reach the API server'});
    return setState(result.ok
      ? {plugins: result.data.plugins, error: null}
      : {plugins: null, error: result.data.error || `Could not load the marketplace (${result.status})`});
  }, []);
  React.useEffect(() => { load(); }, [load]);

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
  const authors = [...new Map(plugins.map(plugin => [authorOf(plugin).id, authorOf(plugin)])).values()];
  const groups = [...new Set(plugins.map(plugin => plugin.group))].sort();
  const needle = query.trim().toLowerCase();
  const shown = plugins.filter(plugin => (!by || authorOf(plugin).id === by)
    && (!group || plugin.group === group)
    && (!needle || [plugin.name, plugin.product.tagline, plugin.product.summary, authorOf(plugin).name]
      .some(text => text.toLowerCase().includes(needle))));
  const open = plugins.find(plugin => plugin.id === openId);
  const shelf = by && authors.find(author => author.id === by);

  if (open) {
    return (
      <main className={styles.page}>
        <Detail
          plugin={open}
          onBack={() => navigate({plugin: null})}
          onAuthor={author => navigate({plugin: null, by: author})}
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
        <div>
          <h1>Marketplace</h1>
          <p>Plugins for NanoAgent: download one, or publish your own from GitHub.</p>
        </div>
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
        <select className={styles.select} value={by ?? ''} onChange={event => navigate({by: event.target.value})}>
          <option value="">Every author</option>
          {authors.map(author => <option key={author.id} value={author.id}>{author.name}</option>)}
        </select>
      </div>
      <div className={styles.chips} role="group" aria-label="Plugin group">
        {[null, ...groups].map(name => (
          <button
            key={name ?? 'all'}
            type="button"
            className={`${styles.chip} ${group === name ? styles.chipActive : ''}`}
            onClick={() => setGroup(name)}
          >
            {name ?? 'All'}
          </button>
        ))}
      </div>

      {shelf && <h2 className={styles.shelf}>Plugins by {shelf.name}</h2>}
      {state.error && <div className={styles.error}>{state.error}</div>}
      {state.plugins && !shown.length && <p className={styles.empty}>No plugins match.</p>}
      <div className={styles.grid}>
        {shown.map(plugin => <Tile key={plugin.id} plugin={plugin} onOpen={chosen => navigate({plugin: chosen.id})} />)}
      </div>
    </main>
  );
}

export default function MarketplacePage() {
  return (
    <Layout title="Marketplace" description="NanoAgent plugins to download and share">
      <BrowserOnly fallback={<div style={{padding: 40, textAlign: 'center'}}>Loading...</div>}>
        {() => <ErrorBoundary><Marketplace /></ErrorBoundary>}
      </BrowserOnly>
    </Layout>
  );
}
