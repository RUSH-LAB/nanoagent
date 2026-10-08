import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Characterization (add-only) test for the sidebar chapter-numbering helper.
//
// `computeNumbers` is authored as an ES module under src/theme (consumed by the
// Docusaurus build) and recursively walks a sidebar items tree, returning a Map
// from an item key to an entry { number, label }. The key is the item `href`
// for links, and `category:<label>` for categories (plus the href as a second
// key when a category also has one). Node's module-syntax detection lets this
// .mjs test import the .js source directly and read the named export, mirroring
// tests/next-fuzzymatch-empty-text-edges.test.mjs.
//
// The numbering rules pinned below:
//   - The counter increments for EVERY item regardless of type. `number` is
//     `${counter}` at the top level and `${prefix}.${counter}` inside a category.
//   - `entry.label` is `item.label || ''` (empty string when the label is absent).
//   - A 'link' adds `map.set(href, entry)` only when `href` is truthy; a hrefless
//     link advances the counter but adds no map entry.
//   - A 'category' ALWAYS adds `map.set('category:'+label, entry)`, ADDITIONALLY
//     adds the href key when present (two keys, one entry, same number), then
//     recurses into `item.items || []` with the prefix set to that number.
//   - Any other type (e.g. 'html') advances the counter but adds no map entry.
//
// The `label` field is LIVE: the math sidebar's PageRef reads `entry.label`, so
// pinning it asserts CORRECT current behavior, not dead state.
import { computeNumbers } from '../../../../src/contexts/SidebarNumberContext.js';

describe('computeNumbers (sidebar chapter numbering)', () => {
  it('numbers top-level items 1, 2, 3 in order', () => {
    const items = [
      { type: 'link', href: '/a', label: 'Alpha' },
      { type: 'link', href: '/b', label: 'Beta' },
      { type: 'link', href: '/c', label: 'Gamma' },
    ];
    assert.deepStrictEqual(
      computeNumbers(items),
      new Map([
        ['/a', { number: '1', label: 'Alpha' }],
        ['/b', { number: '2', label: 'Beta' }],
        ['/c', { number: '3', label: 'Gamma' }],
      ]),
    );
  });

  it('keys a category that has an href by both category:<label> and href at the same number', () => {
    const items = [{ type: 'category', label: 'Guides', href: '/guides', items: [] }];
    assert.deepStrictEqual(
      computeNumbers(items),
      new Map([
        ['category:Guides', { number: '1', label: 'Guides' }],
        ['/guides', { number: '1', label: 'Guides' }],
      ]),
    );
  });

  it('numbers nested children <parent>.<n> and a deeper level <p>.<n>.<m>', () => {
    const items = [
      { type: 'link', href: '/intro', label: 'Intro' },
      {
        type: 'category',
        label: 'Chapter',
        items: [
          { type: 'link', href: '/ch/overview', label: 'Overview' },
          {
            type: 'category',
            label: 'Section',
            items: [{ type: 'link', href: '/ch/sec/detail', label: 'Detail' }],
          },
        ],
      },
    ];
    assert.deepStrictEqual(
      computeNumbers(items),
      new Map([
        ['/intro', { number: '1', label: 'Intro' }],
        ['category:Chapter', { number: '2', label: 'Chapter' }],
        ['/ch/overview', { number: '2.1', label: 'Overview' }],
        ['category:Section', { number: '2.2', label: 'Section' }],
        ['/ch/sec/detail', { number: '2.2.1', label: 'Detail' }],
      ]),
    );
  });

  it('advances the counter for a hrefless link and a non-link/non-category item while adding no entries', () => {
    const items = [
      { type: 'link', label: 'Orphan link' }, // no href: counter advances, no entry
      { type: 'html', value: '<hr/>' }, // neither link nor category: no entry
      { type: 'link', href: '/third', label: 'Third' }, // lands on 3, proving 1 and 2 were consumed
    ];
    assert.deepStrictEqual(
      computeNumbers(items),
      new Map([['/third', { number: '3', label: 'Third' }]]),
    );
  });

  it('falls back to an empty-string label when item.label is absent', () => {
    const items = [{ type: 'link', href: '/no-label' }];
    assert.deepStrictEqual(
      computeNumbers(items),
      new Map([['/no-label', { number: '1', label: '' }]]),
    );
  });

  it('handles a category whose items key is absent via the || [] guard', () => {
    const items = [{ type: 'category', label: 'Empty' }]; // no items key at all
    assert.deepStrictEqual(
      computeNumbers(items),
      new Map([['category:Empty', { number: '1', label: 'Empty' }]]),
    );
  });
});
