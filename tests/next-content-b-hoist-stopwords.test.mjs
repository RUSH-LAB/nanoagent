import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-b.js is CommonJS; load it the way the other route tests do.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/content-analysis-b.js');

const PROJECT_ROOT = '/proj';
const ALLOWED_EXTS = ['.md', '.mdx'];

// Build an in-memory fs stub from a map of `${rel-from-PROJECT_ROOT}: content`.
// Both handlers only touch readFileSync (page reads) and readdirSync (recursive
// content walk with {withFileTypes:true}); the stub returns entries shaped the
// way the walk expects and ignores the encoding / options argument.
function makeFs(fileMap) {
  const dirs = new Map(); // absDir -> Map<name, isDir>
  const fileContents = new Map(); // absFile -> content
  const ensureDir = absDir => { if (!dirs.has(absDir)) dirs.set(absDir, new Map()); };

  for (const [rel, content] of Object.entries(fileMap)) {
    const segs = rel.split('/');
    let cur = PROJECT_ROOT;
    for (let i = 0; i < segs.length; i++) {
      const isDir = i < segs.length - 1;
      ensureDir(cur);
      if (!dirs.get(cur).has(segs[i])) dirs.get(cur).set(segs[i], isDir);
      cur = path.join(cur, segs[i]);
    }
    fileContents.set(cur, content);
  }

  return {
    readdirSync(dir) {
      const entries = dirs.get(dir);
      if (!entries) { const e = new Error(`ENOENT: ${dir}`); e.code = 'ENOENT'; throw e; }
      return [...entries.entries()].map(([name, isDir]) => ({ name, isDirectory: () => isDir }));
    },
    readFileSync(fp) {
      if (fileContents.has(fp)) return fileContents.get(fp);
      const e = new Error(`ENOENT: ${fp}`); e.code = 'ENOENT'; throw e;
    },
  };
}

