import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

describe('API documentation completeness', () => {
  const serverCode = fs.readFileSync(path.join(projectRoot, 'server.js'), 'utf8');
  const apiDocsCode = fs.readFileSync(path.join(projectRoot, 'src/pages/api-docs.js'), 'utf8');

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
      '/api/health', '/api/file', '/api/files', '/api/comments',
      '/api/discussions', '/api/notes', '/api/references', '/api/analytics',
      '/api/users', '/api/presence', '/api/graph', '/api/backlinks',
      '/api/trash', '/api/bookmarks', '/api/reading-lists', '/api/streak',
      '/api/annotations', '/api/search', '/api/stats', '/api/templates',
      '/api/recommendations', '/api/upload', '/api/notifications',
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

  it('server.js imports utilities from lib/server-utils.js', () => {
    assert.ok(
      serverCode.includes("require('./lib/server-utils')"),
      'server.js should import from lib/server-utils',
    );
  });

  it('server.js has health endpoint', () => {
    assert.ok(serverCode.includes('/api/health'), 'has /api/health');
  });

  it('server.js has rate limiting on sensitive endpoints', () => {
    const rateLimitedEndpoints = (serverCode.match(/rateLimit\(/g) || []).length;
    assert.ok(rateLimitedEndpoints >= 5, `Only ${rateLimitedEndpoints} rate-limited endpoints, expected >= 5`);
  });

  it('server.js has graceful shutdown handlers', () => {
    assert.ok(serverCode.includes('SIGINT'), 'has SIGINT handler');
    assert.ok(serverCode.includes('SIGTERM'), 'has SIGTERM handler');
  });

  it('server.js has error handlers', () => {
    assert.ok(serverCode.includes('uncaughtException'), 'has uncaughtException handler');
    assert.ok(serverCode.includes('unhandledRejection'), 'has unhandledRejection handler');
  });
});
