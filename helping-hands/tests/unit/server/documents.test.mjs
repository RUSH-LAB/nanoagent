/**
 * server/documents.js: which pages a caller can see, and what a save keeps.
 *
 * Content is the one thing in the product with a per-item visibility, so the
 * question here is not the one ./store answers. A store item is one person's or
 * the workspace's, decided per domain; a document is the workspace's by default
 * and can be made private, so "may this caller read it" is a predicate on the
 * row rather than a fact about the feature. That predicate is in SQL, and these
 * drive real SQL against a real throwaway database for the same reason the
 * store's own suite does: a stub of the query proves only that the author
 * believed the same thing twice.
 */
import {describe, it, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const DB_PATH = require.resolve('../../../src/server/db.js');
const DOCS_PATH = require.resolve('../../../src/server/documents.js');

let dir;
let documents;
let db;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mochi-docs-'));
  const saved = process.env.DATABASE_FILE;
  process.env.DATABASE_FILE = path.join(dir, 'docs.db');
  delete require.cache[DB_PATH];
  delete require.cache[DOCS_PATH];
  try {
    ({db} = require('../../../src/server/db.js'));
    documents = require('../../../src/server/documents.js');
  } finally {
    if (saved === undefined) delete process.env.DATABASE_FILE;
    else process.env.DATABASE_FILE = saved;
  }

  const at = '2026-01-01T00:00:00.000Z';
  const org = db.prepare('INSERT INTO organization (id,name,slug,createdAt) VALUES (?,?,?,?)');
  org.run('org-lab', 'The Lab', 'lab', at);
  org.run('org-course', 'The Course', 'course', at);
  const user = db.prepare(
    'INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,0,?,?)',
  );
  user.run('ada', 'Ada', 'ada@example.test', at, at);
  user.run('bob', 'Bob', 'bob@example.test', at, at);
});

after(() => {
  db?.close();
  fs.rmSync(dir, {recursive: true, force: true});
});

const adaLab = {workspaceId: 'org-lab', userId: 'ada'};
const bobLab = {workspaceId: 'org-lab', userId: 'bob'};
const adaCourse = {workspaceId: 'org-course', userId: 'ada'};

/** A path nothing else in this file uses, so cases cannot collide. */
let counter = 0;
const freshPath = () => `books/case-${counter++}.md`;

function thrown(run) {
  try {
    run();
  } catch (err) {
    return err;
  }
  return assert.fail('expected a throw, and nothing was thrown');
}

describe('the workspace boundary', () => {
  it('keeps the same path in two workspaces as two documents', () => {
    documents.create(adaLab, {path: 'shared.md', markdown: 'lab'});
    documents.create(adaCourse, {path: 'shared.md', markdown: 'course'});

    assert.equal(documents.get(adaLab, 'shared.md').markdown, 'lab');
    assert.equal(documents.get(adaCourse, 'shared.md').markdown, 'course');
  });

  it('does not list one workspace\'s documents in another', () => {
    const only = documents.list(adaCourse).filter(d => d.path === 'shared.md');
    assert.equal(only.length, 1, 'its own, and only its own');
  });

  it('lists only documents below a requested collection prefix', () => {
    documents.create(adaCourse, {path: 'posts/blog/a.md', markdown: 'A'});
    documents.create(adaCourse, {path: 'posts/research/b.md', markdown: 'B'});
    documents.create(adaCourse, {path: 'books/math/c.md', markdown: 'C'});
    assert.deepEqual(
      documents.list(adaCourse, {prefix: 'posts/blog'}).map(document => document.path),
      ['posts/blog/a.md'],
    );
    assert.deepEqual(
      documents.snapshot(adaCourse, {prefix: 'posts/research'}).map(document => document.path),
      ['posts/research/b.md'],
    );
  });

  it('refuses a caller with no workspace, with the status the API sends', () => {
    const err = thrown(() => documents.list({workspaceId: null, userId: 'ada'}));
    assert.equal(err.code, 'no-workspace');
    assert.equal(err.status, 409);
  });
});

