import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const {usesLegacyDocumentFilesystem} = require('../../../src/server/document-filesystem-routing.js');

test('database-native page loading endpoints bypass the legacy snapshot', () => {
  for (const pathname of [
    '/api/content',
    '/api/content/posts/example?include=frontmatter',
    '/api/site',
    '/api/assets/example.png',
    '/api/file',
    '/api/files',
    '/api/chat/messages',
    '/api/org/members',
    '/api/analytics/pageview',
  ]) {
    assert.equal(usesLegacyDocumentFilesystem(pathname.split('?')[0]), false, pathname);
  }
});

test('legacy analysis endpoints retain the document filesystem adapter', () => {
  for (const pathname of ['/api/feed', '/api/quality', '/api/stats/timeline']) {
    assert.equal(usesLegacyDocumentFilesystem(pathname), true, pathname);
  }
});
