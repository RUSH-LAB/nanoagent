import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import {history, historyField, undo} from '@codemirror/commands';
import {EditorSelection, EditorState} from '@codemirror/state';
import {memoryStore} from '../../../../src/utils/documentCache.js';
import {
  editorViews, liveSelection, relativeSelection, textStateJSON,
} from '../../../../src/components/Workbench/viewState.js';

const scope = {userId: 'u1', workspaceId: 'w1'};
const settle = () => new Promise(resolve => setTimeout(resolve, 5));

describe('editor view records', () => {
  it('keep the selection and scroll by user, workspace and path, never the editor state', async () => {
    const store = memoryStore();
    const views = editorViews(store, () => scope, {delay: 1});
    const state = EditorState.create({doc: 'hello world', selection: EditorSelection.single(2, 5)});
    views.set('a.txt', {state});
    views.set('a.txt', {scrollTop: 40});
    assert.equal(views.get('a.txt').state, state);
    await settle();
    assert.deepEqual(await store.get('fsview|u1|w1|a.txt'), {scrollTop: 40, anchor: 2, head: 5});
  });

  it('keep nothing without a scope, and load a kept record only for a tab without one', async () => {
    const store = memoryStore();
    await store.set('fsview|u1|w1|a.txt', {anchor: 1, head: 1, scrollTop: 0});
    let current = null;
    const views = editorViews(store, () => current, {delay: 1});
    views.set('b.txt', {scrollTop: 3});
    await settle();
    assert.equal(await store.get('fsview|u1|w1|b.txt'), undefined);
    current = scope;
    await views.load('a.txt');
    assert.deepEqual(views.get('a.txt'), {anchor: 1, head: 1, scrollTop: 0});
    views.set('a.txt', {scrollTop: 9});
    await views.load('a.txt');
    assert.equal(views.get('a.txt').scrollTop, 9);
  });

  it('write a closed tab at once and drop it from memory', async () => {
    const store = memoryStore();
    const views = editorViews(store, () => scope, {delay: 60_000});
    views.set('a.txt', {anchor: 3, head: 3, scrollTop: 7});
    await views.close('a.txt');
    assert.equal(views.get('a.txt'), undefined);
    assert.deepEqual(await store.get('fsview|u1|w1|a.txt'), {anchor: 3, head: 3, scrollTop: 7});
  });

  it('follow renames, in memory and in the store', async () => {
    const store = memoryStore();
    await store.set('fsview|u1|w1|docs/closed.txt', {anchor: 0, head: 0, scrollTop: 5});
    await store.set('fsview|u1|w1|other.txt', {anchor: 0, head: 0, scrollTop: 6});
    const views = editorViews(store, () => scope, {delay: 60_000});
    views.set('docs/open.txt', {anchor: 2, head: 2, scrollTop: 1});
    const moved = path => (path.startsWith('docs/') ? `notes/${path.slice('docs/'.length)}` : path);
    const moving = views.move(moved);
    assert.deepEqual(views.get('notes/open.txt'), {anchor: 2, head: 2, scrollTop: 1});
    assert.equal(views.get('docs/open.txt'), undefined);
    await moving;
    assert.deepEqual((await store.entries('fsview|')).map(([key]) => key), [
      'fsview|u1|w1|notes/closed.txt', 'fsview|u1|w1|notes/open.txt', 'fsview|u1|w1|other.txt',
    ]);
  });
});

describe('text editor state', () => {
  it('restores a tab seen before with its undo history', () => {
    let state = EditorState.create({doc: 'one', extensions: [history()]});
    state = state.update({changes: {from: 3, insert: ' two'}, selection: {anchor: 7}}).state;
    const json = textStateJSON({state, scrollTop: 0}, 'one two');
    const restored = EditorState.fromJSON(json, {extensions: [history()]}, {history: historyField});
    assert.equal(restored.doc.toString(), 'one two');
    assert.equal(restored.selection.main.head, 7);
    let undone = null;
    undo({state: restored, dispatch: transaction => { undone = transaction.state; }});
    assert.equal(undone.doc.toString(), 'one');
  });

  it('starts from the text read in while the tab was hidden, at its kept selection', () => {
    const state = EditorState.create({doc: 'old text', selection: EditorSelection.single(3)});
    const json = textStateJSON({state}, 'new');
    assert.equal(json.doc, 'new');
    assert.deepEqual(json.selection, {ranges: [{anchor: 3, head: 3}], main: 0});
    assert.equal(json.history, undefined);
  });

  it('starts a reopened file at its kept selection, cut to the text', () => {
    assert.deepEqual(textStateJSON({anchor: 2, head: 40}, 'short').selection, {ranges: [{anchor: 2, head: 5}], main: 0});
    assert.deepEqual(textStateJSON(undefined, 'text'), {doc: 'text', selection: {ranges: [{anchor: 0, head: 0}], main: 0}});
  });
});

describe('live editor selection', () => {
  it('stays on its text through edits made before it', () => {
    const doc = new Y.Doc();
    const text = doc.getText('markdown');
    text.insert(0, 'hello world');
    const record = JSON.parse(JSON.stringify(relativeSelection(text, {anchor: 6, head: 11})));
    text.insert(0, '>> ');
    const selection = liveSelection(text, record);
    assert.deepEqual([selection.main.anchor, selection.main.head], [9, 14]);
  });

  it('is unknown in a document that does not hold its text', () => {
    const doc = new Y.Doc();
    doc.getText('markdown').insert(0, 'abc');
    const record = relativeSelection(doc.getText('markdown'), {anchor: 1, head: 2});
    assert.equal(liveSelection(new Y.Doc().getText('markdown'), record), undefined);
    assert.equal(liveSelection(doc.getText('markdown'), undefined), undefined);
  });
});