describe('visibility', () => {
  it('shows an org-visible document to every member', () => {
    const p = freshPath();
    documents.create(adaLab, {path: p, markdown: 'everyone'});
    assert.equal(documents.get(bobLab, p).markdown, 'everyone');
  });

  it('hides a private document from everybody but its author', () => {
    const p = freshPath();
    documents.create(adaLab, {path: p, markdown: 'mine', visibility: 'private'});

    assert.ok(documents.get(adaLab, p), 'the author reads it');
    assert.equal(documents.get(bobLab, p), undefined, 'nobody else does');
    assert.equal(documents.list(bobLab).some(d => d.path === p), false, 'nor sees it listed');
  });

  it('does not let a private document be read by asking for its id instead', () => {
    const p = freshPath();
    const {id} = documents.create(adaLab, {path: p, markdown: 'mine', visibility: 'private'});
    assert.ok(documents.getById(adaLab, id));
    assert.equal(documents.getById(bobLab, id), undefined, 'the id is not a way around the predicate');
  });

  it('does not let a private document be written by somebody who cannot read it', () => {
    const p = freshPath();
    documents.create(adaLab, {path: p, markdown: 'mine', visibility: 'private'});
    assert.equal(documents.save(bobLab, p, 'yours'), undefined);
    assert.equal(documents.get(adaLab, p).markdown, 'mine', 'untouched');
  });

  it('does not let a private document be deleted by somebody who cannot read it', () => {
    const p = freshPath();
    documents.create(adaLab, {path: p, markdown: 'mine', visibility: 'private'});
    assert.equal(documents.remove(bobLab, p), false);
    assert.ok(documents.get(adaLab, p), 'still there');
  });

  it('lets its author publish it to the workspace', () => {
    const p = freshPath();
    documents.create(adaLab, {path: p, markdown: 'draft', visibility: 'private'});
    documents.setVisibility(adaLab, p, 'org');
    assert.ok(documents.get(bobLab, p), 'and then everybody can read it');
  });

  it('lets nobody else change who may read it', () => {
    const p = freshPath();
    documents.create(adaLab, {path: p, markdown: 'ours'});
    const err = thrown(() => documents.setVisibility(bobLab, p, 'private'));
    assert.equal(err.code, 'not-author');
    assert.equal(err.status, 403);
  });

  it('refuses a visibility that is not one of the two', () => {
    const p = freshPath();
    assert.throws(() => documents.create(adaLab, {path: p, visibility: 'world'}), TypeError);
  });
});

describe('paths', () => {
  it('normalizes the retired content/ root at the repository boundary', () => {
    const created = documents.create(adaLab, {path: 'content/posts/example.md', markdown: 'body'});
    assert.equal(created.path, 'posts/example.md');
    assert.equal(documents.get(adaLab, 'content/posts/example.md').path, 'posts/example.md');
    assert.equal(documents.get(adaLab, 'posts/example.md').markdown, 'body');
  });

  it('refuses one that climbs out of the workspace', () => {
    for (const bad of ['../secrets.md', 'a/../../b.md', '/etc/passwd', 'a\\b.md', '']) {
      assert.throws(() => documents.create(adaLab, {path: bad}), TypeError, JSON.stringify(bad));
    }
  });

  it('refuses a second document at a path that is taken', () => {
    const p = freshPath();
    documents.create(adaLab, {path: p});
    const err = thrown(() => documents.create(adaLab, {path: p}));
    assert.equal(err.code, 'path-taken');
    assert.equal(err.status, 409);
  });

  // A create that succeeded because it could not see the private document
  // already there would fail on the unique index a moment later, with a worse
  // message. The taken check is deliberately not visibility-scoped.
  it('refuses a path held by a private document it cannot see', () => {
    const p = freshPath();
    documents.create(adaLab, {path: p, visibility: 'private'});
    const err = thrown(() => documents.create(bobLab, {path: p}));
    assert.equal(err.code, 'path-taken');
  });

  it('frees the path when the document is deleted', () => {
    const p = freshPath();
    documents.create(adaLab, {path: p, markdown: 'first'});
    assert.equal(documents.remove(adaLab, p), true);
    assert.equal(documents.get(adaLab, p), undefined);
    assert.equal(documents.create(adaLab, {path: p, markdown: 'second'}).path, p);
  });

  it('moves a document, refusing a destination that is taken', () => {
    const from = freshPath();
    const to = freshPath();
    documents.create(adaLab, {path: from, markdown: 'x'});
    documents.create(adaLab, {path: to, markdown: 'y'});
    assert.equal(thrown(() => documents.move(adaLab, from, to)).code, 'path-taken');

    const free = freshPath();
    assert.equal(documents.move(adaLab, from, free).path, free);
    assert.equal(documents.get(adaLab, from), undefined);
    assert.equal(documents.get(adaLab, free).markdown, 'x');
  });
});

