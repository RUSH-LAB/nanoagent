import React, {useEffect, useMemo, useRef, useState} from 'react';
import clsx from 'clsx';
import LoadingSkeleton from '@site/src/components/LoadingSkeleton';
import {formatMs} from './metrics';
import {EMPTY_FILTERS, ERROR_STATUSES, barOf, causalChain, distinct, filterRows, filtersActive, keepSelection, spanTiming, transcriptOf, waitsOf} from './traceModel';
import Inspector from './InspectorPanel';
import styles from './styles.module.css';
import traceStyles from './trace.module.css';

const KINDS = {
  phase: 'Phase', model_call: 'Model', proposal: 'Tool proposal',
  tool: 'Tool', command: 'Command', subagent: 'Subagent',
};
const kindLabel = kind => KINDS[kind] ?? kind.replaceAll('_', ' ');
const spanName = span => span.kind === 'command' && Array.isArray(span.attributes?.argv) ? span.attributes.argv.join(' ') : span.name;

function Chips({label, options, value, onChange}) {
  return (
    <div className={traceStyles.chips} role="group" aria-label={label}>
      {options.map(([id, text]) => (
        <button type="button" key={id} className={styles.chip} aria-pressed={id === value} onClick={() => onChange(id)}>{text}</button>
      ))}
    </div>
  );
}

function Filters({model, filters, onChange, timeline}) {
  const set = patch => onChange({...filters, ...patch});
  const kinds = distinct(timeline ? model : {spans: transcriptOf(model)}, 'kind');
  const scopes = distinct(model, 'scope');
  const sources = distinct(model, 'provenance');
  return (
    <div className={traceStyles.filters}>
      <div className={traceStyles.filterLine}>
        <input type="search" className={styles.searchInput} placeholder="Search actions" value={filters.q} onChange={event => set({q: event.target.value})} aria-label="Search actions" />
        <button type="button" className={styles.chip} aria-pressed={filters.errorsOnly} onClick={() => set({errorsOnly: !filters.errorsOnly})}>Errors only</button>
        {filtersActive(filters) && <button type="button" className={styles.link} onClick={() => onChange(EMPTY_FILTERS)}>Clear filters</button>}
      </div>
      {kinds.length > 0 && <Chips label="Action type" options={ [['', 'All types'], ...kinds.map(kind => [kind, kindLabel(kind)])] } value={filters.kind} onChange={kind => set({kind})} />}
      {(scopes.length > 1 || sources.length > 1) && (
        <details className={traceStyles.moreFilters} open={filters.scope || filters.provenance ? true : undefined}>
          <summary>More filters</summary>
          {scopes.length > 1 && (
            <div><span>Agent</span><Chips label="Agent" options={ [['', 'All agents'], ...scopes.map(scope => [scope, scope])] } value={filters.scope} onChange={scope => set({scope})} /></div>
          )}
          {sources.length > 1 && (
            <div><span>Evidence source</span><Chips label="Evidence source" options={ [['', 'All sources'], ...sources.map(source => [source, source.replaceAll('_', ' ')])] } value={filters.provenance} onChange={provenance => set({provenance})} /></div>
          )}
        </details>
      )}
    </div>
  );
}

