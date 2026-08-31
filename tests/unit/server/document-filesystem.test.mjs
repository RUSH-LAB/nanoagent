import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {createRequire} from 'node:module';
import {makeCtx, mockFs, PROJECT_ROOT, TEST_ORG_ID} from '../_harness.mjs';

const require = createRequire(import.meta.url);
const {createDocumentFilesystem, normalizeRelative} = require('../../../src/server/document-filesystem.js');

const root = path.join(PROJECT_ROOT, 'content', 'mochi');
const context = {workspaceId: TEST_ORG_ID, userId: 'test-user'};
const scope = context;

describe('database-backed content filesystem facade', () => {
  it('supports the synchronous read traversal used by legacy analysis routes', () => {
    const ctx = makeCtx();
    ctx.documents.create(scope, {path: 'books/math/a.md', markdown: '# A'});
    ctx.documents.create(scope, {path: 'books/b.md', markdown: '# B'});
    const files = createDocumentFilesystem({files: mockFs(), documents: ctx.documents, context, root});

    assert.equal(files.existsSync(root), true);
    assert.deepEqual(files.readdirSync(root), ['books']);
    const books = files.readdirSync(path.join(root, 'books'), {withFileTypes: true});
    assert.deepEqual(books.map(entry => [entry.name, entry.isDirectory()]), [['b.md', false], ['math', true]]);
    assert.equal(files.readFileSync(path.join(root, 'books/math/a.md'), 'utf-8'), '# A');
    assert.equal(files.readFileSync(path.join(root, 'content/books/math/a.md'), 'utf-8'), '# A');
    assert.equal(files.statSync(path.join(root, 'books/math/a.md')).size, 3);
  });

  it('cannot see another workspace through the same path', () => {
    const ctx = makeCtx();
    ctx.documents.create({workspaceId: 'other', userId: 'test-user'}, {path: 'secret.md', markdown: 'secret'});
    const files = createDocumentFilesystem({files: mockFs(), documents: ctx.documents, context, root});
    assert.equal(files.existsSync(path.join(root, 'secret.md')), false);
    assert.throws(() => files.readFileSync(path.join(root, 'secret.md'), 'utf-8'), error => error.code === 'ENOENT');
  });

  it('delegates non-content paths and refuses content mutations', () => {
    const outside = path.join(PROJECT_ROOT, 'var', 'state.json');
    const base = mockFs({[outside]: '{}'});
    const files = createDocumentFilesystem({files: base, documents: makeCtx().documents, context, root});
    assert.equal(files.readFileSync(outside, 'utf-8'), '{}');
    assert.throws(() => files.writeFileSync(path.join(root, 'a.md'), 'x'), /read-only/);
  });

  it('recognizes only paths contained by the configured content root', () => {
    assert.equal(normalizeRelative(root, path.join(root, 'a.md')), 'a.md');
    assert.equal(normalizeRelative(root, root), '');
    assert.equal(normalizeRelative(root, path.join(PROJECT_ROOT, 'content', 'other', 'a.md')), null);
  });
});
