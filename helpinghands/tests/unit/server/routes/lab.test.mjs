import {after, before, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {loadRoute, makeCtx, invoke} from '../../_harness.mjs';
import {migratedDatabase} from '../fs/_pglite.mjs';

const require = createRequire(import.meta.url);
const {createPostgresLab, CHUNK_BYTES} = require('../../../../src/server/postgres/lab.js');
const {signDownloadToken, verifyDownloadToken, TOKEN_MS} = require('../../../../src/server/lab-tokens.js');
const {isGlobalApiPath} = require('../../../../src/server/workspace-context.js');

const routes = loadRoute('lab');
const SECRET = 'a-test-secret-of-at-least-thirty-two-characters';
const UPLOAD = 'the-upload-token';
const SITE = 'https://mochi.example';
const ARM = 'aarch64-apple-darwin';
const INTEL = 'x86_64-apple-darwin';
// More than two chunks, fed in pieces that do not line up with them.
const BUNDLE = crypto.randomBytes(2 * CHUNK_BYTES + 12345);
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const piecesOf = (data, size = 1024 * 1024 + 7) => Array.from({length: Math.ceil(data.length / size)}, (_, i) => data.subarray(i * size, (i + 1) * size));

describe('Mochi Lab\'s one-line install', () => {
  let db;
  let ctx;
  let script;
  const as = userId => ({userId, orgId: null, account: {id: userId}});

  /** One request; `body` is the raw bytes it streams, and every byte the handler writes is kept. */
  const call = ({method = 'GET', path: pathname, query, auth = null, headers = {}, body, onRequest}) => {
    const sent = [];
    return invoke(routes, {
      ctx, method, path: pathname, query, auth, headers,
      onRequest: (req, res) => {
        req[Symbol.asyncIterator] = async function* stream() { yield* piecesOf(body ?? Buffer.alloc(0)); };
        res.write = chunk => { sent.push(Buffer.from(chunk)); return true; };
        res.destroy = () => { res.destroyed = true; };
        onRequest?.(req, res);
      },
    }).then(result => ({...result, sent: Buffer.concat(sent)}));
  };
  const upload = (target, body, stamp = 'stamp-1', headers = {}) => call({
    method: 'PUT', path: `/api/lab/bundles/${target}`, body,
    headers: {authorization: `Bearer ${UPLOAD}`, 'x-lab-stamp': stamp, ...headers},
  });

  before(async () => {
    const database = await migratedDatabase();
    db = database.db;
    script = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lab-install-')), 'install.sh');
    fs.writeFileSync(script, '#!/bin/sh\nSITE="__MOCHI_SITE__"\nTOKEN="__MOCHI_TOKEN__"\necho "$SITE $TOKEN __MOCHI_SITE__"\n');
    ctx = makeCtx({lab: {
      bundles: createPostgresLab({pool: database.pool}), secret: SECRET, siteUrl: SITE, uploadToken: UPLOAD, installScript: script,
      createSession: async userId => (userId === 'gone' ? null : {token: `session-for-${userId}`, login: `${userId}-gh`}),
    }});
  });
  after(() => db?.close());

  it('belongs to no workspace', () => {
    for (const pathname of ['/api/lab/install', '/api/lab/install.sh', '/api/lab/session', `/api/lab/bundles/${ARM}`]) assert.equal(isGlobalApiPath(pathname), true, pathname);
    assert.equal(isGlobalApiPath('/api/lab/bundles'), false);
  });

  it('signs a download token for an hour, and refuses one tampered with or expired', () => {
    const now = Date.now();
    const token = signDownloadToken(SECRET, 'alice', now);
    assert.match(token, /^[A-Za-z0-9_-]+\.\d+\.[A-Za-z0-9_-]{43}$/);
    assert.equal(verifyDownloadToken(SECRET, token, now), 'alice');
    assert.equal(verifyDownloadToken(SECRET, token, now + TOKEN_MS - 1000), 'alice');
    assert.equal(verifyDownloadToken(SECRET, token, now + TOKEN_MS), null);
    assert.equal(verifyDownloadToken('another-secret', token, now), null);
    const [user, expiry, signature] = token.split('.');
    assert.equal(verifyDownloadToken(SECRET, `${Buffer.from('bob').toString('base64url')}.${expiry}.${signature}`, now), null);
    assert.equal(verifyDownloadToken(SECRET, `${user}.${Number(expiry) + 3600}.${signature}`, now), null);
    const flipped = signature.at(-1) === 'A' ? 'B' : 'A';
    assert.equal(verifyDownloadToken(SECRET, `${user}.${expiry}.${signature.slice(0, -1)}${flipped}`, now), null);
    for (const nonsense of [null, '', 'a.b.c', `${token}x`]) assert.equal(verifyDownloadToken(SECRET, nonsense, now), null);
  });

  it('gives the signed-in member the command, with a token for them', async () => {
    assert.equal((await call({path: '/api/lab/install'})).status, 401);
    const {status, payload} = await call({path: '/api/lab/install', auth: as('alice')});
    assert.equal(status, 200);
    const [, token] = /^curl -fsSL 'https:\/\/mochi\.example\/api\/lab\/install\.sh\?token=([^']+)' \| sh$/.exec(payload.command);
    assert.equal(verifyDownloadToken(SECRET, token), 'alice');
  });

  it('gives the install link\'s member a session for the relay, saying whose, and no one else', async () => {
    const {written} = await call({method: 'POST', path: '/api/lab/session', query: {token: signDownloadToken(SECRET, 'alice')}});
    assert.equal(written.status, 200);
    assert.equal(written.headers['Content-Type'], 'application/json; charset=utf-8');
    assert.deepEqual(JSON.parse(written.body), {session: 'session-for-alice', member: {id: 'alice', login: 'alice-gh'}});
    const expired = signDownloadToken(SECRET, 'alice', Date.now() - TOKEN_MS - 1000);
    for (const query of [{}, {token: 'forged'}, {token: expired}, {token: signDownloadToken(SECRET, 'gone')}]) {
      assert.equal((await call({method: 'POST', path: '/api/lab/session', query})).status, 401);
    }
    assert.equal((await call({path: '/api/lab/session', query: {token: signDownloadToken(SECRET, 'alice')}})).status, 405);
  });

  it('serves the install script with the site and the token in it', async () => {
    const token = signDownloadToken(SECRET, 'alice');
    const {written} = await call({path: '/api/lab/install.sh', query: {token}});
    assert.equal(written.status, 200);
    assert.equal(written.headers['Content-Type'], 'text/x-shellscript; charset=utf-8');
    assert.equal(written.body, `#!/bin/sh\nSITE="${SITE}"\nTOKEN="${token}"\necho "$SITE $TOKEN ${SITE}"\n`);
  });

  it('answers a bad or expired install link with a script that says so and fails', async () => {
    const expired = signDownloadToken(SECRET, 'alice', Date.now() - TOKEN_MS - 1000);
    for (const query of [{}, {token: 'nonsense'}, {token: expired}]) {
      const {written} = await call({path: '/api/lab/install.sh', query});
      assert.equal(written.status, 200);
      assert.equal(written.headers['Content-Type'], 'text/x-shellscript; charset=utf-8');
      assert.match(written.body, /^echo 'RUSH Lab: this install link is invalid or has expired\.[^']*' >&2\nexit 1\n$/);
    }
  });

  it('refuses uploads while LAB_UPLOAD_TOKEN is unset, and without it', async () => {
    const unset = makeCtx({lab: {...ctx.lab, uploadToken: null}});
    const refused = await invoke(routes, {ctx: unset, method: 'PUT', path: `/api/lab/bundles/${ARM}`, auth: null, headers: {authorization: 'Bearer '}});
    assert.equal(refused.status, 503);
    assert.match(refused.payload.error, /not configured: set LAB_UPLOAD_TOKEN/);
    for (const authorization of [undefined, 'Bearer wrong', UPLOAD, `Bearer ${UPLOAD}x`]) {
      assert.equal((await upload(ARM, BUNDLE, 'stamp-1', {authorization})).status, 401, authorization);
    }
  });

  it('refuses an unknown target, a missing stamp, an empty body and one too large', async () => {
    assert.equal((await upload('wasm32-unknown', BUNDLE)).status, 400);
    assert.equal((await upload(ARM, BUNDLE, '')).status, 400);
    assert.equal((await upload(ARM, BUNDLE, 'has space')).status, 400);
    assert.equal((await upload(ARM, Buffer.alloc(0))).status, 400);
    assert.equal((await upload(ARM, BUNDLE, 'stamp-1', {'content-length': String(200 * 1024 * 1024 + 1)})).status, 413);
    await assert.rejects(ctx.lab.bundles.replace(ARM, 'big', piecesOf(BUNDLE), BUNDLE.length - 1), error => error.status === 413);
    assert.equal(await ctx.lab.bundles.bundle('alice', ARM), null);
  });

  it('stores an upload in chunks and sends it back byte for byte', async () => {
    const stored = await upload(ARM, BUNDLE, 'stamp-1');
    assert.equal(stored.status, 200);
    assert.deepEqual(stored.payload, {target: ARM, stamp: 'stamp-1', sha256: sha256(BUNDLE), size: BUNDLE.length});
    const chunks = (await db.query('select seq, length(data) as bytes from lab_bundle_chunk order by seq')).rows;
    assert.deepEqual(chunks.map(row => row.bytes), [CHUNK_BYTES, CHUNK_BYTES, 12345]);

    const token = signDownloadToken(SECRET, 'bob');
    for (const how of [{query: {token}}, {auth: as('bob')}]) {
      const {written, sent} = await call({path: `/api/lab/bundles/${ARM}`, ...how});
      assert.equal(written.status, 200);
      assert.equal(written.headers['Content-Type'], 'application/gzip');
      assert.equal(written.headers['Content-Length'], BUNDLE.length);
      assert.equal(written.headers['X-Lab-Stamp'], 'stamp-1');
      assert.equal(written.headers['X-Lab-Sha256'], sha256(BUNDLE));
      assert.ok(sent.equals(BUNDLE));
    }
  });

  it('keeps only the newest bundle for a target', async () => {
    const newer = crypto.randomBytes(1000);
    assert.equal((await upload(ARM, newer, 'stamp-2')).status, 200);
    assert.deepEqual((await db.query('select count(*)::int as n from lab_bundle_chunk')).rows[0].n, 1);
    const {written, sent} = await call({path: `/api/lab/bundles/${ARM}`, auth: as('bob')});
    assert.equal(written.headers['X-Lab-Stamp'], 'stamp-2');
    assert.ok(sent.equals(newer));
  });

  it('keeps a bundle for Linux, which WSL2 runs too', async () => {
    const linux = 'x86_64-unknown-linux-gnu';
    assert.equal((await upload(linux, Buffer.from('linux bundle'), 'stamp-1')).status, 200);
    const {written} = await call({path: `/api/lab/bundles/${linux}`, auth: as('bob')});
    assert.equal(written.status, 200);
    assert.equal(written.headers['X-Lab-Stamp'], 'stamp-1');
  });

  it('answers 404 for a target with no bundle, and 401 without a member', async () => {
    assert.equal((await call({path: `/api/lab/bundles/${INTEL}`, auth: as('bob')})).status, 404);
    assert.equal((await call({path: '/api/lab/bundles/wasm32-unknown', auth: as('bob')})).status, 404);
    assert.equal((await call({path: `/api/lab/bundles/${ARM}`})).status, 401);
    assert.equal((await call({path: `/api/lab/bundles/${ARM}`, query: {token: 'forged'}, auth: as('bob')})).status, 401);
  });

  it('cuts a download short when an upload replaces the bundle it is sending', async () => {
    assert.equal((await upload(INTEL, BUNDLE, 'stamp-1')).status, 200);
    const real = ctx.lab.bundles;
    // The replacing upload lands once the first chunk is sent.
    const bundles = {
      ...real,
      async* chunks(userId, bundle) {
        let first = true;
        for await (const data of real.chunks(userId, bundle)) {
          yield data;
          if (first) await real.replace(INTEL, 'stamp-2', [Buffer.from('new')], 1024);
          first = false;
        }
      },
    };
    ctx.lab.bundles = bundles;
    try {
      const {written, res, sent} = await call({path: `/api/lab/bundles/${INTEL}`, auth: as('bob')});
      assert.equal(written.status, 200);
      assert.equal(res.destroyed, true);
      assert.equal(res.writableEnded, true);
      assert.equal(sent.length, CHUNK_BYTES);
    } finally {
      ctx.lab.bundles = real;
    }
  });

  it('refuses writes that skip the upload path, through row-level security', async () => {
    await db.exec('set role mochi_runtime');
    try {
      await db.exec("begin; select set_config('app.user_id', 'alice', true)");
      await assert.rejects(db.query("insert into lab_bundle(target, upload_id, stamp, sha256, size) values ($1, gen_random_uuid(), 's', $2, 1)", [INTEL, 'a'.repeat(64)]));
      await db.exec('rollback');
      await db.exec("begin; select set_config('app.user_id', 'alice', true)");
      assert.deepEqual((await db.query('delete from lab_bundle returning target')).rows, []);
      await db.exec('rollback');
      // No one signed in reads nothing.
      assert.deepEqual((await db.query('select target from lab_bundle')).rows, []);
    } finally {
      await db.exec('reset role');
    }
  });
});
