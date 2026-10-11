import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// src/utils/paths.js is CommonJS, alone in that directory, because the server
// requires it too; an ES module can name-import CommonJS, so this test reads it
// the same way the client does.
import { contentPathToUrl, displayDirPath, displayPagePath } from '../../../../src/utils/paths.js';

describe('contentPathToUrl (the one content-path to site-URL transform)', () => {
  // Every expectation below was checked against the real build output: each URL
  // has an index.html under build/. That is the only thing that makes this
  // transform correct, and it is not something the rules alone can tell you.
  //
  // Two rules, because the two plugins differ. The docs plugin uses a leading
  // `12-` only to order the sidebar and drops it from the route; the blog plugin
  // does not, and addresses a post by its frontmatter slug.
  for (const [source, url] of [
    ['content/books/programming/3-cuda-and-gpu/1-first-kernel.md', '/programming/cuda-and-gpu/first-kernel'],
    ['content/books/programming/0-intro.md', '/programming/intro'],
    ['content/books/programming/99-supplement/1-linux-and-shell.md', '/programming/supplement/linux-and-shell'],
    ['content/books/builder/how-to/index.md', '/builder/how-to'],
    ['content/books/math/0-intro.md', '/math/intro'],
    ['content/books/survey/intro.md', '/survey/intro'],
  ]) {
    it(`turns ${source} into ${url}`, () => assert.equal(contentPathToUrl(source), url));
  }

  it('strips the ordering prefix from every segment, not just the first', () => {
    assert.equal(
      contentPathToUrl('content/books/math/6-advanced-ml-math/2-measure.md'),
      '/math/advanced-ml-math/measure',
    );
  });

  // A post's address is its slug, which is nowhere in its path.
  it('addresses a post by its slug when the caller has read the frontmatter', () => {
    assert.equal(contentPathToUrl('content/posts/research/swarms.md', {slug: 'eisi'}), '/research/eisi');
  });

  it('falls back to the filename when no slug is known', () => {
    assert.equal(contentPathToUrl('content/posts/blog/how-to-research.md'), '/blog/how-to-research');
  });

  it('addresses a post directory as the directory', () => {
    assert.equal(
      contentPathToUrl('content/posts/research/compress-or-not-zeyu-2025/index.mdx'),
      '/research/compress-or-not-zeyu-2025',
    );
  });

  // A dated post is named 2026-01-01-title. Stripping digits the way the docs
  // plugin does would turn the year into a path segment.
  it('does not strip the ordering prefix from a post, whose date looks like one', () => {
    assert.equal(contentPathToUrl('content/posts/blog/2026-01-01-probe.md'), '/blog/2026-01-01-probe');
  });

  // The graph endpoint makes its node ids content-relative before sending them,
  // so both shapes arrive here and both have to work.
  it('accepts a path that has already lost its content/ prefix', () => {
    assert.equal(contentPathToUrl('books/math/0-intro.md'), '/math/intro');
    assert.equal(contentPathToUrl('posts/blog/hello.md'), '/blog/hello');
  });

  it('takes both .md and .mdx', () => {
    assert.equal(contentPathToUrl('content/books/builder/6-formal-proofs.mdx'), '/builder/formal-proofs');
  });

  // Backlinks produced /books/math/x and the mindmap page produced
  // /docs/books/math/x. Neither is a route this site serves.
  it('does not emit the dead /books or /docs prefixes the old copies emitted', () => {
    const url = contentPathToUrl('content/books/math/0-intro.md');
    assert.equal(url.startsWith('/books/'), false);
    assert.equal(url.startsWith('/docs/'), false);
  });

  it('leaves a path with no organising level alone', () => {
    assert.equal(contentPathToUrl('content/bibliography/notes.md'), '/bibliography/notes');
  });

  for (const empty of ['', null, undefined]) {
    it(`answers '' for ${JSON.stringify(empty)}, rather than a bare slash`, () => {
      assert.equal(contentPathToUrl(empty), '');
    });
  }
});

describe('displayDirPath (shared parent-directory label)', () => {
  it('strips the content/ prefix and drops the final segment', () => {
    assert.equal(displayDirPath('content/books/foo/bar.md'), 'books/foo');
  });

  it('returns the remainder unchanged when no directory separator is left', () => {
    // After stripping `content/`, `x.md` has no slash, so the final-segment
    // drop matches nothing and the remainder is returned as is.
    assert.equal(displayDirPath('content/x.md'), 'x.md');
  });

  it('drops the final segment even without a content/ prefix', () => {
    assert.equal(displayDirPath('posts/2024/hello.md'), 'posts/2024');
  });

  it('returns an empty string for empty, null, or undefined input', () => {
    assert.equal(displayDirPath(''), '');
    assert.equal(displayDirPath(null), '');
    assert.equal(displayDirPath(undefined), '');
  });

  // It is a label, not a URL, so it keeps both the organising level and the
  // ordering prefix that the URL transform drops.
  it('keeps books/ and posts/, which the URL transform removes', () => {
    assert.equal(displayDirPath('content/books/math/0-intro.md'), 'books/math');
    assert.equal(contentPathToUrl('content/books/math/0-intro.md'), '/math/intro');
  });
});

describe('displayPagePath (a file\'s identity, not a link)', () => {
  it('drops the content/ prefix and the extension, and nothing else', () => {
    assert.equal(displayPagePath('content/books/math/0-intro.md'), 'books/math/0-intro');
    assert.equal(displayPagePath('content/posts/blog/hello.mdx'), 'posts/blog/hello');
  });

  it('returns an empty string for empty input', () => {
    assert.equal(displayPagePath(''), '');
    assert.equal(displayPagePath(undefined), '');
  });
});
