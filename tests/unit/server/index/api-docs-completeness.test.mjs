import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..', '..', '..', '..');

describe('API documentation completeness', () => {
  const serverCode = fs.readFileSync(path.join(projectRoot, 'src/server/index.js'), 'utf8');
  const apiDocsCode = fs.readFileSync(path.join(projectRoot, 'src/pages/api-docs/index.js'), 'utf8');

  // Route handlers live in server/index.js (core) plus the per-domain modules under
  // api/routes/. Assertions about handler code scan the combined source.
  const routesDir = path.join(projectRoot, 'src', 'server', 'routes');
  const routesCode = fs.existsSync(routesDir)
    ? fs.readdirSync(routesDir)
        .filter(f => f.endsWith('.js'))
        .map(f => fs.readFileSync(path.join(routesDir, f), 'utf8'))
        .join('\n')
    : '';
  const allHandlerCode = serverCode + '\n' + routesCode;

  function extractServerEndpoints() {
    const endpoints = new Set();
    const patterns = [
      /pathname === '(\/api\/[^']+)'/g,
      /pathname\.match\(\/\^\\\/api\\\/([^$]+)\$\/\)/g,
    ];

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(serverCode)) !== null) {
        endpoints.add(match[1]);
      }
    }
    return endpoints;
  }

  function extractDocumentedPaths() {
    const paths = new Set();
    const re = /path:\s*'(\/api\/[^']+)'/g;
    let match;
    while ((match = re.exec(apiDocsCode)) !== null) {
      paths.add(match[1]);
    }
    return paths;
  }

  it('has documentation for all major endpoint groups', () => {
    const requiredGroups = [
      '/api/health', '/api/file', '/api/files', '/api/notes', '/api/references', '/api/analytics',
      '/api/users', '/api/graph', '/api/backlinks',
      '/api/trash', '/api/bookmarks', '/api/reading-lists', '/api/streak',
      '/api/search', '/api/stats',
      '/api/recommendations',
      '/api/folder', '/api/ai', '/api/metadata',
    ];
    const docPaths = extractDocumentedPaths();
    const missing = requiredGroups.filter(group =>
      ![...docPaths].some(dp => dp.startsWith(group)),
    );
    assert.equal(
      missing.length, 0,
      `Missing endpoint groups from docs: ${missing.join(', ')}`,
    );
  });

  it('api-docs.js has at least 70 endpoint entries', () => {
    const count = (apiDocsCode.match(/method:\s*'/g) || []).length;
    assert.ok(count >= 70, `Only ${count} endpoints documented, expected >= 70`);
  });

  it('api-docs.js covers all HTTP methods', () => {
    const methods = new Set();
    const re = /method:\s*'([A-Z]+)'/g;
    let match;
    while ((match = re.exec(apiDocsCode)) !== null) {
      methods.add(match[1]);
    }
    assert.ok(methods.has('GET'), 'has GET');
    assert.ok(methods.has('POST'), 'has POST');
    assert.ok(methods.has('PUT'), 'has PUT');
    assert.ok(methods.has('DELETE'), 'has DELETE');
    assert.ok(methods.has('PATCH'), 'has PATCH');
  });

  it('server/index.js imports utilities from server/server-utils.js', () => {
    assert.ok(
      serverCode.includes("require('./server-utils')"),
      'server/index.js should import from server/server-utils',
    );
  });

  it('server/index.js has health endpoint', () => {
    assert.ok(serverCode.includes('/api/health'), 'has /api/health');
  });

  it('has rate limiting on sensitive endpoints', () => {
    const rateLimitedEndpoints = (allHandlerCode.match(/rateLimit\(/g) || []).length;
    assert.ok(rateLimitedEndpoints >= 5, `Only ${rateLimitedEndpoints} rate-limited endpoints, expected >= 5`);
  });

  it('server/index.js has graceful shutdown handlers', () => {
    assert.ok(serverCode.includes('SIGINT'), 'has SIGINT handler');
    assert.ok(serverCode.includes('SIGTERM'), 'has SIGTERM handler');
  });

  it('server/index.js has error handlers', () => {
    assert.ok(serverCode.includes('uncaughtException'), 'has uncaughtException handler');
    assert.ok(serverCode.includes('unhandledRejection'), 'has unhandledRejection handler');
  });
});
