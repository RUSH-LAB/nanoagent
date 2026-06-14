import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// Characterization test for the inner transform of the GET /api/file/summary handler
// in server/routes/file-tools.js (handler near line 245, cached inner transform near
// line 254). The sibling tests/next-filetools-microcache.test.mjs already pins the
// cache mechanics (the filesummary: key prefix, the 30000 ms TTL, per-path keying, the
// 400 and 404 envelopes) and a deepEqual(viaCache, viaPre) that only proves the cache
// wrapper is transparent. It asserts ONLY payload.title and headings, so the summary
// text, wordCount, readingTime, the basename title FALLBACK, the paragraph filter, the
// heading-level cap, and the 10-heading cap are a genuine 0-hit. This file pins those
// exact current outputs with hand-crafted fixtures that each isolate one branch.
//
// It drives the REAL module via createRequire the way the sibling suites do, with a
// mocked ctx, a PASS-THROUGH cached (so the inner transform always runs, reproducing
// the pre-cache code path), and a mocked ctx.fs.readFileSync keyed by absolute path.
// No source file is modified; the goldens were captured from the real handler.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/file-tools.js');

const PROJECT_ROOT = '/proj';

// In-memory fs stub returning a single file's content keyed by its absolute path
// (PROJECT_ROOT joined with the request path), exactly as the sibling test does. A
// missing path throws ENOENT, like the real fs, so the closure throws and the outer
// catch returns 404.
function makeFs(absFileMap) {
  return {
    readFileSync(fp) {
      if (absFileMap.has(fp)) return absFileMap.get(fp);
      const e = new Error(`ENOENT: ${fp}`); e.code = 'ENOENT'; throw e;
    },
  };
}

// Pass-through cached(key, ttl, fn): always runs fn(), reproducing the exact pre-cache
// inner transform. The GOAL pins the transform's field values, not the cache wrapper,
// which the sibling suite already covers.
const passThroughCached = (_key, _ttl, fn) => fn();

// Invoke GET /api/file/summary with a mocked ctx and capture the json(res, status,
// payload) call. isValidFilePath defaults to accepting the path so the happy path
// reaches the file read. Pass content === undefined to leave the fs empty so the read
// throws ENOENT (the missing-file case).
async function invokeSummary(filePath, content, { isValidFilePath = () => true } = {}) {
  const abs = path.join(PROJECT_ROOT, filePath);
  const fileMap = content === undefined ? new Map() : new Map([[abs, content]]);
  const url = new URL(`http://localhost/api/file/summary?path=${encodeURIComponent(filePath)}`);
  const req = { method: 'GET' };
  const res = { writableEnded: false };
  let captured = null;
  const ctx = {
    fs: makeFs(fileMap),
    path,
    PROJECT_ROOT,
    isValidFilePath,
    cached: passThroughCached,
    json(_res, status, payload) { captured = { status, payload }; res.writableEnded = true; return captured; },
  };
  await routes(req, res, url, '/api/file/summary', ctx);
  return captured;
}

// ── Fixtures: each isolates one branch of the inner transform ──

// Frontmatter carries a title line, so payload.title is taken from it (not the basename).
const FX_FM_TITLE = ['---','title: Frontmatter Wins','---','','# Intro Heading','','This opening paragraph is comfortably longer than twenty characters for the summary.','','## Details Heading','','A second paragraph that also clears the twenty character minimum length requirement.'].join('\n');

// No frontmatter at all, so payload.title falls back to basename(path) minus extension.
const FX_NO_FM = ['# Just A Heading','','A standalone paragraph with no frontmatter that still exceeds twenty characters.'].join('\n');

// Frontmatter present but with NO title line, so payload.title still falls back to the
// basename (the title-line regex inside the frontmatter block finds nothing).
const FX_FM_NO_TITLE = ['---','tags: [alpha, beta]','draft: false','---','','# Body Heading','','This paragraph has enough length to pass the twenty character paragraph filter.'].join('\n');

