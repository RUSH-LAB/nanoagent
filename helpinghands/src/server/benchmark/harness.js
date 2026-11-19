'use strict';

const fs = require('fs');
const path = require('path');
const Ajv2020 = require('ajv/dist/2020');
const {unzipSync} = require('fflate');
const yaml = require('js-yaml');
const {BenchmarkError} = require('./errors');

const MANIFEST = 'harness.yaml';
// harness.yaml is a few hundred bytes; the worker validates the rest of the ZIP's contents.
const MANIFEST_MAX_BYTES = 1024 * 1024;

// A copy of nanoagent/src/nanoagent/uploaded/uploaded-harness-v1.schema.json (a unit test keeps them equal), because the server ships without NanoAgent.
const schema = JSON.parse(fs.readFileSync(path.join(__dirname, 'uploaded-harness-v1.schema.json'), 'utf8'));
const validate = new Ajv2020({strict: false, allErrors: true}).compile({$schema: schema.$schema, $ref: '#/$defs/Manifest', $defs: schema.$defs});

// The reference harnesses NanoAgent ships (nanoagent/src/nanoagent/uploaded/reference_harnesses/<name>/; a unit test keeps this list equal to its folders).
// Their names are reserved: a member's own upload may not take one, and a reference ZIP reaches the server only through the reference route.
const REFERENCE_HARNESSES = Object.freeze(['claude-code', 'codex', 'dsh', 'hermes', 'nanoagent', 'pi', 'shell']);

/** The policy reference harness `name` works under: NanoAgent's the task's tools, every other harness the coding prompt. */
const referencePolicy = name => (name === 'nanoagent' ? 'task_tools' : 'coding');

const refused = (status, code, message) => new BenchmarkError(status, code, message);

/**
 * The harness a source ZIP declares: `{name, version, dialects}` from the `harness.yaml` at its root, validated against the `Manifest`
 * of the harness contract. 400 `invalid_zip`, `missing_manifest` or `invalid_manifest` otherwise.
 */
function harnessOf(data) {
  let size = null;
  let files;
  try {
    files = unzipSync(data, {filter: file => { if (file.name !== MANIFEST) return false; size = file.originalSize; return size <= MANIFEST_MAX_BYTES; }});
  } catch {
    throw refused(400, 'invalid_zip', 'The body is not a ZIP archive');
  }
  if (size === null) throw refused(400, 'missing_manifest', `${MANIFEST} is not at the root of the archive`);
  if (!files[MANIFEST]) throw refused(400, 'invalid_manifest', `${MANIFEST} may be ${MANIFEST_MAX_BYTES} bytes at most`);
  let manifest;
  try {
    manifest = yaml.load(new TextDecoder('utf-8', {fatal: true}).decode(files[MANIFEST]), {schema: yaml.JSON_SCHEMA});
  } catch (error) {
    throw refused(400, 'invalid_manifest', `${MANIFEST} is not valid YAML: ${error.message}`);
  }
  if (!validate(manifest)) {
    throw refused(400, 'invalid_manifest', `${MANIFEST} is invalid: ${validate.errors.map(e => `${e.instancePath || '/'} ${e.message}`).join('; ')}`);
  }
  const {name, version, dialects} = manifest;
  return {name, version, dialects};
}

/** `harnessOf` of a member's own upload: 400 `reserved_harness_name` when the name is a reference harness's. */
function uploadedHarnessOf(data) {
  const harness = harnessOf(data);
  if (REFERENCE_HARNESSES.includes(harness.name)) throw refused(400, 'reserved_harness_name', `${harness.name} is a reference harness's name; give your harness another`);
  return harness;
}

/** 400 `unknown_reference` unless `name` is a reference harness's. */
function checkReference(name) {
  if (!REFERENCE_HARNESSES.includes(name)) throw refused(400, 'unknown_reference', `${name} is not a reference harness; they are ${REFERENCE_HARNESSES.join(', ')}`);
}

/** `harnessOf` of the ZIP of reference harness `name`: 400 `reference_name_mismatch` when its manifest names another harness. */
function referenceHarnessOf(data, name) {
  checkReference(name);
  const harness = harnessOf(data);
  if (harness.name !== name) throw refused(400, 'reference_name_mismatch', `The reference ${name}'s manifest names ${harness.name}`);
  return harness;
}

// What each reference harness is called: its agent's CLI command (a unit test keeps these equal to REFERENCE_HARNESSES).
const REFERENCE_LABELS = Object.freeze({
  'nanoagent': 'nanoagent', 'claude-code': 'claude', 'codex': 'codex', 'dsh': 'dsh', 'hermes': 'hermes', 'pi': 'pi', 'shell': 'shell',
});

module.exports = {REFERENCE_HARNESSES, REFERENCE_LABELS, checkReference, referencePolicy, harnessOf, referenceHarnessOf, uploadedHarnessOf};
