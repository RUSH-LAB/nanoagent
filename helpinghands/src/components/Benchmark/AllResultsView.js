import React, {useState} from 'react';
import LoadingSkeleton from '@site/src/components/LoadingSkeleton';
import {benchmarkApi} from './api';
import {benchmarkCard} from './newRun';
import {benchmarksOf, pluginsOf, resultSections, versionsOf} from './results';
import useLoad, {usePoll} from './useLoad';
import CaseSetView from './CaseSetView';
import ChoiceList from './ChoiceList';
import RunSummaryCard from './RunSummaryCard';
import styles from './styles.module.css';
import cardStyles from './run-compare.module.css';

/** Everyone's runs of one benchmark, Coding and Task tools apart, each member's harness version together. Rows are not clickable yet. */
function BenchmarkResults({benchmarkId}) {
  const {data, error, loading, reload} = useLoad(() => benchmarkApi.allBenchmarkResults(benchmarkId), [benchmarkId]);
  usePoll(reload, 8000, true);
  if (error) return <p className={styles.error}>{error}</p>;
  if (loading && !data) return <LoadingSkeleton shape="block" height={120} />;
  return (
    <>
      <p className={styles.fieldHint}>Traces coming soon: for now these rows are summaries only.</p>
      {resultSections(data).map(section => (
        <section key={section.policy} className={cardStyles.policySection} aria-label={section.label}>
          <h3>{section.label}</h3>
          {!section.groups.length && <p className={styles.muted}>No {section.label} runs yet.</p>}
          {section.groups.map(group => (
            <div key={group.key} className={cardStyles.group}>
              <h4>{group.label}</h4>
              <div className={cardStyles.runGrid}>{group.runs.map(run => <RunSummaryCard key={run.run_id} run={run} />)}</div>
            </div>
          ))}
        </section>
      ))}
    </>
  );
}

/** All Benchmark Results: plugin, then plugin version, then benchmark, whoever published it; its case set and every member's runs follow. */
export default function AllResults() {
  const benchmarks = useLoad(() => benchmarkApi.allBenchmarks(), []);
  const [pluginId, setPluginId] = useState('');
  const [version, setVersion] = useState('');
  const [benchmarkId, setBenchmarkId] = useState('');
  const detail = useLoad(() => (benchmarkId ? benchmarkApi.benchmark(benchmarkId) : Promise.resolve(null)), [benchmarkId]);

  if (benchmarks.error) return <p className={styles.error}>{benchmarks.error}</p>;
  if (benchmarks.loading && !benchmarks.data) return <LoadingSkeleton shape="block" height={120} />;
  const all = benchmarks.data;
  if (!all.length) return <div className={styles.emptyState}><p>No benchmark is published yet. Publish one from Create Plugin Benchmark.</p></div>;
  const offered = benchmarksOf(all, pluginId, version);

  return (
    <div className={styles.newRun}>
      <section className={styles.section}>
        <h3 className={styles.sectionHeading}>Choose a benchmark</h3>
        <ChoiceList label="Plugin" options={pluginsOf(all).map(item => ({value: item.id, label: item.name, detail: `${item.id} · ${item.count} benchmark${item.count === 1 ? '' : 's'}`}))} value={pluginId} onChange={value => { setPluginId(value); setVersion(''); setBenchmarkId(''); }} searchPlaceholder="Search plugins" />
        {pluginId && <ChoiceList label="Plugin version" options={versionsOf(all, pluginId).map(item => ({value: item.version, label: `v${item.version}`, detail: `${item.count} benchmark${item.count === 1 ? '' : 's'}`}))} value={version} onChange={value => { setVersion(value); setBenchmarkId(''); }} />}
        {version && <ChoiceList label="Benchmark" options={offered.map(item => {
          const card = benchmarkCard(item);
          return {value: item.benchmark_id, label: card.name, detail: `${card.task} · by ${card.creator} · ${card.runs} · ${card.runners}`};
        })} value={benchmarkId} onChange={setBenchmarkId} searchPlaceholder="Search benchmarks" />}
      </section>
      {benchmarkId && <>
        {detail.error && <p className={styles.error}>{detail.error}</p>}
        {detail.data && <CaseSetView benchmark={detail.data} />}
        <BenchmarkResults benchmarkId={benchmarkId} />
      </>}
    </div>
  );
}
