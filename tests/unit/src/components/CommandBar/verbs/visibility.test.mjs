import {describe, it} from 'node:test';
import assert from 'node:assert/strict';

// `when(ctx)` decides what the slash menu offers, and it is the only part of a
// verb that runs on every keystroke. Two things are pinned here: which verbs
// each kind of pane offers, and that a `when` reads nothing but the pane and
// the chat hook. The second one matters because the caller filters this list
// before it has a full context to filter it with: the full context carries the
// command list, and the command list is what the filter is producing.
import {VERBS} from '../../../../../../src/components/CommandBar/verbs.js';
import {ALICE, DESIGN, DM, makeCtx} from './_fakeCtx.mjs';

/** The verb names a pane in this state would offer. */
function offered(options) {
  const {ctx} = makeCtx(options);
  return VERBS.filter((v) => !v.when || v.when({session: ctx.session, chat: ctx.chat})).map((v) => v.name);
}

const ARCHIVED_PANE = {
  // Archiving takes a channel out of the directory, so a pane pointed at one is
  // pointed at a channel the list no longer has.
  target: {channelId: 'c-gone', label: '#gone'},
  channels: [DM],
};

describe('what a pane offers', () => {
  it('offers no channel verb on the assistant', () => {
    const names = offered({target: null});
    for (const hidden of ['leave', 'add', 'kick', 'rename', 'topic', 'archive', 'unarchive', 'delete', 'ai']) {
      assert.ok(!names.includes(hidden), `/${hidden} makes no sense on the assistant`);
    }
    for (const shown of ['help', 'clear', 'split', 'close', 'dm', 'join', 'new', 'who', 'invite']) {
      assert.ok(names.includes(shown), `/${shown} should be offered on the assistant`);
    }
  });

  it('offers the channel verbs on a channel this caller administers', () => {
    const names = offered({});
    for (const shown of ['leave', 'add', 'kick', 'rename', 'topic', 'archive', 'delete', 'ai', 'who']) {
      assert.ok(names.includes(shown), `/${shown} should be offered on a channel`);
    }
    assert.ok(!names.includes('unarchive'), 'the channel is not archived');
  });

  it('hides from a direct message everything a direct message has not got', () => {
    const names = offered({target: {channelId: DM.id, label: '@alice'}});
    for (const hidden of ['leave', 'add', 'kick', 'rename', 'topic', 'archive', 'unarchive']) {
      assert.ok(!names.includes(hidden), `/${hidden} has no meaning in a dm`);
    }
    // Your own line is still yours to take back, and asking is still asking.
    assert.ok(names.includes('delete'));
    assert.ok(names.includes('ai'));
  });

  it('hides the administrative verbs from a member who does not administer', () => {
    const member = {
      you: {userId: 'u-alice', role: 'member', canManage: false},
      people: [ALICE],
    };
    const names = offered(member);
    for (const hidden of ['add', 'kick', 'rename', 'topic', 'archive', 'invite']) {
      assert.ok(!names.includes(hidden), `/${hidden} is not a member's to run`);
    }
    for (const shown of ['leave', 'delete', 'who', 'ai']) {
      assert.ok(names.includes(shown), `/${shown} is anybody's to run`);
    }
  });

  it("offers them to the channel's creator, who administers it without managing the organization", () => {
    const names = offered({
      you: {userId: 'u-maker', role: 'member', canManage: false},
      channels: [{...DESIGN, createdBy: 'u-maker'}, DM],
    });
    for (const shown of ['add', 'kick', 'rename', 'topic', 'archive']) {
      assert.ok(names.includes(shown), `/${shown} belongs to whoever made the channel`);
    }
    assert.ok(!names.includes('invite'), 'the organization is still not theirs to invite into');
  });

  it('offers /unarchive, and only it, once the channel has left the directory', () => {
    const names = offered(ARCHIVED_PANE);
    assert.ok(names.includes('unarchive'));
    for (const hidden of ['archive', 'rename', 'topic', 'add', 'kick']) {
      assert.ok(!names.includes(hidden), `/${hidden} cannot apply to an archived channel`);
    }
  });

  it('waits for the directory before reading anything into a missing channel', () => {
    // Every channel is missing while the first request is in flight, and a menu
    // that offered /unarchive on every pane for those few hundred milliseconds
    // would be lying about all of them.
    const names = offered({...ARCHIVED_PANE, status: 'loading'});
    assert.ok(!names.includes('unarchive'));
  });

  it('hides what needs a signed-in reader when there is none', () => {
    const names = offered({you: null, target: null});
    assert.ok(!names.includes('invite'));
    assert.ok(names.includes('help'), 'help never depends on who is asking');
  });
});

describe('what a when may read', () => {
  it('touches nothing but the pane and the chat hook', () => {
    // A Proxy over the context that refuses anything else, so a `when` that
    // reached for `sessions` or `commands` fails here rather than in the wiring
    // that has neither to give it yet.
    const {ctx} = makeCtx({});
    const allowed = new Set(['session', 'chat']);
    const guarded = new Proxy({session: ctx.session, chat: ctx.chat}, {
      get(target, key) {
        if (typeof key === 'symbol' || allowed.has(key)) return target[key];
        throw new Error(`when() read ctx.${String(key)}`);
      },
    });
    for (const command of VERBS) {
      if (!command.when) continue;
      assert.doesNotThrow(() => command.when(guarded), `/${command.name}`);
    }
  });

  it('is safe before the chat hook has answered at all', () => {
    const empty = {session: {id: 's1', target: null}, chat: {status: 'loading', channels: [], people: [], you: null}};
    for (const command of VERBS) {
      if (!command.when) continue;
      assert.equal(typeof command.when(empty), 'boolean', `/${command.name} answered with something else`);
    }
    // And with no chat object whatsoever, which is what a signed-out window is
    // one render away from.
    for (const command of VERBS) {
      if (!command.when) continue;
      assert.doesNotThrow(() => command.when({session: {id: 's1', target: null}, chat: undefined}));
    }
  });
});
