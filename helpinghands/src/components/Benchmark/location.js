/** The screen the address names (`?view=new`, `?view=publish`, `?view=all`, `?run=`, `?attempt=`, `?compare=a,b`, `?runs=a,b`), so reloading opens it again. */

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const pairOf = text => {
  const pair = (text ?? '').split(',');
  return pair.length === 2 && pair.every(id => ID.test(id)) && pair[0] !== pair[1] ? pair : null;
};

/**
 * `{screen, run, runs, attempt, compare}`: `compare` (two attempts) before `attempt` before `runs` (two runs) before `run` before
 * the lists. A trace or an attempt comparison keeps the `run` or `runs` it was opened from, so Back returns there.
 */
export function screenOf(search) {
  const params = new URLSearchParams(search);
  const run = ID.test(params.get('run') ?? '') ? params.get('run') : null;
  const runs = pairOf(params.get('runs'));
  const attempt = ID.test(params.get('attempt') ?? '') ? params.get('attempt') : null;
  const compare = pairOf(params.get('compare'));
  const caseKey = runs ? params.get('case') : null;
  const selection = caseKey ? {caseKey} : {};
  if (compare) return {screen: 'compare', run, runs, attempt: null, compare, ...selection};
  if (attempt) return {screen: 'attempt', run, runs, attempt, compare: null, ...selection};
  if (runs) return {screen: 'compare-runs', run: null, runs, attempt: null, compare: null, ...selection};
  if (run) return {screen: 'run', run, runs: null, attempt: null, compare: null};
  const view = params.get('view');
  const initialSelection = view === 'new' && params.has('benchmark') ? {plugin: params.get('plugin'), benchmark: params.get('benchmark')} : undefined;
  if (initialSelection) return {screen: 'new', run: null, runs: null, attempt: null, compare: null, initialSelection};
  return {screen: view === 'new' || view === 'publish' || view === 'all' ? view : 'runs', run: null, runs: null, attempt: null, compare: null};
}

/** The search string for a screen: `{}` is the runs list, `{view: 'all'}` everyone's results, `{view: 'new'}` the form, `{view: 'publish'}` Create Plugin Benchmark. */
export function searchFor({view, run, runs, attempt, compare, plugin, benchmark, caseKey}) {
  const params = new URLSearchParams();
  if (view) params.set('view', view);
  if (run) params.set('run', run);
  if (runs) params.set('runs', runs);
  if (runs && caseKey) params.set('case', caseKey);
  if (attempt) params.set('attempt', attempt);
  if (compare) params.set('compare', compare);
  if (view === 'new' && benchmark) {
    if (plugin) params.set('plugin', plugin);
    params.set('benchmark', benchmark);
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}
