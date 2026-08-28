import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// Characterization test for the SUCCESS (200) path of the POST /api/files/merge
// handler in server/routes/content-analysis-a.js (the handler begins at line 1023;
// the success return is at line 1048). The sibling suite
// tests/next-files-merge-guards.test.mjs covers ONLY the rejected guard branches:
// its mocked fs.readFileSync deliberately throws and every case asserts
// writeCount === 0, so the entire success transform (the merged content written to
// disk, the word count, the cache invalidation) is a genuine 0-hit. This file
// pins that transform.
//
// The goldens below were captured from the REAL handler (a throwaway probe ran the
// handler over each fixture with the mocked ctx and dumped the written content,
// the returned mergedWordCount, and the targetPath echo). They are spliced in
// verbatim, never hand-computed: the strip pipeline and the separator construction
// are easy to get subtly wrong. No source file is modified; the handler is loaded
// read-only and exercised through the same ctx harness as the sibling suite.
const require = createRequire(import.meta.url);
const routes = require('../../../../../src/server/routes/content-analysis-a.js');

const PROJECT_ROOT = '/fake/root';

// Drive the POST /api/files/merge success path through the real handler. The
// handler reads exactly two files (sourcePath then targetPath) via
// fs.readFileSync, so the mocked fs.readFileSync is keyed by the absolute path
// path.join(PROJECT_ROOT, relPath) and returns the fixture source then target
// content; it never walks a directory. fs.writeFileSync captures every (path,
// content) pair so the test can assert the exact merged bytes, and invalidateCache
// records each argument so the test can assert the single 'search' invalidation.
// rateLimit allows the request and isValidFilePath accepts every path, matching
// the sibling guard suite, so execution reaches the success transform.
async function invokeMergeSuccess({ body, sourceContent, targetContent }) {
  const pathname = '/api/files/merge';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  const files = {
    [path.join(PROJECT_ROOT, body.sourcePath)]: sourceContent,
    [path.join(PROJECT_ROOT, body.targetPath)]: targetContent,
  };
  let captured = null;
  const writes = [];
  const invalidations = [];
  const ctx = {
    path,
    PROJECT_ROOT,
    rateLimit: () => true,
    isValidFilePath: () => true,
    readBody: async () => body,
    fs: {
      readFileSync: (p) => {
        if (p in files) return files[p];
        throw new Error(`unexpected read: ${p}`);
      },
      writeFileSync: (p, content) => { writes.push({ path: p, content }); },
    },
    invalidateCache: (arg) => { invalidations.push(arg); },
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await routes(req, res, url, pathname, ctx);
  return { captured, writes, invalidations };
}

// Shared success assertions: a 200 response, exactly one write to
// PROJECT_ROOT/targetPath carrying the golden merged bytes, exactly one
// invalidateCache('search'), and a body echoing targetPath with the golden
// mergedWordCount. Every field is checked against a captured golden, so no
// assertion is vacuous.
function assertMergeSuccess({ captured, writes, invalidations }, { targetPath, merged, mergedWordCount }) {
  assert.equal(captured.status, 200, 'a valid merge returns 200');
  assert.equal(writes.length, 1, 'the success path writes the target exactly once');
  assert.equal(writes[0].path, path.join(PROJECT_ROOT, targetPath), 'writes to PROJECT_ROOT/targetPath');
  assert.equal(writes[0].content, merged, 'writes the exact merged string');
  assert.deepEqual(captured.payload, { success: true, targetPath, mergedWordCount });
  assert.deepEqual(invalidations, ['search'], "invalidateCache('search') is called exactly once");
}

describe('POST /api/files/merge success body (golden merged output, captured from the real handler)', () => {
  it('strips frontmatter and carries the extracted, quote-stripped title into the default separator', async () => {
    const body = { sourcePath: 'content/notes/source-a.md', targetPath: 'content/notes/target-a.md' };
    const sourceContent = `---\ntitle: "Quarterly Review"\nauthor: Jane Doe\ntags: [report, q1]\n---\n# Quarterly Review\n\nThe first quarter exceeded expectations.\n\nRevenue grew by twenty percent.\n`;
    const targetContent = `# Existing Notes\n\nThese are the running notes for the project.\n`;
    const merged = "# Existing Notes\n\nThese are the running notes for the project.\n\n\n---\n\n## Quarterly Review\n\n# Quarterly Review\n\nThe first quarter exceeded expectations.\n\nRevenue grew by twenty percent.\n";

    const result = await invokeMergeSuccess({ body, sourceContent, targetContent });
    assertMergeSuccess(result, { targetPath: body.targetPath, merged, mergedWordCount: 28 });
    // Title-extraction arm: the quoted frontmatter title becomes the H2 heading
    // with the surrounding quotes removed, and the source frontmatter block itself
    // is dropped from the merged body.
    assert.ok(result.writes[0].content.includes('\n## Quarterly Review\n'), 'default separator carries the extracted title');
    assert.ok(!result.writes[0].content.includes('"Quarterly Review"'), 'the surrounding quotes are stripped from the title');
    assert.ok(!result.writes[0].content.includes('author: Jane Doe'), 'the source frontmatter is stripped from the body');
  });

  it('extracts an unquoted frontmatter title into the default separator', async () => {
    const body = { sourcePath: 'content/notes/source-e.md', targetPath: 'content/notes/target-e.md' };
    const sourceContent = `---\ntitle: Release Notes\nstatus: draft\n---\nThe release body text.\n`;
    const targetContent = `Base document.\n`;
    const merged = "Base document.\n\n\n---\n\n## Release Notes\n\nThe release body text.\n";

    const result = await invokeMergeSuccess({ body, sourceContent, targetContent });
    assertMergeSuccess(result, { targetPath: body.targetPath, merged, mergedWordCount: 10 });
    // Optional-quote arm, other half: the title has no surrounding quotes, so the
    // same regex extracts it unchanged into the heading.
    assert.ok(result.writes[0].content.includes('\n## Release Notes\n'), 'the unquoted title is used as the heading');
    assert.ok(!result.writes[0].content.includes('status: draft'), 'the source frontmatter is stripped from the body');
  });

  it('falls back to the "Merged Content" title when the frontmatter has no title line', async () => {
    const body = { sourcePath: 'content/notes/source-b.md', targetPath: 'content/notes/target-b.md' };
    const sourceContent = `---\nauthor: John Smith\ndate: 2026-01-15\n---\nSome body content without a title field.\n`;
    const targetContent = `Target body B.\n`;
    const merged = "Target body B.\n\n\n---\n\n## Merged Content\n\nSome body content without a title field.\n";

    const result = await invokeMergeSuccess({ body, sourceContent, targetContent });
    assertMergeSuccess(result, { targetPath: body.targetPath, merged, mergedWordCount: 14 });
    // Fallback arm: frontmatter is present (so the body is sliced past it) but it
    // carries no title line, so the default 'Merged Content' heading is used.
    assert.ok(result.writes[0].content.includes('\n## Merged Content\n'), 'the default title heading is used');
    assert.ok(!result.writes[0].content.includes('author: John Smith'), 'the source frontmatter is stripped from the body');
  });

  it('treats the whole source as the body when it has no frontmatter, defaulting the title', async () => {
    const body = { sourcePath: 'content/notes/source-c.md', targetPath: 'content/notes/target-c.md' };
    const sourceContent = `Just plain text with no frontmatter.\n\nA second paragraph here.\n`;
    const targetContent = `# Target C heading\n\nBody of target C.\n`;
    const merged = "# Target C heading\n\nBody of target C.\n\n\n---\n\n## Merged Content\n\nJust plain text with no frontmatter.\n\nA second paragraph here.\n";

    const result = await invokeMergeSuccess({ body, sourceContent, targetContent });
    assertMergeSuccess(result, { targetPath: body.targetPath, merged, mergedWordCount: 22 });
    // No-frontmatter arm: nothing is sliced, so the entire source content is
    // appended after the default-title separator.
    assert.ok(result.writes[0].content.includes('\n## Merged Content\n'), 'the default title heading is used');
    assert.ok(result.writes[0].content.includes('Just plain text with no frontmatter.\n\nA second paragraph here.\n'), 'the entire source is kept as the body');
  });

  it('uses a provided separator verbatim instead of the default title separator', async () => {
    const body = { sourcePath: 'content/notes/source-d.md', targetPath: 'content/notes/target-d.md', separator: '\n\n<!-- merged -->\n\n' };
    const sourceContent = `---\ntitle: "Appendix Notes"\n---\nAppendix body content.\n`;
    const targetContent = `Main document body.\n`;
    const merged = "Main document body.\n\n\n<!-- merged -->\n\nAppendix body content.\n";

    const result = await invokeMergeSuccess({ body, sourceContent, targetContent });
    assertMergeSuccess(result, { targetPath: body.targetPath, merged, mergedWordCount: 9 });
    // Provided-separator arm: the body separator is the supplied string, so the
    // default '## <title>' heading never appears even though the source had a title.
    assert.ok(result.writes[0].content.includes('\n\n<!-- merged -->\n\n'), 'the provided separator is used verbatim');
    assert.ok(!result.writes[0].content.includes('## Appendix Notes'), 'the default title separator is not used when one is provided');
  });
});
