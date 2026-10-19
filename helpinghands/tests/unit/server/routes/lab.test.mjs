import {after, before, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {loadRoute, makeCtx, invoke} from '../../_harness.mjs';
import {applyMigration, migratedDatabase} from '../fs/_pglite.mjs';

const require = createRequire(import.meta.url);
const {createPostgresLab, CHUNK_BYTES} = require('../../../../src/server/postgres/lab.js');
const {signDownloadToken, verifyDownloadToken, TOKEN_MS} = require('../../../../src/server/lab-tokens.js');
const {isGlobalApiPath} = require('../../../../src/server/workspace-context.js');
const {macScript, windowsScript} = require('../../../../src/server/lab-install.js');

const routes = loadRoute('lab');
const SECRET = 'a-test-secret-of-at-least-thirty-two-characters';
const UPLOAD = 'the-upload-token';
const SITE = 'https://mochi.example';
// The links of the app that serves the site (lab-app.js servedApp).
const SCHEME = 'rushlab-dev';
const ARM = 'aarch64-apple-darwin';
const INTEL = 'x86_64-apple-darwin';
const WINDOWS = 'x86_64-pc-windows-msvc';
// More than two chunks, fed in pieces that do not line up with them.
const BUNDLE = crypto.randomBytes(2 * CHUNK_BYTES + 12345);
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
// What the bundler writes to an update's .sig, for its version.
const signatureFor = version => Buffer.from(`untrusted comment: signature from tauri secret key\nRUQN...\ntrusted comment: timestamp:1792261939\tfile:RUSH Lab.app.tar.gz\tversion:${version}\nPK3E...\n`).toString('base64');
const SIGNATURE = signatureFor('0.20261017.183202');
const piecesOf = (data, size = 1024 * 1024 + 7) => Array.from({length: Math.ceil(data.length / size)}, (_, i) => data.subarray(i * size, (i + 1) * size));

describe('RUSH Lab\'s download and connect link', () => {
  let db;
  let ctx;
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
  const upload = (target, body, stamp = 'stamp-1', headers = {}, collection = 'bundles') => call({
    method: 'PUT', path: `/api/lab/${collection}/${target}`, body,
    headers: {authorization: `Bearer ${UPLOAD}`, 'x-lab-stamp': stamp, ...headers},
  });
  const uploadUpdate = (target, body, stamp, signature = SIGNATURE) => upload(target, body, stamp, signature ? {'x-lab-signature': signature} : {}, 'updates');

  before(async () => {
    const database = await migratedDatabase();
    db = database.db;
    ctx = makeCtx({lab: {
      bundles: createPostgresLab({pool: database.pool}), secret: SECRET, siteUrl: SITE, scheme: SCHEME, uploadToken: UPLOAD,
      findMember: async userId => (userId === 'gone' ? null : {login: `${userId}-gh`}),
      sessionCookie: async token => `session=${token}; Path=/; HttpOnly`,
      createSession: async userId => (userId === 'gone' ? null : {token: `session-for-${userId}`, login: `${userId}-gh`}),
    }});
  });
  after(() => db?.close());

  it('belongs to no workspace', () => {
    for (const pathname of ['/api/lab/connect', '/api/lab/session', '/api/lab/sign-in', '/api/lab/window-sign-in', `/api/lab/bundles/${ARM}`, `/api/lab/updates/${ARM}`, `/api/lab/updates/${ARM}/app.tar.gz`]) {
      assert.equal(isGlobalApiPath(pathname), true, pathname);
    }
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

  it('gives the signed-in member the connect link, with a token for them', async () => {
    assert.equal((await call({path: '/api/lab/connect'})).status, 401);
    const {status, payload} = await call({path: '/api/lab/connect', auth: as('alice')});
    assert.equal(status, 200);
    const link = new URL(payload.link);
    assert.equal(`${link.protocol}//${link.host}`, `${SCHEME}://connect`);
    assert.equal(link.searchParams.get('site'), SITE);
    assert.equal(verifyDownloadToken(SECRET, link.searchParams.get('token')), 'alice');
  });

  it('says whose a connect link is, and gives its member a session for the relay, and no one else', async () => {
    const token = signDownloadToken(SECRET, 'alice');
    const asked = await call({path: '/api/lab/session', query: {token}});
    assert.equal(asked.written.status, 200);
    assert.deepEqual(JSON.parse(asked.written.body), {member: {id: 'alice', login: 'alice-gh'}});
    const {written} = await call({method: 'POST', path: '/api/lab/session', query: {token}});
    assert.equal(written.status, 200);
    assert.equal(written.headers['Content-Type'], 'application/json; charset=utf-8');
    assert.deepEqual(JSON.parse(written.body), {session: 'session-for-alice', member: {id: 'alice', login: 'alice-gh'}});
    const expired = signDownloadToken(SECRET, 'alice', Date.now() - TOKEN_MS - 1000);
    for (const method of ['GET', 'POST']) {
      for (const query of [{}, {token: 'forged'}, {token: expired}, {token: signDownloadToken(SECRET, 'gone')}]) {
        assert.equal((await call({method, path: '/api/lab/session', query})).status, 401);
      }
    }
    assert.equal((await call({method: 'PUT', path: '/api/lab/session', query: {token}})).status, 405);
  });

  it('sends the browser back to the app signed in, or to the sign-in page first', async () => {
    const state = 'a'.repeat(48);
    const signedIn = await call({path: '/api/lab/sign-in', query: {state}, auth: as('alice')});
    assert.equal(signedIn.written.status, 302);
    const back = new URL(signedIn.written.headers.Location);
    assert.equal(`${back.protocol}//${back.host}`, `${SCHEME}://sign-in`);
    assert.equal(back.searchParams.get('site'), SITE);
    assert.equal(back.searchParams.get('state'), state);
    assert.equal(verifyDownloadToken(SECRET, back.searchParams.get('token')), 'alice');
    const signedOut = await call({path: '/api/lab/sign-in', query: {state}});
    assert.equal(signedOut.written.status, 302);
    assert.equal(signedOut.written.headers.Location, `/signin?next=${encodeURIComponent(`/api/lab/sign-in?state=${state}`)}`);
    for (const query of [{}, {state: 'short'}, {state: `${state}&x`}]) {
      assert.equal((await call({path: '/api/lab/sign-in', query, auth: as('alice')})).status, 400);
    }
  });

  it('signs the app\'s window in as the token\'s member, and no one else', async () => {
    const {written} = await call({path: '/api/lab/window-sign-in', query: {token: signDownloadToken(SECRET, 'alice')}});
    assert.equal(written.status, 302);
    assert.equal(written.headers.Location, '/');
    assert.equal(written.headers['Set-Cookie'], 'session=session-for-alice; Path=/; HttpOnly');
    const expired = signDownloadToken(SECRET, 'alice', Date.now() - TOKEN_MS - 1000);
    for (const query of [{}, {token: 'forged'}, {token: expired}, {token: signDownloadToken(SECRET, 'gone')}]) {
      assert.equal((await call({path: '/api/lab/window-sign-in', query})).status, 401);
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
    await assert.rejects(ctx.lab.bundles.replace({target: ARM, kind: 'app', stamp: 'big'}, piecesOf(BUNDLE), BUNDLE.length - 1), error => error.status === 413);
    assert.equal(await ctx.lab.bundles.bundle(ARM, 'app'), null);
  });

  it('stores an upload in chunks and sends it back byte for byte', async () => {
    const stored = await upload(ARM, BUNDLE, 'stamp-1');
    assert.equal(stored.status, 200);
    assert.deepEqual(stored.payload, {target: ARM, stamp: 'stamp-1', sha256: sha256(BUNDLE), size: BUNDLE.length});
    const chunks = (await db.query('select seq, length(data) as bytes from lab_bundle_chunk order by seq')).rows;
    assert.deepEqual(chunks.map(row => row.bytes), [CHUNK_BYTES, CHUNK_BYTES, 12345]);

    // Anyone downloads it: a member signs in in the app.
    const {written, sent} = await call({path: `/api/lab/bundles/${ARM}`});
    assert.equal(written.status, 200);
    assert.equal(written.headers['Content-Type'], 'application/x-apple-diskimage');
    assert.equal(written.headers['Content-Disposition'], 'attachment; filename="RUSH-Lab-Apple-silicon.dmg"');
    assert.equal(written.headers['Content-Length'], BUNDLE.length);
    assert.equal(written.headers['X-Lab-Stamp'], 'stamp-1');
    assert.equal(written.headers['X-Lab-Sha256'], sha256(BUNDLE));
    assert.ok(sent.equals(BUNDLE));
  });

  it('keeps only the newest bundle for a target', async () => {
    const newer = crypto.randomBytes(1000);
    assert.equal((await upload(ARM, newer, 'stamp-2')).status, 200);
    assert.deepEqual((await db.query('select count(*)::int as n from lab_bundle_chunk')).rows[0].n, 1);
    const {written, sent} = await call({path: `/api/lab/bundles/${ARM}`, auth: as('bob')});
    assert.equal(written.headers['X-Lab-Stamp'], 'stamp-2');
    assert.ok(sent.equals(newer));
  });

  it('keeps no app for Linux', async () => {
    assert.equal((await upload('x86_64-unknown-linux-gnu', Buffer.from('linux bundle'))).status, 400);
    await db.exec("begin; select set_config('app.lab_upload', 'on', true)");
    try {
      await assert.rejects(db.query("insert into lab_bundle(target, kind, upload_id, stamp, sha256, size) values ('x86_64-unknown-linux-gnu', 'app', gen_random_uuid(), 's', repeat('a', 64), 1)"), /lab_bundle_target_check/);
    } finally {
      await db.exec('rollback');
    }
  });

  it('tells the app\'s updater of the build it serves, with its signature, and serves its archive, beside the dmg', async () => {
    assert.equal((await call({path: `/api/lab/updates/${ARM}`})).written.status, 204);
    assert.equal((await call({path: `/api/lab/updates/${ARM}/app.tar.gz`})).status, 404);
    const archive = crypto.randomBytes(CHUNK_BYTES + 99);
    const stored = await uploadUpdate(ARM, archive, '2026-10-17T18-32-02-143Z-8a85c43d');
    assert.equal(stored.status, 200);
    assert.equal(stored.payload.sha256, sha256(archive));

    const asked = await call({path: `/api/lab/updates/${ARM}`});
    assert.equal(asked.status, 200);
    // The version its signature was made for, which the updater checks it against.
    assert.deepEqual(asked.payload, {version: '0.20261017.183202', url: `${SITE}/api/lab/updates/${ARM}/app.tar.gz`, signature: SIGNATURE});
    const {written, sent} = await call({path: `/api/lab/updates/${ARM}/app.tar.gz`});
    assert.equal(written.status, 200);
    assert.equal(written.headers['Content-Type'], 'application/gzip');
    assert.equal(written.headers['Content-Disposition'], `attachment; filename="RUSH-Lab-${ARM}.app.tar.gz"`);
    assert.ok(sent.equals(archive));
    // The dmg stays the dmg.
    assert.equal((await call({path: `/api/lab/bundles/${ARM}`})).written.headers['X-Lab-Stamp'], 'stamp-2');
    assert.equal((await call({path: `/api/lab/bundles/${ARM}/app.tar.gz`})).status, undefined);
  });

  it('serves Windows its installer, which is its update too', async () => {
    const installer = crypto.randomBytes(5000);
    assert.equal((await upload(WINDOWS, installer, 'stamp-1')).status, 200);
    assert.equal((await uploadUpdate(WINDOWS, installer, 'stamp-1')).status, 200);
    const app = await call({path: `/api/lab/bundles/${WINDOWS}`});
    assert.equal(app.written.headers['Content-Type'], 'application/vnd.microsoft.portable-executable');
    assert.equal(app.written.headers['Content-Disposition'], 'attachment; filename="RUSH-Lab-Setup.exe"');
    assert.ok(app.sent.equals(installer));
    assert.equal((await call({path: `/api/lab/updates/${WINDOWS}`})).payload.url, `${SITE}/api/lab/updates/${WINDOWS}/app.tar.gz`);
    const update = await call({path: `/api/lab/updates/${WINDOWS}/app.tar.gz`});
    assert.equal(update.written.headers['Content-Disposition'], 'attachment; filename="RUSH-Lab-Setup.exe"');
    assert.ok(update.sent.equals(installer));
  });

  it('refuses an update without its signature, or one that names no version', async () => {
    assert.equal((await uploadUpdate(INTEL, BUNDLE, 'stamp-1', null)).status, 400);
    assert.equal((await uploadUpdate(INTEL, BUNDLE, 'stamp-1', 'not base64!')).status, 400);
    assert.equal((await uploadUpdate(INTEL, BUNDLE, 'stamp-1', Buffer.from('untrusted comment: x\nRUQN\ntrusted comment: timestamp:1\tfile:a\nPK\n').toString('base64'))).status, 400);
    assert.equal((await uploadUpdate(INTEL, BUNDLE, 'stamp-1', signatureFor('0.0.0+build'))).status, 400);
    assert.equal((await call({method: 'PUT', path: `/api/lab/updates/${INTEL}/app.tar.gz`, headers: {authorization: `Bearer ${UPLOAD}`}})).status, 405);
    assert.equal((await call({path: '/api/lab/updates/wasm32-unknown'})).status, 404);
    assert.equal(await ctx.lab.bundles.bundle(INTEL, 'update'), null);
    await db.exec("begin; select set_config('app.lab_upload', 'on', true)");
    try {
      await assert.rejects(db.query("insert into lab_bundle(target, kind, upload_id, stamp, sha256, size) values ($1, 'update', gen_random_uuid(), 's', repeat('a', 64), 1)", [INTEL]), /lab_bundle_signature_check/);
    } finally {
      await db.exec('rollback');
    }
  });

  it('serves the engine every app runs: what it is, for the app to check and pick, and its archive', async () => {
    const shell = 'a'.repeat(40);
    const engine = headers => call({method: 'PUT', path: '/api/lab/engine', body: BUNDLE, headers: {authorization: `Bearer ${UPLOAD}`, 'x-lab-stamp': 'stamp-1', ...headers}});
    assert.equal((await call({path: '/api/lab/engine'})).written.status, 204);
    assert.equal((await call({path: '/api/lab/engine/engine.tar.gz'})).status, 404);
    assert.equal((await engine({'x-lab-shell': shell})).status, 400);
    assert.equal((await engine({'x-lab-signature': SIGNATURE})).status, 400);
    assert.equal((await engine({'x-lab-signature': SIGNATURE, 'x-lab-shell': 'not-a-tree'})).status, 400);
    assert.equal((await engine({'x-lab-signature': SIGNATURE, 'x-lab-shell': shell, authorization: 'Bearer wrong'})).status, 401);
    assert.equal((await engine({'x-lab-signature': SIGNATURE, 'x-lab-shell': shell})).status, 200);
    const {payload} = await call({path: '/api/lab/engine'});
    assert.deepEqual(payload, {stamp: 'stamp-1', shell, sha256: sha256(BUNDLE), signature: SIGNATURE, url: `${SITE}/api/lab/engine/engine.tar.gz`});
    const archive = await call({path: '/api/lab/engine/engine.tar.gz'});
    assert.equal(archive.written.headers['Content-Type'], 'application/gzip');
    assert.equal(archive.written.headers['X-Lab-Stamp'], 'stamp-1');
    assert.ok(archive.sent.equals(BUNDLE));
    assert.equal((await call({method: 'PUT', path: '/api/lab/engine/engine.tar.gz', headers: {authorization: `Bearer ${UPLOAD}`}})).status, 405);
    assert.equal(isGlobalApiPath('/api/lab/engine'), true);
    assert.equal(isGlobalApiPath('/api/lab/engine/engine.tar.gz'), true);
    for (const [values, check] of [
      [`'any', 'engine', gen_random_uuid(), 's', 'c2ln', null`, /lab_bundle_shell_check/],
      [`'${ARM}', 'engine', gen_random_uuid(), 's', 'c2ln', 'x'`, /lab_bundle_engine_check/],
    ]) {
      await db.exec("begin; select set_config('app.lab_upload', 'on', true)");
      try {
        await assert.rejects(db.query(`insert into lab_bundle(target, kind, upload_id, stamp, signature, shell, sha256, size) values (${values}, repeat('a', 64), 1)`), check);
      } finally {
        await db.exec('rollback');
      }
    }
  });

  it('streams what it serves to each app following it: as it opens, and as each update or engine is uploaded', async () => {
    const writes = [];
    const releases = () => writes.filter(write => write.startsWith('event: release\n')).map(write => JSON.parse(write.split('data: ')[1]));
    let res;
    const following = call({path: '/api/lab/releases', onRequest: (_, response) => {
      res = response;
      res.write = chunk => writes.push(String(chunk));
    }});
    while (!writes.length) await new Promise(resolve => setImmediate(resolve));
    assert.equal(res.written.headers['Content-Type'], 'text/event-stream');
    const [before] = releases();
    await uploadUpdate(ARM, BUNDLE, 'stamp-streamed', signatureFor('0.20261019.120000'));
    await upload(ARM, BUNDLE, 'stamp-streamed');
    await call({method: 'PUT', path: '/api/lab/engine', body: BUNDLE, headers: {authorization: `Bearer ${UPLOAD}`, 'x-lab-stamp': 'engine-streamed', 'x-lab-signature': SIGNATURE, 'x-lab-shell': 'b'.repeat(40)}});
    const heard = releases();
    // An app's own upload, its dmg or installer, is no update.
    assert.equal(heard.length, 3);
    assert.deepEqual(heard[1], {...before, updates: {...before.updates, [ARM]: '0.20261019.120000'}});
    assert.deepEqual(heard[2], {...heard[1], engine: 'engine-streamed'});
    res.emit('close');
    await following;
    assert.equal(res.writableEnded, true);
    assert.equal(isGlobalApiPath('/api/lab/releases'), true);
  });

  it('answers 404 for a target with no bundle', async () => {
    assert.equal((await call({path: `/api/lab/bundles/${INTEL}`})).status, 404);
    assert.equal((await call({path: '/api/lab/bundles/wasm32-unknown'})).status, 404);
  });

  it('serves anyone the script that installs the app from this site, which sh reads', async () => {
    const {written} = await call({path: '/install.sh'});
    assert.equal(written.status, 200);
    assert.match(written.headers['Content-Type'], /^text\/x-shellscript/);
    const script = String(written.body);
    assert.match(script, new RegExp(`^SITE='${SITE}'$`, 'm'));
    assert.match(script, /"\$SITE\/api\/lab\/bundles\/\$TARGET"/);
    // The release, whatever the site: config.yaml's top level.
    assert.match(script, /^APP='\/Applications\/RUSH Lab\.app'$/m);
    assert.match(script, /quit app id "lab\.mochi\.lab"/);
    execFileSync('sh', ['-n'], {input: script});
    assert.throws(() => macScript("https://x.org'; rm -rf ~"), /not a site/);
  });

  it('serves anyone the script that installs the app on Windows from this site, which PowerShell reads', async () => {
    const {written} = await call({path: '/install.ps1'});
    assert.equal(written.status, 200);
    assert.match(written.headers['Content-Type'], /^text\/plain/);
    const script = String(written.body);
    assert.ok(script.includes(`\n$Site = '${SITE}'\n`));
    assert.ok(script.includes(`"$Site/api/lab/bundles/${WINDOWS}"`));
    // Run in the member's own window, it throws rather than exits, which would close it.
    assert.doesNotMatch(script, /(^|[;{]\s*)exit\b/im);
    assert.throws(() => windowsScript("https://x.org'; Remove-Item ~"), /not a site/);
  });

  it('cuts a download short when an upload replaces the bundle it is sending', async () => {
    assert.equal((await upload(INTEL, BUNDLE, 'stamp-1')).status, 200);
    const real = ctx.lab.bundles;
    // The replacing upload lands once the first chunk is sent.
    const bundles = {
      ...real,
      async* chunks(bundle) {
        let first = true;
        for await (const data of real.chunks(bundle)) {
          yield data;
          if (first) await real.replace({target: INTEL, kind: 'app', stamp: 'stamp-2'}, [Buffer.from('new')], 1024);
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
      // Cut short: what was sent is whole chunks, the one read ahead with them, never the rest.
      assert.ok(sent.length < BUNDLE.length && sent.length % CHUNK_BYTES === 0, String(sent.length));
    } finally {
      ctx.lab.bundles = real;
    }
  });

  it('refuses writes that skip the upload path, through row-level security', async () => {
    await db.exec('set role mochi_runtime');
    try {
      await db.exec("begin; select set_config('app.user_id', 'alice', true)");
      await assert.rejects(db.query("insert into lab_bundle(target, kind, upload_id, stamp, sha256, size) values ($1, 'app', gen_random_uuid(), 's', $2, 1)", [INTEL, 'a'.repeat(64)]));
      await db.exec('rollback');
      await db.exec("begin; select set_config('app.user_id', 'alice', true)");
      assert.deepEqual((await db.query('delete from lab_bundle returning target')).rows, []);
      await db.exec('rollback');
      // Anyone reads them, signed in or not (migration 0039).
      assert.deepEqual((await db.query('select target, kind from lab_bundle order by target, kind')).rows.map(row => `${row.target} ${row.kind}`), [`${ARM} app`, `${ARM} update`, 'any engine', `${INTEL} app`, `${WINDOWS} app`, `${WINDOWS} update`]);
    } finally {
      await db.exec('reset role');
    }
  });
});

describe('migration 0043', () => {
  it('calls each Mac\'s dmg its app, as the tables\' owner under row-level security', async () => {
    const {db} = await migratedDatabase({until: '0043'});
    await db.exec(`
      begin; select set_config('app.lab_upload', 'on', true);
      insert into lab_bundle_chunk(upload_id, seq, data) values ('00000000-0000-4000-8000-000000000001', 0, 'x');
      insert into lab_bundle(target, kind, upload_id, stamp, sha256, size) values ('${ARM}', 'dmg', '00000000-0000-4000-8000-000000000001', 's', repeat('a', 64), 1);
      commit;
      create role lab_owner;
      alter table lab_bundle owner to lab_owner;
      set role lab_owner;
    `);
    await applyMigration(db, '0043_lab_windows.sql');
    await db.exec('reset role');
    assert.deepEqual((await db.query('select target, kind from lab_bundle')).rows, [{target: ARM, kind: 'app'}]);
    assert.equal((await db.query('select count(*)::int as n from lab_bundle_chunk')).rows[0].n, 1);
    assert.deepEqual((await db.query("select policyname from pg_policies where tablename = 'lab_bundle' order by policyname")).rows.map(row => row.policyname), ['lab_bundle_delete', 'lab_bundle_insert', 'lab_bundle_read']);
  });
});
