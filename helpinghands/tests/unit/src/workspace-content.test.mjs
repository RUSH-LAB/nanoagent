import {describe, it} from 'node:test';
import assert from 'node:assert/strict';

const {workspaceContentPlan, workspaceHomeLayout} = await import('../../../src/utils/workspaceContent.js');

const site = {
  collections: [
    {key: 'papers', type: 'blog', pathPrefix: 'library/papers'},
    {key: 'manual', type: 'docs', pathPrefix: 'knowledge/manual'},
  ],
};

describe('workspace content request planning', () => {
  it('opens the documents page on the list unless the owner chose a page', () => {
    assert.equal(workspaceHomeLayout({}), 'library');
    assert.equal(workspaceHomeLayout({site: {homeLayout: 'document'}}), 'document');
  });

  it('uses configured blog collections without assuming a posts directory', () => {
    const plan = workspaceContentPlan(site, 'library/papers');
    assert.equal(plan.isCollection, true);
    assert.equal(plan.treeQuery, '?prefix=library%2Fpapers&include=metadata');
  });

  it('uses configured docs collections without assuming a books directory', () => {
    const plan = workspaceContentPlan(site, 'knowledge/manual/chapter-one');
    assert.equal(plan.isCollection, false);
    assert.equal(plan.treeQuery, '?prefix=knowledge%2Fmanual&include=metadata');
  });

  it('falls back to the requested path for an unconfigured workspace', () => {
    const plan = workspaceContentPlan(null, 'notes');
    assert.equal(plan.isCollection, false);
    assert.equal(plan.treeQuery, '?prefix=notes&include=metadata');
  });
});