// Paragraph filter. Built with array-join so the literal code fence can appear. Every
// non-qualifying paragraph carries a distinct ZZ-token so the negative assertions below
// map one-to-one to a filter:
//   - "Tiny."                              -> shorter than 21 chars, dropped by length
//   - "import ZZIMPORTLINE ..."            -> matches /import\s+.*$/gm, removed as a line
//   - the ```js ... ``` block (ZZCODEFENCE) -> removed by the fenced-code replace
//   - "<section ...>ZZHTMLTEXT</section>"  -> the <...> tags (ZZHTMLATTR) removed; the
//                                             residual text ZZHTMLTEXT is then dropped by length
//   - "importance ... ZZIMPORTPARA ..."    -> survives the line replace (no space after
//                                             "import"), but p.startsWith('import') drops it
//   - "## Heading marker ZZHEADMARK ..."   -> the leading "## " is stripped, the text SURVIVES
// so the summary is exactly the heading-marker paragraph (markers gone) joined to the
// final plain qualifying paragraph.
const FX_PARA_FILTER = ['---','title: Filter Demo','---','','Tiny.','',"import ZZIMPORTLINE from 'somewhere'",'','```js','const secret = "ZZCODEFENCE stays hidden";','```','','<section data-x="ZZHTMLATTR">ZZHTMLTEXT</section>','','importance ranks among ZZIMPORTPARA topics in this long line','','## Heading marker ZZHEADMARK is stripped yet the text survives well','','Second qualifying paragraph stays intact and well past twenty chars.'].join('\n');

// Headings: 12 level-1-to-3 headings plus one level-4 line, each on its own paragraph so
// the summary stays empty (every heading text is under 21 chars). Pins that the scan
//   - reads levels 1-3 only ("#### Level Four Out" is EXCLUDED),
//   - trims the captured text ("#   Trim Me Heading   " -> "Trim Me Heading"),
//   - caps the array at 10 ("Juliet11" 11th and "Kilo12" 12th are DROPPED).
const FX_HEADINGS = ['#   Trim Me Heading   ','','## Alpha','','### Bravo','','#### Level Four Out','','# Charlie','','## Delta','','### Echo','','# Foxtrot','','## Golf','','### Hotel','','# India','','## Juliet11','','### Kilo12'].join('\n');

// wordCount/readingTime: 250 space-separated tokens on one line. wordCount is
// content.split(/\s+/).filter(Boolean).length === 250 and readingTime is
// Math.ceil(250/200) === 2, crossing the 200-word boundary so readingTime exceeds 1.
const WC_WORDS = Array.from({ length: 250 }, (_, i) => 'word' + i).join(' ');

// Summary slice: two qualifying paragraphs whose join exceeds 300 chars. para1 is 179
// chars, so the 300-char summary is para1 + ' ' + the first 120 chars of para2, pinning
// both the single-space join and the 300-char truncation.
const SLICE_PARA1 = ('alpha '.repeat(30)).trim();
const SLICE_PARA2 = ('bravo '.repeat(30)).trim();
const FX_SLICE = [SLICE_PARA1, '', SLICE_PARA2].join('\n');

// ── Golden payloads captured from the real handler ──
// Short summaries are spliced verbatim; the two 300-char summaries are reconstructed
// from their fixture parts so a transcription slip cannot hide behind an opaque literal
// (the reconstruction also documents the exact join-and-slice rule).
const WC_EXPECTED_SUMMARY = WC_WORDS.slice(0, 300);
const SLICE_EXPECTED_SUMMARY = (SLICE_PARA1 + ' ' + SLICE_PARA2).slice(0, 300);

