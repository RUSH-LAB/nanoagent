import React from 'react';
import clsx from 'clsx';
import {useHistory, useLocation} from '@docusaurus/router';
import Link from '@docusaurus/Link';
import TwoColumnLayout from '@site/src/components/TwoColumnLayout';
import {SidebarFoot} from '@site/src/components/PluginSidebar';
import sidebar from '@site/src/components/BlogGroupSidebar/styles.module.css';
import pluginSidebar from '@site/src/components/PluginSidebar/styles.module.css';
import Compare from './CompareView';
import CompareRuns from './RunCompareView';
import AllResults from './AllResultsView';
import NewRun from './BatchRunForm';
import HarnessCompare from './HarnessCompareView';
import Publish from './PublishForm';
import {RunView, RunsList} from './RunsView';
import TraceView from './TraceView';
import {WorkerBanner, WorkerPanel} from './WorkerStatus';
import {screenOf, searchFor} from './location';
import styles from './styles.module.css';

/**
 * Publish plugin benchmarks, run a harness across them, compare harnesses and inspect individual runs and attempts.
 * The address holds the screen (./location.js).
 */
const VIEWS = [
  {id: 'new', label: 'Benchmark Your Harness'},
  {id: 'harnesses', label: 'Compare Harnesses'},
  {id: 'runs', label: 'Benchmark Results'},
];

// The two sub-tabs of Benchmark Results.
const RESULTS = [
  {id: 'runs', label: 'Your Benchmark Results'},
  {id: 'all', label: 'All Benchmark Results'},
];

export default function Benchmark() {
  const location = useLocation();
  const history = useHistory();
  const {screen, run, runs, attempt, compare, initialSelection, caseKey, fromHarness} = screenOf(location.search);
  const go = target => {
    history.push({...history.location, search: searchFor(target)});
    window.scrollTo(0, 0);
  };
  // Back from a trace or comparison opened from a run, or from a comparison of runs, returns there.
  const back = () => go(runs ? {runs: runs.join(','), caseKey, fromHarness} : run ? {run} : fromHarness ? {view: 'harnesses'} : {});

  const view = screen === 'new' || screen === 'publish' || screen === 'worker' || screen === 'harnesses' ? screen : 'runs';
  const results = screen === 'all' ? 'all' : 'runs';
  const href = id => `${location.pathname}${searchFor(id === 'runs' ? {} : {view: id})}`;
  return (
    <TwoColumnLayout sidebarKey="benchmark" evenGutters renderSidebar={({collapsed, onCollapse}) => (
      <div className={clsx(sidebar.sidebar, collapsed && sidebar.sidebarHidden)}>
        <nav className={clsx('menu thin-scrollbar', sidebar.menu)} aria-label="Benchmark">
          <ul className="menu__list">
            {VIEWS.map(item => (
              <li className="menu__list-item" key={item.id}>
                <Link className={clsx('menu__link', sidebar.categoryLink, item.id === view && 'menu__link--active')}
                  aria-current={item.id === view ? 'page' : undefined} to={href(item.id)}>
                  <span className={sidebar.taxonomyTitle}>{item.label}</span>
                </Link>
              </li>
            ))}
            <li className="menu__list-item">
              <Link className={clsx('menu__link', sidebar.categoryLink, pluginSidebar.marketplace, view === 'publish' && 'menu__link--active')} aria-current={view === 'publish' ? 'page' : undefined} to={href('publish')}>
                <svg className={pluginSidebar.plus} viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10" /></svg>
                <span className={sidebar.taxonomyTitle}>Create Plugin Benchmark</span>
              </Link>
            </li>
          </ul>
        </nav>
        <SidebarFoot label="Collapse benchmark navigation" onCollapse={onCollapse} />
      </div>
    )}>
    <div className={styles.page}>
      <nav className={styles.tabs} aria-label="Benchmark views">
        {VIEWS.map(item => (
          <Link key={item.id} to={href(item.id)} aria-current={item.id === view ? 'page' : undefined}
            className={clsx({[styles.active]: item.id === view})}>{item.label}</Link>
        ))}
        <Link to={href('publish')} className={clsx(pluginSidebar.marketplace, {[styles.active]: view === 'publish'})}>+ Create Plugin Benchmark</Link>
      </nav>
      {(screen === 'runs' || screen === 'all') && (
        <nav className={styles.subTabs} aria-label="Benchmark results">
          {RESULTS.map(item => (
            <Link key={item.id} to={href(item.id)} aria-current={item.id === results ? 'page' : undefined}
              className={clsx({[styles.active]: item.id === results})}>{item.label}</Link>
          ))}
        </nav>
      )}
      {(screen === 'new' || screen === 'publish') && <WorkerBanner />}
      {screen === 'worker' && <WorkerPanel />}
      {screen === 'new' && <NewRun key={location.search} go={go} initialSelection={initialSelection} />}
      {screen === 'publish' && <Publish go={go} />}
      {screen === 'harnesses' && <HarnessCompare go={go} />}
      {screen === 'runs' && <RunsList go={go} />}
      {screen === 'all' && <AllResults />}
      {screen === 'run' && <RunView key={run} runId={run} go={go} />}
      {screen === 'attempt' && <TraceView key={attempt} attemptId={attempt} onBack={back} backLabel={runs ? 'Run comparison' : run ? 'Run results' : 'All runs'} />}
      {screen === 'compare' && <Compare key={compare.join()} a={compare[0]} b={compare[1]} go={target => go({...target, run, runs: runs?.join(','), caseKey, fromHarness})} back={back} />}
      {screen === 'compare-runs' && <CompareRuns key={runs.join()} a={runs[0]} b={runs[1]} initialCaseKey={caseKey} go={target => go({...target, fromHarness})} onBack={fromHarness ? () => go({view: 'harnesses'}) : undefined} />}
    </div>
    </TwoColumnLayout>
  );
}