// Invoke a content-analysis-b route handler with a mocked ctx and capture the
// response the handler hands to `json(res, status, payload)`.
async function invoke({ pathname, search = '', ctx = {} }) {
  const url = new URL(`http://localhost${pathname}${search}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const fullCtx = {
    json(_res, status, payload) { captured = { status, payload }; res.writableEnded = true; return captured; },
    ...ctx,
  };
  await routes(req, res, url, pathname, fullCtx);
  return captured;
}

describe('GET /api/content-recommend (RECOMMEND_STOP_WORDS hoisted to module scope)', () => {
  // Read + bookmarked pages seed the interest vocabulary; the unread pages under
  // content/ are the recommendation candidates. This drives the full
  // /api/content-recommend keyword-overlap path end to end and pins its output, so
  // the hoist to RECOMMEND_STOP_WORDS stays behavior preserving. Note the recommend
  // interest filter is `w.length > 4 && !RECOMMEND_STOP_WORDS.has(w)`, and every
  // RECOMMEND_STOP_WORDS entry is four characters or fewer, so here the length gate
  // alone already drops them; the genuine stop-set exercise lives in the
  // content-similar case below, whose set holds length-5 words ("would", "other").
  const PROGRESS_FILE = path.join(PROJECT_ROOT, 'data', 'reading-progress.json');
  const BOOKMARKS_FILE = path.join(PROJECT_ROOT, 'data', 'bookmarks.json');
  const jsonStore = new Map([
    [PROGRESS_FILE, { default: { 'content/read1.md': {}, 'content/read2.md': {} } }],
    [BOOKMARKS_FILE, { bookmarks: [{ path: 'content/book1.md' }] }],
  ]);
  const FIXTURE = {
    'content/read1.md': 'neural networks architecture that this with from',
    'content/read2.md': 'neural networks training',
    'content/book1.md': 'neural transformer models',
    'content/cand-match.md': 'neural networks transformer models architecture training',
    'content/cand-stop.md': 'that this with from were have been',
    'content/cand-low.md': 'neural elephant giraffe dolphin',
  };
  const ctx = {
    fs: makeFs(FIXTURE),
    path,
    PROJECT_ROOT,
    ALLOWED_EXTS,
    isValidFilePath: () => true,
    loadJSON: p => jsonStore.get(p) || {},
    BOOKMARKS_FILE,
  };
  const callRecommend = () => invoke({ pathname: '/api/content-recommend', ctx });

  it('recommends the unread page that overlaps the read/bookmarked interests', async () => {
    const r = await callRecommend();
    assert.equal(r.status, 200);
    // cand-match shares all six interest words (neural, networks, architecture,
    // training, transformer, models), so its score is 6 and it leads the list.
    assert.deepEqual(r.payload.recommendations, [
      { path: 'content/cand-match.md', title: 'cand-match', relevanceScore: 6 },
    ]);
    assert.deepEqual(r.payload.basedOn, { pagesRead: 2, bookmarks: 1 });
  });

  it('excludes pages with no real keyword overlap', async () => {
    const r = await callRecommend();
    const paths = r.payload.recommendations.map(x => x.path);
    // cand-stop holds only short function words (four characters or fewer), so the
    // length > 4 gate drops them all; it never scores and stays out of the output.
    assert.ok(!paths.includes('content/cand-stop.md'), 'page without long keywords is not recommended');
    // cand-low shares a single real word (neural); below the score > 3 cutoff.
    assert.ok(!paths.includes('content/cand-low.md'), 'a single-word overlap stays below threshold');
  });
});

describe('GET /api/content-similar (SIMILAR_STOP_WORDS hoisted to module scope)', () => {
  // The source body mixes four content words with two length-5 stop words
  // ("would", "other"). Those two pass the length > 4 filter, so only
  // SIMILAR_STOP_WORDS removes them: with the set live the source keyword set has
  // size 4 and the top match scores 1.0; were the set dropped the size would be 6
  // and the same match would score 0.67. Asserting 1.0 proves the filter is live.
  const SOURCE_REL = 'content/source.md';
  const FIXTURE = {
    'content/source.md': '---\ntitle: Source\n---\nmachine learning networks algorithms would other\n',
    'content/related.md': '---\ntitle: Related\n---\nmachine learning networks algorithms applied\n',
    'content/sub/nested.md': '---\ntitle: Nested\n---\nmachine learning networks vocabulary\n',
    'content/stopwords.md': '---\ntitle: Stops\n---\nwould other this that with from\n',
    'content/unrelated.md': '---\ntitle: Unrelated\n---\nelephant giraffe dolphin ostrich\n',
  };
  const ctx = {
    fs: makeFs(FIXTURE),
    path,
    PROJECT_ROOT,
    ALLOWED_EXTS,
    isValidFilePath: () => true,
  };
  const callSimilar = search =>
    invoke({ pathname: '/api/content-similar', search: `?path=${SOURCE_REL}${search}`, ctx });

  it('ranks similar pages by keyword overlap with stop words filtered', async () => {
    const r = await callSimilar('');
    assert.equal(r.status, 200);
    // related shares all four source keywords (4/4 = 1.0); nested shares three
    // (3/4 = 0.75). The 1.0 score confirms "would"/"other" were dropped from the
    // source keyword set, keeping its size at 4 rather than 6.
    assert.deepEqual(r.payload.similar, [
      { path: 'content/related.md', title: 'Related', similarity: 1 },
      { path: 'content/sub/nested.md', title: 'Nested', similarity: 0.75 },
    ]);
    assert.equal(r.payload.total, 2);
  });

  it('does not surface the source, stop-word-only, or unrelated pages', async () => {
    const r = await callSimilar('');
    const paths = r.payload.similar.map(x => x.path);
    assert.ok(!paths.includes('content/source.md'), 'the queried file excludes itself');
    assert.ok(!paths.includes('content/stopwords.md'), 'a page of only stop words is not similar');
    assert.ok(!paths.includes('content/unrelated.md'), 'a page with no overlap is omitted');
  });

  it('returns 400 for an invalid path', async () => {
    const r = await invoke({
      pathname: '/api/content-similar',
      search: '?path=../etc/passwd',
      ctx: { ...ctx, isValidFilePath: () => false },
    });
    assert.equal(r.status, 400);
    assert.deepEqual(r.payload, { error: 'Invalid path' });
  });
});
