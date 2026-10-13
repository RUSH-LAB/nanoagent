import {describe, it} from 'node:test';
import assert from 'node:assert/strict';

const {
  adjacentDocumentPosition, newDocumentDraft, slugifyDocumentTitle,
} = await import('../../../src/utils/documentAuthoring.js');

describe('runtime document authoring', () => {
  it('turns a page title into a safe path and useful Markdown draft', () => {
    const draft = newDocumentDraft({
      collection: {type: 'docs', pathPrefix: 'books/guide'},
      title: 'Getting Started',
    });
    assert.equal(draft.path, 'books/guide/getting-started.md');
    assert.equal(draft.type, 'page');
    assert.match(draft.markdown, /title: "Getting Started"/);
    assert.match(draft.markdown, /# Getting Started/);
  });

  it('includes an adjacent page position when one is supplied', () => {
    const draft = newDocumentDraft({
      collection: {type: 'docs', pathPrefix: 'books/guide/chapter'},
      title: 'Inserted Topic',
      sidebarPosition: 2.5,
    });
    assert.equal(draft.path, 'books/guide/chapter/inserted-topic.md');
    assert.match(draft.markdown, /sidebar_position: 2\.5/);
  });

  it('places a page between its numbered siblings', () => {
    const documents = [
      {path: 'books/guide/1-first.md', frontmatter: {sidebarPosition: 1}},
      {path: 'books/guide/2-second.md', frontmatter: {sidebarPosition: 2}},
      {path: 'books/guide/3-third.md', frontmatter: {sidebarPosition: 3}},
      {path: 'books/other/1-unrelated.md', frontmatter: {sidebarPosition: 1}},
    ];
    assert.equal(adjacentDocumentPosition(documents, 'books/guide/2-second.md', 'before'), 1.5);
    assert.equal(adjacentDocumentPosition(documents, 'books/guide/2-second.md', 'after'), 2.5);
  });

  it('uses filename order when sidebar frontmatter is absent', () => {
    const documents = [
      {path: 'books/guide/1-first.md', frontmatter: {}},
      {path: 'books/guide/2-second.md', frontmatter: {}},
    ];
    assert.equal(adjacentDocumentPosition(documents, 'books/guide/1-first.md', 'after'), 1.5);
  });

  it('creates blog frontmatter with its author\'s GitHub username', () => {
    const draft = newDocumentDraft({
      collection: {type: 'blog', pathPrefix: 'posts/blog'},
      title: 'A New Idea',
      author: 'ada',
      group: 'Research',
      now: new Date('2026-09-10T12:00:00Z'),
    });
    assert.equal(draft.path, 'posts/blog/a-new-idea.md');
    assert.equal(draft.type, 'post');
    assert.match(draft.markdown, /slug: a-new-idea/);
    assert.match(draft.markdown, /date: 2026-09-10/);
    assert.match(draft.markdown, /authors: \["ada"\]/);
    assert.match(draft.markdown, /group: "Research"/);
  });

  it('chooses the next unused path without changing the title', () => {
    const draft = newDocumentDraft({
      collection: {type: 'docs', pathPrefix: 'pages'},
      title: 'Résumé',
      existingPaths: ['pages/resume.mdx', 'pages/resume-2/index.md'],
    });
    assert.equal(slugifyDocumentTitle('Résumé'), 'resume');
    assert.equal(draft.path, 'pages/resume-3.md');
    assert.match(draft.markdown, /title: "Résumé"/);
  });

  it('falls back to an explicit page name for titles without ASCII letters', () => {
    const draft = newDocumentDraft({
      collection: {type: 'docs', pathPrefix: 'pages'},
      title: '研究',
    });
    assert.equal(draft.path, 'pages/new-page.md');
  });
});
