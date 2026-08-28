import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// misc-tools.js is CommonJS; load the real module via createRequire the way the
// sibling guard suites do (next-misctools-create-write-guards.test.mjs and
// next-snapshots-delete-guards.test.mjs) so these cases exercise the shipped
// mutating handler in server/routes/misc-tools.js rather than a reimplementation.
// The handler runs over a fully mocked ctx: no real filesystem, network, or
// randomness is touched, and every saveJSON write is intercepted by a recording
// stub. The one unavoidable clock read is restoredAt (a global new Date() inside
// the handler, not a ctx helper), so it is asserted only as typeof === 'string'.
//
// This is an add-only characterization test. It pins the CURRENT, correct
// behavior of POST /api/backup/restore so a future refactor cannot silently
// change it. No source file is edited.
const require = createRequire(import.meta.url);
const routes = require('../../../../../src/server/routes/misc-tools.js');

const PROJECT_ROOT = '/proj';
// The nine data-file constants handed to the handler through ctx. Each one is a
// distinct path so an assertion can prove which file a restored key wrote to. The
// handler treats them as opaque tokens passed straight to saveJSON, so the exact
// names do not matter; only their distinctness does.
const NOTES_FILE = path.join(PROJECT_ROOT, 'var', 'data', 'notes.json');
const BOOKMARKS_FILE = path.join(PROJECT_ROOT, 'var', 'data', 'bookmarks.json');
const READING_LISTS_FILE = path.join(PROJECT_ROOT, 'var', 'data', 'reading-lists.json');
const GLOSSARY_FILE = path.join(PROJECT_ROOT, 'var', 'data', 'glossary.json');
const FLASHCARDS_FILE = path.join(PROJECT_ROOT, 'var', 'data', 'flashcards.json');
const TASKS_FILE = path.join(PROJECT_ROOT, 'var', 'data', 'tasks.json');
const ANALYTICS_FILE = path.join(PROJECT_ROOT, 'var', 'data', 'analytics.json');
const GOALS_FILE = path.join(PROJECT_ROOT, 'var', 'data', 'goals.json');
const STREAKS_FILE = path.join(PROJECT_ROOT, 'var', 'data', 'streaks.json');

// Drive POST /api/backup/restore over a mocked ctx. rateLimit records each call
// (key and limit) and returns the per-call toggle; readBody returns the supplied
// body and counts its calls, or throws when throwOnReadBody is set; saveJSON is
// the recording write stub that counts calls and records {fp, data}, or throws
// when throwOnSaveJSON is set; json captures the (status, body) handed back. The
// counters let every rejected branch prove that no write was performed.
async function runBackupRestore({
  body = {},
  rateLimitOk = true,
  throwOnReadBody = false,
  throwOnSaveJSON = false,
} = {}) {
  const saved = [];
  const rateLimitCalls = [];
  let readBodyCount = 0;
  let saveJSONCount = 0;
  let captured = null;
  const ctx = {
    rateLimit: (key, limit) => { rateLimitCalls.push({ key, limit }); return rateLimitOk; },
    readBody: async () => {
      readBodyCount++;
      if (throwOnReadBody) throw new Error('readBody failed');
      return body;
    },
    saveJSON: (fp, data) => {
      saveJSONCount++;
      if (throwOnSaveJSON) throw new Error('saveJSON write failed');
      saved.push({ fp, data });
    },
    NOTES_FILE, BOOKMARKS_FILE,
    READING_LISTS_FILE, GLOSSARY_FILE, FLASHCARDS_FILE, TASKS_FILE,
    ANALYTICS_FILE, GOALS_FILE, STREAKS_FILE,
    json: (_res, status, b) => { captured = { status, body: b }; },
  };
  const pathname = '/api/backup/restore';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await routes(req, res, url, pathname, ctx);
  return { captured, saved, readBodyCount, saveJSONCount, rateLimitCalls };
}

