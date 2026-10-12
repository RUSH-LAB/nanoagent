import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {workspaceAssetHref, workspaceDocumentHref} from '../../../../src/utils/documentUrls.js';

describe('workspace document links', () => {
  it('keeps external and anchor links unchanged', () => {
    assert.equal(workspaceDocumentHref('https://example.com', 'lab', 'books/a.md'), 'https://example.com');
    assert.equal(workspaceDocumentHref('#result', 'lab', 'books/a.md'), '#result');
  });

  it('resolves relative Markdown links inside the current workspace', () => {
    assert.equal(
      workspaceDocumentHref('../next.md#proof', 'lab space', 'books/chapter/current.md'),
      '/w/lab%20space/documents/books/next#proof',
    );
  });

  it('scopes legacy root document links while preserving application routes', () => {
    assert.equal(workspaceDocumentHref('/math/intro', 'lab', 'index.md'), '/w/lab/documents/math/intro');
    assert.equal(workspaceDocumentHref('/w/other/documents/a', 'lab', 'index.md'), '/w/other/documents/a');
    assert.equal(workspaceDocumentHref('/api/health', 'lab', 'index.md'), '/api/health');
  });

  it('does not let a relative link escape the workspace document root', () => {
    assert.equal(workspaceDocumentHref('../../../outside.md', 'lab', 'a.md'), '#');
  });
});

describe('workspaceAssetHref', () => {
  it('resolves a relative image beside its database document', () => {
    assert.equal(
      workspaceAssetHref('./assets/plot.png', 'workspace 1', 'books/chapter/page.md'),
      '/api/workspaces/workspace%201/assets?path=books%2Fchapter%2Fassets%2Fplot.png',
    );
  });

  it('leaves static, external, and data images alone', () => {
    assert.equal(workspaceAssetHref('/img/logo.png', 'w', 'a.md'), '/img/logo.png');
    assert.equal(workspaceAssetHref('https://example.com/a.png', 'w', 'a.md'), 'https://example.com/a.png');
    assert.equal(workspaceAssetHref('data:image/png;base64,x', 'w', 'a.md'), 'data:image/png;base64,x');
  });
});
