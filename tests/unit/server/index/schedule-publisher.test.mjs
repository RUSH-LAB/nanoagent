import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createRequire} from 'node:module';
import {migratedDatabase} from '../../_harness.mjs';
import {isValidFilePath} from '../../../../src/server/server-utils.js';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..', '..', '..', '..');
const SOURCE = readFileSync(path.join(REPO_ROOT, 'src/server/index.js'), 'utf-8');
const ORGS = [{id: 'org-lab'}, {id: 'org-course'}];
const CONTENT = 'posts/blog/scheduled.md';
const PAST = '2000-01-01T00:00:00.000Z';
const FUTURE = '2999-01-01T00:00:00.000Z';

function liftPublisher() {
  const lines = SOURCE.split('\n');
  const banner = lines.findIndex(line => line.includes('Scheduled publishing checker'));
  assert.ok(banner !== -1);
  const start = lines.findIndex((line, index) => index > banner && line.includes('setInterval(async () => {'));
  assert.ok(start !== -1);
  let depth = 0;
  let opened = false;
  let end = -1;
  for (let index = start; index < lines.length; index++) {
    for (const character of lines[index]) {
      if (character === '{') { depth++; opened = true; }
      else if (character === '}') depth--;
    }
    if (opened && depth === 0) { end = index; break; }
  }
  const body = lines.slice(start, end + 1).join('\n')
    .replace(/^(?:const scheduledPublishingTimer = )?setInterval\(/, 'return (')
    .replace(/,\s*60000\);\s*$/, ');');
  return new Function('org', 'store', 'isValidFilePath', 'invalidateCache', 'cacheKey', 'documents', 'console', body);
}

const publisherSource = liftPublisher();

async function harness({items = [], byOrg, documentsByOrg = {}} = {}) {
  const db = migratedDatabase();
  const store = require('../../../../src/server/store/index.js').createStore({db});
  let id = 0;
  const documents = require('../../../../src/server/documents.js').createDocuments({
    db, newId: () => `doc-${++id}`, now: () => '2026-08-31T12:00:00.000Z',
  });
  const scheduled = byOrg ?? {'org-lab': items};
  for (const [orgId, rows] of Object.entries(scheduled)) {
    for (const [index, row] of rows.entries()) {
      store.collection('schedule').put({workspaceId: orgId, userId: null}, row.id ?? `s${index}`, {
        createdBy: 'author', ...row,
      });
    }
  }
  for (const [orgId, rows] of Object.entries(documentsByOrg)) {
    for (const [documentPath, markdown] of Object.entries(rows)) {
      documents.create({workspaceId: orgId, userId: 'author'}, {path: documentPath, markdown});
    }
  }
  const saved = [];
  const collection = name => {
    const real = store.collection(name);
    return {...real, put: (scope, key, value) => { saved.push({scope, key, value}); return real.put(scope, key, value); }};
  };
  const invalidated = [];
  const logged = [];
  const run = publisherSource(
    {allOrganizations: () => ORGS}, {collection}, isValidFilePath,
    value => invalidated.push(value), (orgId, name) => `org:${orgId}:${name}`,
    documents, {log: (...args) => logged.push(args.join(' ')), error: (...args) => logged.push(args.join(' '))},
  );
  await run();
  return {
    saved, invalidated, logged,
    get: (workspaceId, documentPath) => documents.get({workspaceId, userId: 'author'}, documentPath),
  };
}

describe('the scheduled-publishing loop', () => {
  it('publishes a due database document and records its previous version', async () => {
    const result = await harness({
      items: [{path: CONTENT, publishAt: PAST, status: 'scheduled'}],
      documentsByOrg: {'org-lab': {[CONTENT]: '---\ndraft: true\n---\nbody\n'}},
    });
    assert.match(result.get('org-lab', CONTENT).markdown, /^draft: false$/m);
    assert.equal(result.saved[0].value.status, 'published');
    assert.ok(result.saved[0].value.publishedAt);
  });

  it('adds draft frontmatter when the document has none', async () => {
    const result = await harness({
      items: [{path: CONTENT, publishAt: PAST, status: 'scheduled'}],
      documentsByOrg: {'org-lab': {[CONTENT]: 'body\n'}},
    });
    assert.equal(result.get('org-lab', CONTENT).markdown, '---\ndraft: false\n---\nbody\n');
  });

  it('does not publish future or already-published items', async () => {
    const result = await harness({
      items: [
        {path: CONTENT, publishAt: FUTURE, status: 'scheduled'},
        {path: 'other.md', publishAt: PAST, status: 'published'},
      ],
      documentsByOrg: {'org-lab': {[CONTENT]: '---\ndraft: true\n---\n', 'other.md': '---\ndraft: true\n---\n'}},
    });
    assert.match(result.get('org-lab', CONTENT).markdown, /^draft: true$/m);
    assert.match(result.get('org-lab', 'other.md').markdown, /^draft: true$/m);
    assert.deepEqual(result.saved, []);
  });

  it('rejects unsafe paths before document access', async () => {
    const result = await harness({items: [{path: '../../etc/passwd', publishAt: PAST, status: 'scheduled'}]});
    assert.deepEqual(result.saved, []);
    assert.ok(result.logged.some(line => line.includes('Refusing')));
  });

  it('continues after a missing document and publishes a sibling', async () => {
    const result = await harness({
      items: [
        {path: 'missing.md', publishAt: PAST, status: 'scheduled'},
        {path: CONTENT, publishAt: PAST, status: 'scheduled'},
      ],
      documentsByOrg: {'org-lab': {[CONTENT]: '---\ndraft: true\n---\n'}},
    });
    assert.ok(result.logged.some(line => line.includes('file not found')));
    assert.equal(result.saved.length, 1);
  });

  it('isolates identical paths in different workspaces and invalidates only the publisher', async () => {
    const result = await harness({
      byOrg: {
        'org-lab': [{path: CONTENT, publishAt: PAST, status: 'scheduled'}],
        'org-course': [{path: CONTENT, publishAt: FUTURE, status: 'scheduled'}],
      },
      documentsByOrg: {
        'org-lab': {[CONTENT]: '---\ndraft: true\n---\nlab\n'},
        'org-course': {[CONTENT]: '---\ndraft: true\n---\ncourse\n'},
      },
    });
    assert.match(result.get('org-lab', CONTENT).markdown, /^draft: false$/m);
    assert.match(result.get('org-course', CONTENT).markdown, /^draft: true$/m);
    assert.deepEqual(result.invalidated, ['org:org-lab:']);
  });
});
