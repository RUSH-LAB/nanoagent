/**
 * Content belongs to one workspace, and no request can say otherwise.
 *
 * The isolation here is structural rather than enforced. A request carries
 * `books/math/0-intro.md`; the organization comes from the verified session and
 * the server prepends its content root. There is no field in any request where
 * another workspace could be named, which is the same rule server/routes/chat.js
 * has followed since it was written, now extended to files.
 *
 * These tests drive the real route modules with two ctxs that differ only in
 * which content root they hand back, which is exactly what differs in
 * production between two signed-in people in two workspaces.
 */
import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {loadRoute, makeCtx, invoke, mockFs, PROJECT_ROOT} from '../../_harness.mjs';
import {isValidFilePath, resolveContentPath} from '../../../../src/server/server-utils.js';

const files = loadRoute('files');

const MOCHI = path.join(PROJECT_ROOT, 'content', 'mochi');
const HELLO = path.join(PROJECT_ROOT, 'content', 'hello-world');

/** A filesystem holding one book in each of two workspaces. */
const twoWorkspaces = () => mockFs({
  [path.join(MOCHI, 'books/math/0-intro.md')]: '# Mochi Lab maths',
  [path.join(MOCHI, 'posts/blog/hello.md')]: '# Mochi Lab blog',
  [path.join(HELLO, 'books/math/0-intro.md')]: '# Hello World maths',
});

/** A ctx that acts as `slug`, the way a session in that workspace would. */
const asWorkspace = (slug, fs) => makeCtx({
  fs,
  contentRootFor: () => path.join(PROJECT_ROOT, 'content', slug),
  orgSlugFor: () => slug,
});

describe('two workspaces reading the same path', () => {
  it('each get their own file', async () => {
    const fs = twoWorkspaces();
    const query = {path: 'books/math/0-intro.md'};

    const mochi = await invoke(files, {path: '/api/file', query, ctx: asWorkspace('mochi', fs)});
    const hello = await invoke(files, {path: '/api/file', query, ctx: asWorkspace('hello-world', fs)});

    assert.equal(mochi.payload.content, '# Mochi Lab maths');
    assert.equal(hello.payload.content, '# Hello World maths');
  });

  it('a write in one is not a write in the other', async () => {
    const fs = twoWorkspaces();
    const body = {path: 'books/math/0-intro.md', content: 'rewritten by Hello World'};

    const wrote = await invoke(files, {
      method: 'PUT', path: '/api/file', body, ctx: asWorkspace('hello-world', fs),
    });
    assert.equal(wrote.status, 200);

    assert.equal(fs._files.get(path.join(HELLO, 'books/math/0-intro.md')), 'rewritten by Hello World');
    assert.equal(fs._files.get(path.join(MOCHI, 'books/math/0-intro.md')), '# Mochi Lab maths',
      'the other workspace is untouched');
  });

  // The books and posts the site publishes are Mochi Lab's. A workspace created
  // yesterday should not find them in its file tree.
  it('an empty workspace lists nothing, while the primary one lists its books', async () => {
    const fs = twoWorkspaces();
    const empty = mockFs({[path.join(HELLO, 'books/.keep')]: ''});

    const mochi = await invoke(files, {path: '/api/files', ctx: asWorkspace('mochi', fs)});
    assert.deepEqual(mochi.payload.files.map(f => f.name).sort(), ['books', 'posts']);

    const hello = await invoke(files, {path: '/api/files', ctx: asWorkspace('hello-world', empty)});
    assert.deepEqual(hello.payload.files.flatMap(f => f.children ?? []), [],
      'a workspace with no pages has no pages');
  });

  it('lists paths relative to the workspace, which is what can be asked for again', async () => {
    const fs = twoWorkspaces();
    const listed = await invoke(files, {path: '/api/files', ctx: asWorkspace('mochi', fs)});
    const paths = [];
    (function collect(nodes) {
      for (const n of nodes) {
        paths.push(n.path);
        if (n.children) collect(n.children);
      }
    })(listed.payload.files);

    assert.ok(paths.includes(path.join('books', 'math', '0-intro.md')));
    assert.equal(paths.some(p => p.startsWith('content')), false,
      'no path carries the tree it came from');

    // And what came back is what the read endpoint accepts.
    const read = await invoke(files, {
      path: '/api/file',
      query: {path: path.join('books', 'math', '0-intro.md')},
      ctx: asWorkspace('mochi', fs),
    });
    assert.equal(read.status, 200);
  });

  it('deletes into its own corner of the trash', async () => {
    const fs = twoWorkspaces();
    const deleted = await invoke(files, {
      method: 'DELETE', path: '/api/file',
      query: {path: 'books/math/0-intro.md'},
      ctx: asWorkspace('hello-world', fs),
    });
    assert.equal(deleted.status, 200);
    assert.match(deleted.payload.trashPath, /^var\/trash\/hello-world\/books\/math\//);
    assert.equal(fs._files.has(path.join(MOCHI, 'books/math/0-intro.md')), true,
      'and leaves the other workspace its file');
  });
});

describe('naming another workspace', () => {
  // Every one of these is what somebody would try. None of them are a path this
  // API accepts, because the shape check rejects the escape and the resolver
  // rejects it again against the real root.
  for (const attempt of [
    '../hello-world/books/math/0-intro.md',
    '../../content/hello-world/books/math/0-intro.md',
    'books/../../hello-world/books/math/0-intro.md',
    '/fake/root/content/hello-world/books/math/0-intro.md',
    './../hello-world/books/math/0-intro.md',
  ]) {
    it(`is refused for ${attempt}`, async () => {
      const fs = twoWorkspaces();
      const r = await invoke(files, {
        path: '/api/file', query: {path: attempt}, ctx: asWorkspace('mochi', fs),
      });
      assert.equal(r.status, 400, 'refused before any read');
      assert.equal(r.payload.error, 'Invalid path');
    });
  }

  it('is refused on writes too, and writes nothing', async () => {
    const fs = twoWorkspaces();
    const before = fs._files.get(path.join(HELLO, 'books/math/0-intro.md'));
    const r = await invoke(files, {
      method: 'PUT', path: '/api/file',
      body: {path: '../hello-world/books/math/0-intro.md', content: 'stolen'},
      ctx: asWorkspace('mochi', fs),
    });
    assert.equal(r.status, 400);
    assert.equal(fs._files.get(path.join(HELLO, 'books/math/0-intro.md')), before);
  });
});

describe('the two halves of the boundary', () => {
  // isValidFilePath rejects the shape; resolveContentPath rejects the resolved
  // location. The second exists because a string can look fine and still not be
  // inside anything once resolved, and because one of them will eventually be
  // forgotten at a call site.
  for (const escape of [
    '../hello-world/x.md',
    'a/../../b.md',
    '/etc/passwd',
  ]) {
    it(`both halves reject ${escape}`, () => {
      assert.equal(isValidFilePath(escape), false, 'the shape check');
      assert.equal(resolveContentPath(MOCHI, escape), null, 'the resolved check');
    });
  }

  it('and both accept an ordinary path, so neither is refusing everything', () => {
    assert.equal(isValidFilePath('books/math/0-intro.md'), true);
    assert.equal(
      resolveContentPath(MOCHI, 'books/math/0-intro.md'),
      path.join(MOCHI, 'books/math/0-intro.md'),
    );
  });

  // The one that a prefix test would have let through: it never leaves the
  // string 'books/' at the front, and it still ends up two directories up.
  it('rejects an escape that begins with a legitimate-looking segment', () => {
    assert.equal(resolveContentPath(MOCHI, 'books/../../hello-world/books/x.md'), null);
  });
});
