import {dump, load} from 'js-yaml';

/** What a picked case folder holds and what a failed publish says, both read without drawing anything. */

const YAML_FILE = /\.ya?ml$/i;
// What a folder picked on macOS holds that no case file or fixture means.
const NOISE = new Set(['.DS_Store']);

/**
 * The case file and the other files of a picked case folder, from the files' `webkitRelativePath`s (the folder's own name first, as the
 * picker gives them): `{caseFile, others}` where `caseFile` is the index of the one YAML file at the folder's top level and `others` is
 * every other file as `{index, path}`, `path` relative to the folder. `{error}` when the top level holds no YAML file or several.
 */
export function splitCaseFolder(paths) {
  const files = paths
    .map((path, index) => ({index, path: path.split('/').slice(1).join('/')}))
    .filter(one => one.path && !NOISE.has(one.path.split('/').pop()));
  const cases = files.filter(one => !one.path.includes('/') && YAML_FILE.test(one.path));
  if (!cases.length) return {error: 'The folder has no YAML case file (a .yaml or .yml file) at its top level.'};
  if (cases.length > 1) return {error: `The folder's top level holds ${cases.length} YAML files (${cases.map(one => one.path).join(', ')}): keep one case file there.`};
  return {caseFile: cases[0].index, others: files.filter(one => one !== cases[0])};
}

/** What a failed publish says, split: `{caseId, text}` for a message that names a case (`case p-02: ...`), else `{caseId: null, text}`. */
export function publishProblem(message) {
  const named = /^case (\S+): ([\s\S]*)$/.exec(message);
  return named ? {caseId: named[1], text: named[2]} : {caseId: null, text: message};
}

/** The name accepted by the publisher. */
export function validBenchmarkName(name) {
  return /^[a-z0-9][a-z0-9._-]{0,127}$/.test(name);
}

/** Parse the uploaded YAML into the cases shown before publication. */
export function previewCaseFile(text, plugin, paths) {
  let doc;
  try { doc = load(text); } catch (error) { throw new Error(`The case file is not valid YAML: ${error.message}`); }
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!object(doc)) throw new Error('The case file must be a YAML mapping.');
  const extra = Object.keys(doc).filter(key => !['plugin', 'task', 'cases', 'refuse'].includes(key));
  if (extra.length) throw new Error(`Unknown case file fields: ${extra.join(', ')}.`);
  if (doc.plugin !== plugin.id) throw new Error(`The cases are for ${String(doc.plugin)}, not ${plugin.id}.`);
  if (typeof doc.task !== 'string' || !plugin.tasks.some(task => task.id === doc.task)) throw new Error(`Unknown task: ${String(doc.task)}.`);
  if (!Array.isArray(doc.cases) || !Array.isArray(doc.refuse)) throw new Error('The case file must have cases and refuse lists.');
  const entries = [...doc.cases.map(item => [item, 'answer']), ...doc.refuse.map(item => [item, 'refuse'])];
  if (!entries.length) throw new Error('The case file has no cases.');
  const cases = entries.map(([item, kind], index) => {
    const id = `${doc.plugin}-${String(index + 1).padStart(2, '0')}`;
    if (!object(item)) throw new Error(`Case ${id} must be a mapping.`);
    const allowed = ['prompt', 'arguments', 'fixtures', ...(kind === 'refuse' ? ['reference_error'] : [])];
    const unknown = Object.keys(item).filter(key => !allowed.includes(key));
    if (unknown.length) throw new Error(`Case ${id} has unknown fields: ${unknown.join(', ')}.`);
    if (typeof item.prompt !== 'string' || !object(item.arguments)) throw new Error(`Case ${id} needs a prompt and an arguments mapping.`);
    if (kind === 'refuse' && typeof item.reference_error !== 'string') throw new Error(`Case ${id} needs reference_error.`);
    if (item.fixtures != null && typeof item.fixtures !== 'string') throw new Error(`Case ${id} fixtures must be a folder path.`);
    const fixtureFiles = item.fixtures == null ? [] : paths.filter(path => path.startsWith(`${item.fixtures}/`));
    if (item.fixtures != null && !fixtureFiles.length) throw new Error(`Case ${id}: fixture folder ${item.fixtures} has no uploaded files.`);
    return {case_id: id, kind, prompt: item.prompt, arguments: item.arguments, fixturePath: item.fixtures, fixtureFiles, expected_error: item.reference_error};
  });
  return {task: doc.task, cases};
}

/**
 * A published benchmark (GET benchmarks/{id}) back as the case file it was published from, to edit into a new version. A case's fixtures
 * are named `fixtures/<case id>`: the published benchmark keeps their files' digests, not the files, so they are put back by hand.
 */
export function caseFileOf(benchmark) {
  const entry = one => ({prompt: one.prompt, arguments: one.arguments, ...(one.fixtures ? {fixtures: `fixtures/${one.case_id}`} : {})});
  const withFixtures = benchmark.cases.filter(one => one.fixtures);
  const head = [`# ${benchmark.name}, published for ${benchmark.plugin.id} v${benchmark.plugin.version}. Edit the cases, then publish it under a new name.`,
    ...(withFixtures.length ? [`# Put each case's fixture files back in its folder: ${withFixtures.map(one => `fixtures/${one.case_id}`).join(', ')}.`] : [])];
  return `${head.join('\n')}\n${dump({
    plugin: benchmark.plugin.id,
    task: benchmark.task_id,
    cases: benchmark.cases.filter(one => one.kind === 'answer').map(entry),
    refuse: benchmark.cases.filter(one => one.kind === 'refuse').map(one => ({...entry(one), reference_error: one.expected_error})),
  }, {lineWidth: -1})}`;
}

/** The name a new version of benchmark `name` suggests: `name-v2`, or the next number after a `-vN` it ends with. */
export function nextVersionName(name) {
  const versioned = /^(.*)-v(\d+)$/.exec(name);
  return versioned ? `${versioned[1]}-v${Number(versioned[2]) + 1}` : `${name}-v2`;
}