const GOLDENS = {
  FM_TITLE: {
    rel: 'content/fm-title.md', content: FX_FM_TITLE,
    payload: {
      title: 'Frontmatter Wins',
      summary: 'This opening paragraph is comfortably longer than twenty characters for the summary. A second paragraph that also clears the twenty character minimum length requirement.',
      headings: ['Intro Heading', 'Details Heading'],
      wordCount: 35,
      readingTime: 1,
    },
  },
  NO_FM: {
    rel: 'content/no-frontmatter.md', content: FX_NO_FM,
    payload: {
      title: 'no-frontmatter',
      summary: 'A standalone paragraph with no frontmatter that still exceeds twenty characters.',
      headings: ['Just A Heading'],
      wordCount: 15,
      readingTime: 1,
    },
  },
  FM_NO_TITLE: {
    rel: 'content/tags-only.md', content: FX_FM_NO_TITLE,
    payload: {
      title: 'tags-only',
      summary: 'This paragraph has enough length to pass the twenty character paragraph filter.',
      headings: ['Body Heading'],
      wordCount: 22,
      readingTime: 1,
    },
  },
  PARA_FILTER: {
    rel: 'content/para-filter.md', content: FX_PARA_FILTER,
    payload: {
      title: 'Filter Demo',
      summary: 'Heading marker ZZHEADMARK is stripped yet the text survives well Second qualifying paragraph stays intact and well past twenty chars.',
      headings: ['Heading marker ZZHEADMARK is stripped yet the text survives well'],
      wordCount: 50,
      readingTime: 1,
    },
  },
  HEADINGS: {
    rel: 'content/headings-cap.md', content: FX_HEADINGS,
    payload: {
      title: 'headings-cap',
      summary: '',
      headings: ['Trim Me Heading', 'Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'India'],
      wordCount: 30,
      readingTime: 1,
    },
  },
  WORDCOUNT: {
    rel: 'content/wordcount.md', content: WC_WORDS,
    payload: {
      title: 'wordcount',
      summary: WC_EXPECTED_SUMMARY,
      headings: [],
      wordCount: 250,
      readingTime: 2,
    },
  },
  SLICE: {
    rel: 'content/long-summary.md', content: FX_SLICE,
    payload: {
      title: 'long-summary',
      summary: SLICE_EXPECTED_SUMMARY,
      headings: [],
      wordCount: 60,
      readingTime: 1,
    },
  },
};

describe('GET /api/file/summary inner transform fields', () => {
  it('pins the FULL golden payload for every fixture', async () => {
    for (const [name, { rel, content, payload }] of Object.entries(GOLDENS)) {
      const r = await invokeSummary(rel, content);
      assert.equal(r.status, 200, `${name}: status`);
      assert.deepEqual(r.payload, payload, `${name}: full payload`);
      // Byte-for-byte serialization, including key order, matches the golden.
      assert.equal(JSON.stringify(r.payload), JSON.stringify(payload), `${name}: serialized payload`);
    }
  });

  it('takes the title from the frontmatter title line when present', async () => {
    const { rel, content } = GOLDENS.FM_TITLE;
    const r = await invokeSummary(rel, content);
    assert.equal(r.payload.title, 'Frontmatter Wins');
    // Non-vacuous: the basename would have been "fm-title", which is NOT the result.
    assert.notEqual(r.payload.title, 'fm-title');
  });

  it('falls back to the basename (extension stripped) when there is no frontmatter', async () => {
    const { rel, content } = GOLDENS.NO_FM;
    const r = await invokeSummary(rel, content);
    assert.equal(r.payload.title, 'no-frontmatter');
    assert.equal(r.payload.title, path.basename(rel, path.extname(rel)));
  });

  it('falls back to the basename when frontmatter lacks a title line', async () => {
    const { rel, content } = GOLDENS.FM_NO_TITLE;
    const r = await invokeSummary(rel, content);
    // Frontmatter exists (tags/draft) but has no title line, so the basename wins.
    assert.equal(r.payload.title, 'tags-only');
    assert.equal(r.payload.title, path.basename(rel, path.extname(rel)));
  });

  it('joins the first two qualifying paragraphs with a single space and slices to 300 chars', async () => {
    const { rel, content } = GOLDENS.SLICE;
    const r = await invokeSummary(rel, content);
    assert.equal(r.payload.summary.length, 300, 'summary is sliced to exactly 300 chars');
    assert.equal(r.payload.summary, SLICE_EXPECTED_SUMMARY);
    // The 179-char first paragraph fits whole, then a single space, then part of para2:
    // pins the single-space join and that truncation cut into the SECOND paragraph.
    assert.ok(r.payload.summary.startsWith(SLICE_PARA1 + ' '), 'para1 then a single space');
    assert.ok(r.payload.summary.includes(' bravo'), 'the join reaches into the second paragraph');
  });

  it('excludes short/import/code/html paragraphs and strips leading heading markers', async () => {
    const { rel, content } = GOLDENS.PARA_FILTER;
    const r = await invokeSummary(rel, content);
    const summary = r.payload.summary;
    // The surviving summary is exactly the two qualifying paragraphs.
    assert.equal(summary, 'Heading marker ZZHEADMARK is stripped yet the text survives well Second qualifying paragraph stays intact and well past twenty chars.');
    // Negative cases, each tied to one filter (non-vacuous: every ZZ-token below is
    // present in the fixture and absent from the summary).
    assert.ok(!summary.includes('Tiny'), 'paragraph shorter than 21 chars excluded');
    assert.ok(!summary.includes('ZZIMPORTLINE'), 'import line removed by /import\\s+.*$/gm');
    assert.ok(!summary.includes('ZZCODEFENCE'), 'fenced code block removed');
    assert.ok(!summary.includes('ZZHTMLATTR'), 'html tag (and its attributes) removed');
    assert.ok(!summary.includes('<section'), 'html opening tag removed');
    assert.ok(!summary.includes('ZZHTMLTEXT'), 'residual html text dropped by the length filter');
    assert.ok(!summary.includes('ZZIMPORTPARA'), 'paragraph starting with "import" excluded');
    assert.ok(!summary.includes('importance'), 'the import-prefixed paragraph is gone in full');
    // Heading marker stripped, but its text survived into the summary.
    assert.ok(!summary.includes('#'), 'leading "## " heading marker stripped');
    assert.ok(summary.includes('Heading marker ZZHEADMARK is stripped'), 'heading text survives sans marker');
  });

  it('scans level 1-3 headings only, trims them, and caps the array at 10', async () => {
    const { rel, content } = GOLDENS.HEADINGS;
    const r = await invokeSummary(rel, content);
    const headings = r.payload.headings;
    assert.equal(headings.length, 10, 'capped at 10');
    assert.deepEqual(headings, ['Trim Me Heading', 'Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'India']);
    // Trim: source line was "#   Trim Me Heading   " (leading/trailing whitespace).
    assert.equal(headings[0], 'Trim Me Heading');
    // Level-4 line is excluded (the #### never matches #{1,3}\s+).
    assert.ok(!headings.includes('Level Four Out'), 'level-4 heading excluded');
    // 11th and 12th matched headings dropped by slice(0, 10).
    assert.ok(!headings.includes('Juliet11'), '11th heading dropped by the cap');
    assert.ok(!headings.includes('Kilo12'), '12th heading dropped by the cap');
  });

  it('computes wordCount over the original content and readingTime = ceil(wordCount/200)', async () => {
    const { rel, content } = GOLDENS.WORDCOUNT;
    const r = await invokeSummary(rel, content);
    assert.equal(r.payload.wordCount, 250, 'wordCount counts all whitespace-split tokens');
    assert.equal(r.payload.readingTime, 2, 'ceil(250/200) crosses the 200-word boundary');
    assert.equal(r.payload.readingTime, Math.ceil(r.payload.wordCount / 200));
  });

  it('returns 404 (and reads inside the closure) when the file cannot be read', async () => {
    // Empty fs: the readFileSync inside the transform throws ENOENT and the outer catch
    // returns the 404 envelope. Confirms the transform runs lazily inside cached().
    const r = await invokeSummary('content/missing.md', undefined, {});
    assert.deepEqual(r, { status: 404, payload: { error: 'File not found' } });
  });

  it('rejects an invalid path with 400 before reading anything', async () => {
    const r = await invokeSummary('../etc/passwd', 'irrelevant', { isValidFilePath: () => false });
    assert.deepEqual(r, { status: 400, payload: { error: 'Invalid path' } });
  });
});
