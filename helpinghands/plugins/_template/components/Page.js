import React from 'react';
import Layout from '@theme/Layout';
import { usePluginData } from '@docusaurus/useGlobalData';

const pluginFetch = (path, init = {}) => fetch(path, {...init, credentials: 'include'});

/**
 * __TITLE__: the page the command opens.
 *
 * The plugin owns its pages. They live here rather than in src/pages, so the
 * whole tool is one directory, and index.js routes them with addRoute.
 *
 * Build-time data arrives through usePluginData, keyed by the plugin name.
 * Anything live comes from the plugin's own endpoints through apiFetch.
 */
export default function __CAMEL__Page() {
  const { itemCount = 0 } = usePluginData('__NAME__') ?? {};
  const [items, setItems] = React.useState(null);

  React.useEffect(() => {
    let cancelled = false;
    pluginFetch('/api/__NAME__/items')
      .then((res) => res.json())
      .then((data) => { if (!cancelled) setItems(data.items); })
      .catch(() => { if (!cancelled) setItems([]); });
    return () => { cancelled = true; };
  }, []);

  return (
    <Layout title="__TITLE__" description="One line about what this tool is for">
      <main className="container margin-vert--lg">
        <h1>__TITLE__</h1>
        <p>{itemCount} item(s) found at build time.</p>
        <p>{items === null ? 'Loading…' : `${items.length} item(s) from the API.`}</p>
      </main>
    </Layout>
  );
}
