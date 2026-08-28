import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const SERVER_JS = path.join(REPO_ROOT, 'src/server/index.js');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Ask the OS for a free port: bind to :0, read the assigned port, release it.
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Fetch a JSON (or empty) body with a hard timeout covering headers and body.
async function getJSON(url, opts = {}, timeoutMs = 3000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
  } finally {
    clearTimeout(timer);
  }
}

// Poll GET /api/health until the booted server answers 200. The health route is
// excluded from the perf wrapper, so polling it never records a perf metric and
// keeps the end to end metric count deterministic.
async function waitForHealth(base, child, getStderr, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early (code ${child.exitCode}). stderr:\n${getStderr()}`);
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1000);
      const res = await fetch(`${base}/api/health`, { signal: controller.signal });
      clearTimeout(timer);
      await res.text();
      if (res.ok) return;
    } catch {
      // Connection refused while the server is still starting up; retry.
    }
    await delay(100);
  }
  throw new Error(`server never became healthy. stderr:\n${getStderr()}`);
}

describe('server/index.js req.url double-parse dedup', () => {
  it('source: res.end wrapper reuses the dispatch pathname (no self-parse)', () => {
    const src = readFileSync(SERVER_JS, 'utf-8');
    assert.ok(
      !src.includes("new URL(req.url, 'http://localhost')"),
      "the wrapper self-parse literal new URL(req.url, 'http://localhost') must be gone",
    );
    assert.ok(
      src.includes('const ep = pathname;'),
      "the wrapper must reuse the dispatch pathname via 'const ep = pathname;'",
    );
    assert.ok(
      src.includes('new URL(req.url, `http://localhost:${PORT}`)'),
      'the router dispatch URL parse (backtick port base) must still be present',
    );
  });

  it('boots the real server and records exactly one deduped perf metric', async () => {
    const port = await getFreePort();
    const base = `http://127.0.0.1:${port}`;
    const child = spawn(process.execPath, ['src/server/index.js'], {
      cwd: REPO_ROOT,
      env: { ...process.env, EDITOR_PORT: String(port) },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    try {
      await waitForHealth(base, child, () => stderr);

      // GET /api/logs?limit=5 returns 200 with its usual keys and header set.
      const logs = await getJSON(`${base}/api/logs?limit=5`);
      assert.equal(logs.status, 200, 'GET /api/logs returns 200');
      assert.equal(logs.headers.get('x-api-version'), '1.0', 'carries the X-API-Version header');
      assert.equal(logs.headers.get('x-powered-by'), 'Mochi Lab', 'carries the X-Powered-By header');
      assert.equal(typeof logs.body.total, 'number', 'logs body has numeric total');
      assert.equal(typeof logs.body.returned, 'number', 'logs body has numeric returned');
      assert.ok(Array.isArray(logs.body.logs), 'logs body has a logs array');

      // GET /api/health returns 200 and is excluded from perf recording.
      const health = await getJSON(`${base}/api/health`);
      assert.equal(health.status, 200, 'GET /api/health returns 200');
      assert.equal(health.body.status, 'ok', 'health reports status ok');

      // OPTIONS short circuits to 204 before dispatch and records no metric.
      const options = await getJSON(`${base}/api/logs`, { method: 'OPTIONS' });
      assert.equal(options.status, 204, 'OPTIONS returns 204');

      // GET /api/debug/memory observes perfMetrics before its own metric lands.
      // Only the earlier GET /api/logs qualified (health and OPTIONS are skipped),
      // so exactly one endpoint is tracked, keyed by the deduped pathname.
      const mem = await getJSON(`${base}/api/debug/memory`);
      assert.equal(mem.status, 200, 'GET /api/debug/memory returns 200');
      assert.equal(
        mem.body.perfMetricsEndpoints,
        1,
        'exactly one perf endpoint recorded via the reused pathname',
      );
    } finally {
      child.kill('SIGKILL');
    }
  });
});
