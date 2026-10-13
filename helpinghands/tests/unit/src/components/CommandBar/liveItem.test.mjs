import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {
  firstSentence, latestSentence, liveItem, newestEntryId, plainText,
} from '../../../../../src/components/CommandBar/liveItem.js';

const chat = {chatId: 'c1', agentId: 'mochi'};
const entry = (id, kind, text, extra = {}) => ({id, kind, text, targetKey: 'chat:c1', ...extra});
const pane = (entries, extra = {}) => ({id: 1, target: chat, entries, busy: false, sendError: null, ...extra});
const notice = (id, seq, body, createdAt) => ({
  channel: {id, kind: 'public', name: id}, unread: 1, seq, author: 'ada', body, createdAt,
});

describe('the minimised line\'s text', () => {
  it('reads markdown as plain words', () => {
    assert.equal(plainText('## Title\n\n- **bold** and `code` [link](http://x)\n```js\nx()\n```'), 'Title bold and code link');
  });

  it('opens a finished answer with its first sentence', () => {
    assert.equal(firstSentence('The migration adds a table. Then it backfills.'), 'The migration adds a table.');
  });

  it('follows a streaming answer at its newest sentence, never a word or two', () => {
    assert.equal(latestSentence('First one is long enough here. Second one is the newest sentence'), 'Second one is the newest sentence');
    assert.equal(latestSentence('First one is long enough here. So'), 'First one is long enough here. So');
  });

  it('cuts a sentence that runs on, at the end that is not being read', () => {
    const long = 'word '.repeat(60).trim();
    assert.ok(firstSentence(long).endsWith('…') && firstSentence(long).length <= 160);
    assert.ok(latestSentence(long).startsWith('…') && latestSentence(long).length <= 160);
  });
});

describe('what the minimised line shows', () => {
  it('shows an answer while it streams, before and after its first words', () => {
    const asking = pane([entry(1, 'input', 'hi'), entry(2, 'output', '', {pending: true})], {busy: true});
    assert.deepEqual(liveItem({session: asking, label: 'Mochi', seenUpTo: 0, notices: []}), {kind: 'streaming', who: 'Mochi', text: null});
    asking.entries[1].text = 'Hello there, friend.';
    assert.equal(liveItem({session: asking, label: 'Mochi', seenUpTo: 0, notices: []}).text, 'Hello there, friend.');
  });

  it('shows what arrived unseen, and nothing once it has been seen', () => {
    const answered = pane([entry(1, 'input', 'hi'), entry(2, 'output', 'Done. More detail follows.')]);
    assert.deepEqual(liveItem({session: answered, label: 'Mochi', seenUpTo: 1, notices: []}), {kind: 'reply', who: 'Mochi', text: 'Done.'});
    assert.equal(liveItem({session: answered, label: 'Mochi', seenUpTo: newestEntryId(answered), notices: []}), null);
    const refused = pane([entry(3, 'error', 'unknown command: /zzz')]);
    assert.equal(liveItem({session: refused, label: 'Mochi', seenUpTo: 0, notices: []}).kind, 'error');
  });

  it('ranks the pane\'s own answer above a message elsewhere, and counts the rest', () => {
    const notices = [notice('general', 4, 'lunch?', '2026-10-12T12:00:00Z'), notice('dev', 9, 'deployed', '2026-10-12T11:00:00Z')];
    const answered = pane([entry(2, 'output', 'Done.')]);
    assert.equal(liveItem({session: answered, label: 'Mochi', seenUpTo: 0, notices}).kind, 'reply');
    const item = liveItem({session: answered, label: 'Mochi', seenUpTo: 2, notices});
    assert.deepEqual([item.kind, item.channel.id, item.author, item.text, item.more], ['message', 'general', 'ada', 'lunch?', 1]);
  });

  it('shows a message that could not be sent', () => {
    const refused = pane([], {target: {channelId: 'general'}, sendError: 'Too many requests'});
    assert.deepEqual(liveItem({session: refused, label: '#general', seenUpTo: 0, notices: []}), {kind: 'error', who: '#general', text: 'Too many requests'});
  });
});