describe('titles', () => {
  it('take the frontmatter title when there is one', () => {
    const p = freshPath();
    documents.create(adaLab, {path: p, markdown: '---\ntitle: A Real Title\n---\nbody'});
    assert.equal(documents.get(adaLab, p).title, 'A Real Title');
  });

  it('fall back to the filename without its extension', () => {
    documents.create(adaLab, {path: 'books/no-frontmatter.md', markdown: 'just a body'});
    assert.equal(documents.get(adaLab, 'books/no-frontmatter.md').title, 'no-frontmatter');
  });

  it('use the first level-one heading before an index filename', () => {
    const p = `books/chapter-${counter++}/index.md`;
    documents.create(adaLab, {path: p, markdown: '# Human chapter title\n\nBody'});
    assert.equal(documents.get(adaLab, p).title, 'Human chapter title');
  });

  it('follow the body when it is saved over', () => {
    const p = freshPath();
    documents.create(adaLab, {path: p, markdown: '---\ntitle: Before\n---\n'});
    documents.save(adaLab, p, '---\ntitle: After\n---\n');
    assert.equal(documents.get(adaLab, p).title, 'After');
  });
});

describe('history', () => {
  it('rejects a save based on a stale revision without creating history', () => {
    const p = freshPath();
    documents.create(adaLab, {path: p, markdown: 'current'});
    const err = thrown(() => documents.save(adaLab, p, 'stale edit', {
      expectedUpdatedAt: '2000-01-01T00:00:00.000Z',
    }));
    assert.equal(err.code, 'document-conflict');
    assert.equal(err.status, 409);
    assert.equal(documents.get(adaLab, p).markdown, 'current');
    assert.deepEqual(documents.versions(adaLab, p), []);
  });

  it('keeps what each save replaced, newest first', () => {
    const p = freshPath();
    documents.create(adaLab, {path: p, markdown: 'one'});
    documents.save(adaLab, p, 'two');
    documents.save(adaLab, p, 'three');

    const history = documents.versions(adaLab, p);
    assert.deepEqual(history.map(v => v.seq), [2, 1]);
    assert.equal(documents.get(adaLab, p).markdown, 'three', 'the live one is the newest');
    assert.equal(documents.version(adaLab, p, 1).markdown, 'one', 'and the first is still there');
    assert.equal(documents.version(adaLab, p, 2).markdown, 'two');
  });

  it('records who saved it', () => {
    const p = freshPath();
    documents.create(adaLab, {path: p, markdown: 'one'});
    documents.save(bobLab, p, 'two');
    assert.equal(documents.versions(adaLab, p)[0].authorId, 'bob');
  });

  it('is not readable through a document the caller cannot read', () => {
    const p = freshPath();
    documents.create(adaLab, {path: p, markdown: 'one', visibility: 'private'});
    documents.save(adaLab, p, 'two');
    assert.equal(documents.versions(bobLab, p), undefined);
    assert.equal(documents.version(bobLab, p, 1), undefined);
  });

  it('goes with the document when it is deleted', () => {
    const p = freshPath();
    const {id} = documents.create(adaLab, {path: p, markdown: 'one'});
    documents.save(adaLab, p, 'two');
    db.prepare('DELETE FROM document WHERE id = ?').run(id);
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM document_version WHERE "documentId" = ?').get(id).n,
      0,
      'the cascade takes the history with it',
    );
  });
});

describe('what the database does when its subjects go', () => {
  it('keeps a document whose author is deleted, unattributed', () => {
    const at = '2026-01-01T00:00:00.000Z';
    db.prepare('INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,0,?,?)')
      .run('cleo', 'Cleo', 'cleo@example.test', at, at);
    const cleo = {workspaceId: 'org-lab', userId: 'cleo'};
    const p = freshPath();
    documents.create(cleo, {path: p, markdown: 'the lab documentation'});

    db.prepare('DELETE FROM "user" WHERE id = ?').run('cleo');

    const survived = documents.get(bobLab, p);
    assert.ok(survived, 'a page is the workspace\'s, not its author\'s');
    assert.equal(survived.createdBy, null, 'and is attributed to nobody rather than to somebody else');
  });

  it('takes every document when the workspace goes', () => {
    const at = '2026-01-01T00:00:00.000Z';
    db.prepare('INSERT INTO organization (id,name,slug,createdAt) VALUES (?,?,?,?)')
      .run('org-temp', 'Temp', 'temp', at);
    documents.create({workspaceId: 'org-temp', userId: 'ada'}, {path: 'a.md', markdown: 'x'});
    db.prepare('DELETE FROM organization WHERE id = ?').run('org-temp');
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM document WHERE "organizationId" = ?').get('org-temp').n,
      0,
    );
  });
});