describe('POST /api/backup/restore in routes/misc-tools.js', () => {
  it('a rate-limited restore returns 429, never reads the body or writes, and uses the backup-restore key with limit 5', async () => {
    const r = await runBackupRestore({ rateLimitOk: false, body: { notes: { k: 'v' } } });
    assert.equal(r.captured.status, 429);
    assert.deepEqual(r.captured.body, { error: 'Too many requests. Try again in a minute.' });
    assert.equal(r.readBodyCount, 0, 'the rate-limit guard returns before readBody');
    assert.equal(r.saveJSONCount, 0);
    assert.equal(r.saved.length, 0);
    // Pin the per-handler rate-limit identity: the backup-restore key with limit 5
    // distinguishes this handler from the snapshots, whiteboard, and goals-update
    // handlers in the same module, which use different keys and higher limits.
    assert.equal(r.rateLimitCalls.length, 1);
    assert.deepEqual(r.rateLimitCalls[0], { key: 'backup-restore:127.0.0.1', limit: 5 });
  });

  it('a null body returns 400 Invalid backup bundle, reads the body once, never writes', async () => {
    const r = await runBackupRestore({ body: null });
    assert.equal(r.captured.status, 400);
    assert.deepEqual(r.captured.body, { error: 'Invalid backup bundle' });
    assert.equal(r.readBodyCount, 1, 'the body is read before the type is validated');
    assert.equal(r.saveJSONCount, 0);
    assert.equal(r.saved.length, 0);
  });

  it('a non-object body (a string) returns 400 Invalid backup bundle, never writes', async () => {
    // A non-empty string is truthy, so it clears the !body check, but typeof is
    // not 'object', so the type guard rejects it before any write.
    const r = await runBackupRestore({ body: 'not a bundle' });
    assert.equal(r.captured.status, 400);
    assert.deepEqual(r.captured.body, { error: 'Invalid backup bundle' });
    assert.equal(r.readBodyCount, 1);
    assert.equal(r.saveJSONCount, 0);
    assert.equal(r.saved.length, 0);
  });

  it('an empty object body returns 400 No recognizable data keys in bundle, never writes', async () => {
    // {} passes the typeof === 'object' check, but every mapped key is undefined,
    // so the restore loop records nothing and the empty-result guard fires.
    const r = await runBackupRestore({ body: {} });
    assert.equal(r.captured.status, 400);
    assert.deepEqual(r.captured.body, { error: 'No recognizable data keys in bundle' });
    assert.equal(r.saveJSONCount, 0);
    assert.equal(r.saved.length, 0);
  });

  it('a body with only unknown keys returns 400 No recognizable data keys in bundle, never writes', async () => {
    const r = await runBackupRestore({ body: { foo: 1, bar: { nested: true }, baz: 'x' } });
    assert.equal(r.captured.status, 400);
    assert.deepEqual(r.captured.body, { error: 'No recognizable data keys in bundle' });
    assert.equal(r.saveJSONCount, 0);
    assert.equal(r.saved.length, 0);
  });

  it('an array body passes the type check but has no mapped keys, returning 400 No recognizable data keys in bundle', async () => {
    // typeof [] === 'object', so an array clears the type guard, but it carries
    // none of the nine mapped keys, so the empty-result guard fires with no write.
    const r = await runBackupRestore({ body: [] });
    assert.equal(r.captured.status, 400);
    assert.deepEqual(r.captured.body, { error: 'No recognizable data keys in bundle' });
    assert.equal(r.saveJSONCount, 0);
    assert.equal(r.saved.length, 0);
  });

  it('a single recognized key restores once: 200, restored is [notes], one saveJSON to NOTES_FILE, restoredAt a string', async () => {
    const payload = [{ id: 'c1', text: 'hi' }];
    const r = await runBackupRestore({ body: { notes: payload } });
    assert.equal(r.captured.status, 200);
    assert.equal(r.captured.body.success, true);
    assert.deepEqual(r.captured.body.restored, ['notes']);
    assert.equal(typeof r.captured.body.restoredAt, 'string');
    assert.equal(r.saveJSONCount, 1);
    assert.equal(r.saved.length, 1);
    assert.equal(r.saved[0].fp, NOTES_FILE);
    assert.deepEqual(r.saved[0].data, payload);
    assert.deepEqual(r.rateLimitCalls[0], { key: 'backup-restore:127.0.0.1', limit: 5 });
  });

  it('multiple keys restore in mapping order, one saveJSON per key to its correct file, unknown keys ignored', async () => {
    // The body lists the keys out of mapping order and includes an unknown key.
    // restored must follow the mapping iteration order (notes, then tasks, then
    // streaks), not the body insertion order, and the unknown key must not
    // appear in restored or trigger a write.
    const nData = { k: 'v' };
    const tData = { todo: ['x'] };
    const sData = { current: 3 };
    const r = await runBackupRestore({
      body: { streaks: sData, unknownKey: 'ignored', notes: nData, tasks: tData },
    });
    assert.equal(r.captured.status, 200);
    assert.equal(r.captured.body.success, true);
    assert.deepEqual(r.captured.body.restored, ['notes', 'tasks', 'streaks']);
    assert.equal(typeof r.captured.body.restoredAt, 'string');
    assert.equal(r.saveJSONCount, 3);
    // The writes land in mapping order, each to its matching file with its value.
    assert.deepEqual(r.saved, [
      { fp: NOTES_FILE, data: nData },
      { fp: TASKS_FILE, data: tData },
      { fp: STREAKS_FILE, data: sData },
    ]);
  });

  it('a null value is restored and counted, while an explicit undefined value is skipped', async () => {
    // body[key] !== undefined is the gate: null passes it (null is restored and
    // written), but a property explicitly set to undefined is treated the same as
    // an absent key and is skipped.
    const r = await runBackupRestore({ body: { notes: null, tasks: undefined } });
    assert.equal(r.captured.status, 200);
    assert.deepEqual(r.captured.body.restored, ['notes']);
    assert.equal(r.saveJSONCount, 1);
    assert.equal(r.saved.length, 1);
    assert.equal(r.saved[0].fp, NOTES_FILE);
    assert.equal(r.saved[0].data, null);
  });

  it('a throwing saveJSON returns 500 Backup restore failed with the error detail, after reaching the write', async () => {
    const r = await runBackupRestore({ body: { notes: { k: 'v' } }, throwOnSaveJSON: true });
    assert.equal(r.captured.status, 500);
    assert.deepEqual(r.captured.body, { error: 'Backup restore failed', detail: 'saveJSON write failed' });
    // The handler reached the write (saveJSON was called once) but recorded no
    // successful persist because the stub threw before the record push.
    assert.equal(r.saveJSONCount, 1);
    assert.equal(r.saved.length, 0);
  });

  it('a throwing readBody also lands on the 500 Backup restore failed branch, not a 400', async () => {
    // There is no inner body-parse try in this handler, so a readBody that throws
    // propagates to the outer catch and yields 500, unlike the sibling create and
    // update handlers, which translate a readBody failure into a 400 Invalid request.
    const r = await runBackupRestore({ throwOnReadBody: true, body: { notes: { k: 'v' } } });
    assert.equal(r.captured.status, 500);
    assert.deepEqual(r.captured.body, { error: 'Backup restore failed', detail: 'readBody failed' });
    assert.equal(r.readBodyCount, 1);
    assert.equal(r.saveJSONCount, 0);
    assert.equal(r.saved.length, 0);
  });
});
