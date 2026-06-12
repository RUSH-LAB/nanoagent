import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// files.js is CommonJS; load it the way the other route tests do.
const require = createRequire(import.meta.url);
const filesRoutes = require('../server/routes/files.js');

const PROJECT_ROOT = '/fake/root';

// The /api/history handler joins each git log line's fields with this
// unit-separator byte and splits on it, so the canned log below uses the same
// one. Keeping it in sync is what makes the "separator inside the subject"
// rejoin assertion meaningful.
const SEP = '\x1f';

// Drive GET /api/history with a mocked ctx and capture the json() response. The
// handler only touches url.searchParams (the path), isValidFilePath,
// execFileSync (the git log) and json, so the stub supplies just those. `log`
// is the raw text the stubbed execFileSync returns; `fail` makes it throw to
// exercise the catch path.
async function getHistory({ log, fail }) {
  let captured = null;
  let gitArgs = null;
  const ctx = {
    PROJECT_ROOT,
    isValidFilePath: () => true,
    execFileSync: (cmd, args) => {
      gitArgs = { cmd, args };
      if (fail) throw new Error('git unavailable');
      return log;
    },
    json: (_res, status, body) => { captured = { status, body }; },
  };
  const url = new URL('http://localhost/api/history?path=content/post.md');
  await filesRoutes({ method: 'GET' }, { writableEnded: false }, url, '/api/history', ctx);
  return { captured, gitArgs };
}

// A canned git log payload that exercises every branch of the parser:
//   1. a normal commit                                → parsed
//   2. a blank line between commits                   → skipped by the !line guard
//   3. a commit whose subject contains the separator  → parsed, message rejoined with SEP
//   4. a malformed row with fewer than four fields    → skipped (parts.length < 4)
// The payload ends with a newline, as real git output does; output.trim() drops
// that trailing newline so it never becomes a phantom commit.
const RAW_LOG =
  `abc1234${SEP}Ada Lovelace${SEP}2026-01-01 09:00:00 +0000${SEP}First commit\n` +
  `\n` +
  `def5678${SEP}Grace Hopper${SEP}2026-01-02 10:30:00 +0000${SEP}Fix${SEP}rejoined subject\n` +
  `bad99${SEP}too${SEP}few\n`;

describe('GET /api/history (filter-map-filter folded into one reduce pass)', () => {
  it('parses valid commits in order, rejoining a separator in the subject', async () => {
    const { captured, gitArgs } = await getHistory({ log: RAW_LOG });
    assert.equal(captured.status, 200);
    // The canned log uses the same separator the handler asks git to emit.
    assert.ok(gitArgs.args.includes(`--format=%h${SEP}%an${SEP}%ai${SEP}%s`));
    assert.deepEqual(captured.body.commits, [
      {
        hash: 'abc1234',
        author: 'Ada Lovelace',
        date: '2026-01-01 09:00:00 +0000',
        message: 'First commit',
      },
      {
        hash: 'def5678',
        author: 'Grace Hopper',
        date: '2026-01-02 10:30:00 +0000',
        message: `Fix${SEP}rejoined subject`,
      },
    ]);
  });

  it('returns an empty list when git fails', async () => {
    const { captured } = await getHistory({ fail: true });
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.body.commits, []);
  });
});
