import React from 'react';
import BrowserOnly from '@docusaurus/BrowserOnly';
import Link from '@docusaurus/Link';
import {useLocation} from '@docusaurus/router';
import clsx from 'clsx';
import Layout from '@theme/Layout';
import ErrorBoundary from '@site/src/components/ErrorBoundary';
import TwoColumnLayout from '@site/src/components/TwoColumnLayout';
import market from '@site/src/pages/marketplace/styles.module.css';
import MyBenchmarksView from '@site/src/components/Benchmarks/MyBenchmarksView';
import PublishView from '@site/src/components/Benchmarks/PublishView';
import RunView from '@site/src/components/Benchmarks/RunView';
// The Marketplace's sidebar, reused so the two read as one design.
import sidebar from '@site/src/components/BlogGroupSidebar/styles.module.css';
import pluginSidebar from '@site/src/components/PluginSidebar/styles.module.css';
import {SidebarFoot} from '@site/src/components/PluginSidebar';

/**
 * Benchmarks: the published benchmarks of the installed plugins, each with its page to run agents on it; the member's own runs and
 * their traces, one at a time or two side by side; and a new benchmark published from a case folder. Where the reader is lives in the URL: `?view=` the view.
 */

/** The sidebar's views; the first is the default. */
const VIEWS = [
  {id: 'browse', title: 'Benchmarks', View: RunView},
  {id: 'runs', title: 'Runs', View: MyBenchmarksView},
  {id: 'publish', title: 'New benchmark', View: PublishView, plus: true},
];

function BenchmarksSidebar({view, href, collapsed, onCollapse}) {
  return (
    <div className={clsx(sidebar.sidebar, collapsed && sidebar.sidebarHidden)}>
      <nav className={clsx('menu thin-scrollbar', sidebar.menu)} aria-label="Benchmarks">
        <ul className="menu__list">
          {VIEWS.filter(item => !item.plus).map(item => (
            <li className="menu__list-item" key={item.id}>
              <Link className={clsx('menu__link', sidebar.categoryLink, item.id === view.id && 'menu__link--active')} to={href(item)}>
                <span className={sidebar.taxonomyTitle}>{item.title}</span>
              </Link>
            </li>
          ))}
          {VIEWS.filter(item => item.plus).map(item => (
            <li className="menu__list-item" key={item.id}>
              <Link className={clsx('menu__link', sidebar.categoryLink, pluginSidebar.marketplace, item.id === view.id && 'menu__link--active')} to={href(item)}>
                <svg className={pluginSidebar.plus} viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10" /></svg>
                <span className={sidebar.taxonomyTitle}>{item.title}</span>
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <SidebarFoot label="Collapse benchmarks navigation" onCollapse={onCollapse} />
    </div>
  );
}

function Benchmarks() {
  const location = useLocation();
  const viewId = new URLSearchParams(location.search).get('view');
  const view = viewId === null ? VIEWS[0] : VIEWS.find(item => item.id === viewId);
  const href = item => (item.id === VIEWS[0].id ? location.pathname : `${location.pathname}?view=${item.id}`);
  return (
    <TwoColumnLayout
      sidebarKey="benchmarks"
      evenGutters
      renderSidebar={({collapsed, onCollapse}) => <BenchmarksSidebar view={view ?? {}} href={href} collapsed={collapsed} onCollapse={onCollapse} />}
    >
      {view ? <view.View key={view.id} /> : <div className={market.error} role="alert">There is no Benchmarks view &quot;{viewId}&quot;. Pick one from the sidebar.</div>}
    </TwoColumnLayout>
  );
}

/** The page's title and description, for its Layout here and in the shell (components/Shell/registry.js). */
export const page = {title: 'Benchmarks', description: 'Publish benchmarks, run harnesses on them and read their traces'};

export function BenchmarksSection() {
  return (
    <BrowserOnly fallback={<div style={{padding: 40, textAlign: 'center'}}>Loading...</div>}>
      {() => <ErrorBoundary><Benchmarks /></ErrorBoundary>}
    </BrowserOnly>
  );
}

export default function BenchmarksPage() {
  return (
    <Layout {...page}>
      <BenchmarksSection />
    </Layout>
  );
}
