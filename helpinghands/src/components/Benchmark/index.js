import React from 'react';
import clsx from 'clsx';
import {useHistory, useLocation} from '@docusaurus/router';
import Link from '@docusaurus/Link';
import TwoColumnLayout from '@site/src/components/TwoColumnLayout';
import {SidebarFoot} from '@site/src/components/PluginSidebar';
import sidebar from '@site/src/components/BlogGroupSidebar/styles.module.css';
import Compare from './CompareView';
import CompareRuns from './RunCompareView';
import AllResults from './AllResultsView';
import NewRun from './NewRunForm';
import Publish from './PublishForm';
import {RunView, RunsList} from './RunsView';
import TraceView from './TraceView';
import {WorkerBanner, WorkerPanel} from './WorkerStatus';
import {screenOf, searchFor} from './location';
import styles from './styles.module.css';

/**
 * RUSH Lab's Benchmark workflow: publish a benchmark for an installed plugin, run an uploaded harness on any published benchmark of it,
 * follow the run live, open any attempt's saved trace, compare two runs of one task verifier or two attempts of one pinned case, and read
 * everyone's results on a benchmark. The address holds the screen (./location.js).
 */
const VIEWS = [
  {id: 'publish', label: 'Create Plugin Benchmark'},
  {id: 'new', label: 'Benchmark Your Harness'},
  {id: 'runs', label: 'Benchmark Results'},
  {id: 'worker', label: 'Local Runner Health Check'},
];

// The two sub-tabs of Benchmark Results.
const RESULTS = [
  {id: 'runs', label: 'Your Benchmark Results'},
  {id: 'all', label: 'All Benchmark Results'},
];

export default function Benchmark() {
  const location = useLocation();
  const history = useHistory();
  const {screen, run, runs, attempt, compare, initialSelection, caseKey} = screenOf(location.search);
  const go = target => {
    history.push({...history.location, search: searchFor(target)});
    window.scrollTo(0, 0);
  };
  // Back from a trace or comparison opened from a run, or from a comparison of runs, returns there.
  const back = () => go(runs ? {runs, caseKey} : run ? {run} : {});

  const view = screen === 'new' || screen === 'publish' || screen === 'worker' ? screen : 'runs';
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
      </nav>
      {(screen === 'runs' || screen === 'all') && (
        <nav className={styles.subTabs} aria-label="Benchmark results">
          {RESULTS.map(item => (
            <Link key={item.id} to={href(item.id)} aria-current={item.id === results ? 'page' : undefined}
              className={clsx({[styles.active]: item.id === results})}>{item.label}</Link>
          ))}
        </nav>
      )}
      {screen !== 'worker' && <WorkerBanner />}
      {screen === 'worker' && <WorkerPanel />}
      {screen === 'new' && <NewRun key={location.search} go={go} initialSelection={initialSelection} />}
      {screen === 'publish' && <Publish go={go} />}
      {screen === 'runs' && <RunsList go={go} />}
      {screen === 'all' && <AllResults />}
      {screen === 'run' && <RunView key={run} runId={run} go={go} />}
      {screen === 'attempt' && <TraceView key={attempt} attemptId={attempt} onBack={back} backLabel={runs ? 'Run comparison' : run ? 'Run results' : 'All runs'} />}
      {screen === 'compare' && <Compare key={compare.join()} a={compare[0]} b={compare[1]} go={target => go({...target, run, runs, caseKey})} back={back} />}
      {screen === 'compare-runs' && <CompareRuns key={runs.join()} a={runs[0]} b={runs[1]} initialCaseKey={caseKey} go={go} />}
    </div>
    </TwoColumnLayout>
  );
}