function ActionRows({model, rows, waits, selectedId, chain, onSelect, timeline, scaleNs}) {
  const extent = Number(scaleNs) / 1e6;
  const ledger = useRef(null);
  const selectedRow = useRef(null);
  useEffect(() => {
    if (!selectedRow.current) return;
    const view = ledger.current.getBoundingClientRect();
    const row = selectedRow.current.getBoundingClientRect();
    if (row.top < view.top) ledger.current.scrollTop += row.top - view.top;
    else if (row.bottom > view.bottom) ledger.current.scrollTop += row.bottom - view.bottom;
  }, [selectedId, timeline]);
  return (
    <>
      {timeline && <div className={traceStyles.scale}>
        <span>Time since first event</span>
        <span className={traceStyles.timingColumn}>
          <span className={traceStyles.rulerTicks}><span>0 ms</span><span>{formatMs(extent)}</span></span>
          <span>Duration</span>
        </span>
      </div>}
      <div ref={ledger} className={traceStyles.ledger}>
        <ul className={traceStyles.actionList} aria-label={timeline ? 'Timeline' : 'Recorded actions'}>
          {rows.map(({id, depth, span, context}) => {
            const timing = spanTiming(model, span);
            const bar = timeline ? barOf(model, span, scaleNs) : null;
            const error = ERROR_STATUSES.has(span.status);
            const label = kindLabel(span.kind);
            return (
              <li key={id}>
                <button type="button" ref={id === selectedId ? selectedRow : null} aria-pressed={id === selectedId}
                  className={clsx(traceStyles.action, timeline && traceStyles.timelineAction, {
                    [traceStyles.related]: chain.has(id), [traceStyles.context]: context,
                  })} onClick={() => onSelect(id)}>
                  <span className={traceStyles.actionBody} style={timeline ? {paddingInlineStart: `${Math.min(depth, 6) * 0.55}rem`} : undefined}>
                    <span className={traceStyles.actionKind}>
                      <span aria-hidden="true" className={traceStyles.dot} data-kind={span.kind} data-error={error} />
                      {label}
                      {error && <span className={traceStyles.failure}>{span.status}</span>}
                      {span.attributes?.adapted && <span>adapted</span>}
                      {span.provenance === 'harness_reported' && <span>harness reported</span>}
                    </span>
                    <strong title={spanName(span)}>{spanName(span)}</strong>
                  </span>
                  {timeline ? (
                    <span className={traceStyles.timingColumn}>
                      <span className={traceStyles.track} role="img" aria-label={timing ? `Starts at ${formatMs(timing.offset)}` : 'Start time unavailable'}>
                        {bar && <span className={clsx(styles.bar, {
                          [styles.upstream]: waits.upstream.has(id), [styles.overlap]: waits.overlapping.has(id),
                          [styles.errored]: error, [styles.reported]: span.provenance === 'harness_reported',
                        })} style={{left: `${Math.min(bar.left, 99.6)}%`, width: `${bar.width}%`}} />}
                      </span>
                      <span>{timing?.duration == null ? '—' : formatMs(timing.duration)}</span>
                    </span>
                  ) : (
                    <span className={traceStyles.actionTime} title="Time since the first recorded event">
                      {timing ? <><span>+{formatMs(timing.offset)}</span>{timing.duration != null && <small>{formatMs(timing.duration)} elapsed</small>}</> : 'No timing'}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </>
  );
}

export default function TraceActivity({attemptId, model, loading, error, label = 'Trace activity', timelineOnly = false,
  scaleNs = model.window.end - model.window.start, selected, onSelect}) {
  const [localSelection, setLocalSelection] = useState(undefined);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [view, setView] = useState('timeline');
  const detailRef = useRef(null);
  const timeline = timelineOnly || view === 'timeline';
  const transcript = useMemo(() => transcriptOf(model), [model]);
  const waits = useMemo(() => waitsOf(model), [model]);
  const rows = useMemo(() => {
    const filtered = filterRows(model, filters);
    if (timeline) return filtered;
    const included = new Set(filtered.filter(row => !row.context).map(row => row.id));
    return transcript.filter(span => included.has(span.id)).map(span => ({id: span.id, span}));
  }, [model, filters, timeline, transcript]);
  const choice = onSelect ? selected : localSelection;
  const recordedChoice = keepSelection(model, choice);
  const firstAction = transcript[0]?.id;
  const selectedId = choice === null ? null : rows.find(row => row.id === recordedChoice)?.id ??
    rows.find(row => !row.context && row.id === firstAction)?.id ?? rows.find(row => !row.context)?.id;
  const inspectedId = onSelect && recordedChoice ? recordedChoice : selectedId;
  const chain = useMemo(() => inspectedId ? causalChain(model, inspectedId) : new Set(), [model, inspectedId]);

  const selectAction = id => {
    if (onSelect) onSelect(id);
    else setLocalSelection(id);
    if (!timelineOnly && window.matchMedia('(max-width: 850px)').matches) detailRef.current.focus();
  };
  const followLink = id => {
    if (!rows.some(row => row.id === id)) {
      setFilters(EMPTY_FILTERS);
      setView('timeline');
    }
    selectAction(id);
  };
  const renderFilters = <Filters model={model} filters={filters} onChange={setFilters} timeline={timeline} />;

  return (
    <div className={timelineOnly ? traceStyles.comparisonPane : traceStyles.panes}>
      <section className={traceStyles.activity} aria-label={label}>
        <div className={traceStyles.panelHeader}>
          <h3 className={styles.sectionHeading}>{label}</h3>
          {!timelineOnly && <Chips label="Trace view" options={ [['timeline', 'Timeline'], ['actions', 'Actions']] } value={view} onChange={next => {
            setLocalSelection(selectedId);
            if (next === 'actions' && filters.kind && !transcript.some(span => span.kind === filters.kind)) setFilters({...filters, kind: ''});
            setView(next);
          }} />}
        </div>
        {timelineOnly ? <details className={traceStyles.comparisonFilters}><summary>Filter events</summary>{renderFilters}</details> : renderFilters}
        {error ? <p className={styles.error} role="alert">{error}</p> : loading ? <LoadingSkeleton shape="block" height={120} /> : rows.length > 0 ? (
          <ActionRows model={model} rows={rows} waits={waits} selectedId={inspectedId} chain={chain} onSelect={selectAction} timeline={timeline} scaleNs={scaleNs} />
        ) : (
          <div className={traceStyles.empty}>
            <p>{filtersActive(filters) ? 'No events match these filters.' : timeline ? 'No trace events have been recorded.' : 'No model calls, tools, or commands have been recorded.'}</p>
            {!timeline && model.rows.length > 0 && <button type="button" className={styles.secondaryButton} onClick={() => setView('timeline')}>View timeline</button>}
          </div>
        )}
      </section>
      {!loading && !error && <div ref={detailRef} tabIndex={-1} className={traceStyles.detailPane}>
        <Inspector key={inspectedId} attemptId={attemptId} model={model} span={model.byId.get(inspectedId)} waits={waits} onSelect={followLink} />
      </div>}
    </div>
  );
}
