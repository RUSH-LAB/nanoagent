import {describe, it} from 'node:test';
import assert from 'node:assert/strict';

// verbs.js holds no JSX and no React, so the real verbs run here against a
// faked context. What is pinned below is the contract the pane depends on: a
// verb answers, a refusal names what was refused, an argument that names
// nothing or two things is refused rather than guessed, and the sentence at the
// end quotes the server rather than the typing.
import {VERBS} from '../../../../../../src/components/CommandBar/verbs.js';
import {runCommand} from '../../../../../../src/components/CommandBar/commandRuntime.js';
import {DESIGN, DM, callsTo, makeCtx, spoke} from './_fakeCtx.mjs';

const verb = (name) => {
  const found = VERBS.find((v) => v.name === name);
  assert.ok(found, `there is no /${name}`);
  return found;
};

/** Run one verb the way the CLI runs it, through the runtime that catches. */
const run = (name, argLine, options) => {
  const made = makeCtx(options);
  return runCommand(verb(name), argLine, made.ctx).then(() => made);
};

const ASSISTANT_PANE = {target: null};

describe('/dm', () => {
  it('opens the conversation and points the pane at it', async () => {
    const {log} = await run('dm', '@alice', {sessionId: 'dm-1', ...ASSISTANT_PANE});
    assert.deepEqual(callsTo(log, 'openDm'), [['openDm', 'u-alice']]);
    assert.deepEqual(log.targets, [['dm-1', {channelId: DM.id, label: '@alice'}]]);
    assert.deepEqual(log.notes, ['this pane is now @alice']);
  });

  it('refuses a name that matches nobody, saying which name', async () => {
    const {log} = await run('dm', 'nobody', {sessionId: 'dm-2', ...ASSISTANT_PANE});
    assert.deepEqual(log.fails, ['/dm: no single person here matches nobody']);
    assert.deepEqual(callsTo(log, 'openDm'), [], 'nothing was opened');
    assert.deepEqual(log.targets, []);
  });

  it('says what it wanted when it was given nothing', async () => {
    const {log} = await run('dm', '   ', {sessionId: 'dm-3', ...ASSISTANT_PANE});
    assert.deepEqual(log.fails, ['/dm needs an argument: /dm @person']);
  });
});

describe('/join', () => {
  it('joins the named channel and opens it', async () => {
    const {log} = await run('join', '#design', {sessionId: 'j-1', ...ASSISTANT_PANE});
    assert.deepEqual(callsTo(log, 'join'), [['join', 'c-design']]);
    assert.deepEqual(log.targets, [['j-1', {channelId: 'c-design', label: '#design'}]]);
    assert.deepEqual(log.notes, ['joined #design']);
  });

  it('says so when the server reports you were already in', async () => {
    const {log} = await run('join', 'design', {
      sessionId: 'j-2', ...ASSISTANT_PANE,
      writes: {join: {channel: DESIGN, joined: false}},
    });
    assert.deepEqual(log.notes, ['you were already in #design, so this pane is on it']);
  });

  it('refuses an unknown channel by name and joins nothing', async () => {
    const {log} = await run('join', '#nope', {sessionId: 'j-3', ...ASSISTANT_PANE});
    assert.deepEqual(log.fails, ['/join: no single channel here matches #nope']);
    assert.deepEqual(callsTo(log, 'join'), []);
  });
});

describe('/new', () => {
  it('sends the name without its sigil and opens what came back', async () => {
    const {log} = await run('new', '#Design Team', {
      sessionId: 'n-1', ...ASSISTANT_PANE,
      writes: {createChannel: {channel: {...DESIGN, id: 'c-made', name: 'design-team'}}},
    });
    // The '#' is ours, not the server's: it normalises spacing and case and
    // would keep a hash as part of the name.
    assert.deepEqual(callsTo(log, 'createChannel'), [['createChannel', 'Design Team']]);
    assert.deepEqual(log.targets, [['n-1', {channelId: 'c-made', label: '#design-team'}]]);
    assert.deepEqual(log.notes, ['created #design-team'], 'the server spelling, not the typed one');
  });

  it('opens the channel without naming it when only an id came back', async () => {
    const {log} = await run('new', 'design team', {sessionId: 'n-2', ...ASSISTANT_PANE});
    assert.deepEqual(log.targets, [['n-2', {channelId: 'c-new', label: '#design team'}]]);
    assert.deepEqual(log.notes, ['created the channel and opened it']);
  });

  it('needs a name', async () => {
    const {log} = await run('new', '', {sessionId: 'n-3', ...ASSISTANT_PANE});
    assert.deepEqual(log.fails, ['/new needs an argument: /new #name']);
    assert.deepEqual(callsTo(log, 'createChannel'), []);
  });
});

describe('/rename and /topic', () => {
  it('reports the name the server settled on', async () => {
    const {log} = await run('rename', 'My Room', {
      sessionId: 'r-1',
      writes: {update: {channel: {...DESIGN, name: 'my-room'}}},
    });
    assert.deepEqual(callsTo(log, 'update'), [['update', 'c-design', {name: 'My Room'}]]);
    assert.deepEqual(log.notes, ['#design is now #my-room']);
    assert.deepEqual(log.targets, [['r-1', {channelId: 'c-design', label: '#my-room'}]]);
  });

  it('sets a topic and quotes back the stored one', async () => {
    const {log} = await run('topic', '  pixels and paint  ', {
      sessionId: 't-1',
      writes: {update: {channel: {...DESIGN, topic: 'pixels and paint'}}},
    });
    assert.deepEqual(callsTo(log, 'update'), [['update', 'c-design', {topic: 'pixels and paint'}]]);
    assert.deepEqual(log.notes, ['topic of #design: pixels and paint']);
  });

  it('treats an empty line as clearing the topic rather than as a missing argument', async () => {
    const {log} = await run('topic', '', {
      sessionId: 't-2',
      writes: {update: {channel: {...DESIGN, topic: null}}},
    });
    assert.deepEqual(callsTo(log, 'update'), [['update', 'c-design', {topic: ''}]]);
    assert.deepEqual(log.notes, ['cleared the topic of #design']);
    assert.deepEqual(log.fails, []);
  });
});

describe('/add', () => {
  it('adds the person the argument names', async () => {
    const {log} = await run('add', '@alice', {sessionId: 'a-1'});
    assert.deepEqual(callsTo(log, 'addMember'), [['addMember', 'c-design', 'u-alice']]);
    assert.deepEqual(log.notes, ['added @alice to #design']);
  });

  it('says so when the server reports they were already in', async () => {
    const {log} = await run('add', 'alice', {sessionId: 'a-2', writes: {addMember: {added: false}}});
    assert.deepEqual(log.notes, ['@alice was already in #design']);
  });

  it('refuses when the pane is on the assistant, and does not write', async () => {
    const {log} = await run('add', '@alice', {sessionId: 'a-3', ...ASSISTANT_PANE});
    assert.deepEqual(log.fails, ['/add needs a conversation: this pane is on the assistant']);
    assert.deepEqual(callsTo(log, 'addMember'), []);
  });
});

describe('/kick', () => {
  it('asks once and says so, then removes on the second try', async () => {
    const made = makeCtx({sessionId: 'k-1'});
    await runCommand(verb('kick'), '@alice', made.ctx);
    assert.deepEqual(
      made.log.notes,
      ['/kick @alice again within five seconds to remove them from #design'],
    );
    assert.deepEqual(callsTo(made.log, 'removeMember'), [], 'nobody is removed by the first line');

    await runCommand(verb('kick'), '@alice', made.ctx);
    assert.deepEqual(callsTo(made.log, 'removeMember'), [['removeMember', 'c-design', 'u-alice']]);
    assert.equal(made.log.notes[1], 'removed @alice from #design');
  });

  it('confirms one person at a time', async () => {
    const made = makeCtx({sessionId: 'k-2'});
    await runCommand(verb('kick'), '@alice', made.ctx);
    await runCommand(verb('kick'), '@bob', made.ctx);
    assert.deepEqual(callsTo(made.log, 'removeMember'), [], 'asking about Bob is not confirming Alice');
    assert.equal(made.log.notes.length, 2);
  });

  it('refuses an unknown person before asking to confirm anything', async () => {
    const {log} = await run('kick', 'someone', {sessionId: 'k-3'});
    assert.deepEqual(log.fails, ['/kick: no single person here matches someone']);
    assert.deepEqual(log.notes, []);
  });
});

describe('/delete', () => {
  it('confirms, then deletes the reader’s most recent message that is still there', async () => {
    const made = makeCtx({sessionId: 'd-1'});
    await runCommand(verb('delete'), '', made.ctx);
    assert.deepEqual(
      made.log.notes,
      ['/delete again within five seconds to delete "the newest thing I said"'],
    );
    assert.deepEqual(callsTo(made.log, 'deleteMessage'), []);

    await runCommand(verb('delete'), '', made.ctx);
    // m5 is newer and already a tombstone; m4 is somebody else's.
    assert.deepEqual(callsTo(made.log, 'deleteMessage'), [['deleteMessage', 'm3']]);
    assert.equal(made.log.notes[1], 'deleted "the newest thing I said"');
  });

  it('refuses when the reader has said nothing here', async () => {
    const {log} = await run('delete', '', {
      sessionId: 'd-2',
      messages: [{id: 'm1', seq: 1, userId: 'u-alice', body: 'only me', deletedAt: null}],
    });
    assert.deepEqual(log.fails, ['/delete: you have said nothing in #design that is still there']);
    assert.deepEqual(callsTo(log, 'deleteMessage'), []);
  });
});

describe('/leave and /archive', () => {
  it('leaves and puts the pane back on the assistant', async () => {
    const {log} = await run('leave', '', {sessionId: 'l-1'});
    assert.deepEqual(callsTo(log, 'leave'), [['leave', 'c-design']]);
    assert.deepEqual(log.targets, [['l-1', null]]);
    assert.deepEqual(log.notes, ['left #design; this pane is back on the assistant']);
  });

  it('says nothing happened when the server says nothing happened', async () => {
    const {log} = await run('leave', '', {sessionId: 'l-2', writes: {leave: {left: false}}});
    assert.deepEqual(log.notes, ['you were not in #design']);
    assert.deepEqual(log.targets, [], 'the pane stays where it was');
  });

  it('archives, and keeps the pane pointed at it so it can be brought back', async () => {
    const {log} = await run('archive', '', {sessionId: 'ar-1'});
    assert.deepEqual(callsTo(log, 'archive'), [['archive', 'c-design', true]]);
    assert.deepEqual(log.notes, ['archived #design; it is read-only until /unarchive']);
    assert.deepEqual(log.targets, []);
  });

  it('unarchives through the same write, the other way round', async () => {
    const {log} = await run('unarchive', '', {sessionId: 'ar-2', writes: {archive: {channel: DESIGN, changed: true}}});
    assert.deepEqual(callsTo(log, 'archive'), [['archive', 'c-design', false]]);
    assert.deepEqual(log.notes, ['brought #design back']);
  });
});

describe('/invite', () => {
  it('invites the address and reports the one the server recorded', async () => {
    const {log} = await run('invite', '  Norm@Example.com ', {
      sessionId: 'i-1',
      writes: {invite: {id: 'inv-7', email: 'norm@example.com'}},
    });
    assert.deepEqual(callsTo(log, 'invite'), [['invite', 'Norm@Example.com']]);
    assert.equal(log.notes.length, 1);
    assert.ok(log.notes[0].startsWith('invited norm@example.com;'), log.notes[0]);
    // Either the clipboard took it or the link itself is the answer; both name
    // the invitation, and neither leaves the reader without a way to send it.
    assert.ok(/clipboard|inv-7/.test(log.notes[0]), log.notes[0]);
  });

  it('needs an address', async () => {
    const {log} = await run('invite', '', {sessionId: 'i-2'});
    assert.deepEqual(log.fails, ['/invite needs an argument: /invite name@example.com']);
    assert.deepEqual(callsTo(log, 'invite'), []);
  });
});

describe('/who and /ai', () => {
  it('counts a channel from the directory row', async () => {
    const {log} = await run('who', '', {sessionId: 'w-1'});
    assert.deepEqual(log.notes, ['#design · 3 members']);
  });

  it('names the two people in a direct message', async () => {
    const {log} = await run('who', '', {sessionId: 'w-2', target: {channelId: DM.id, label: '@alice'}});
    assert.deepEqual(log.notes, ['@alice is a direct message: the two of you']);
  });

  it('lists the organization from an assistant pane', async () => {
    const {log} = await run('who', '', {sessionId: 'w-3', ...ASSISTANT_PANE});
    assert.deepEqual(log.notes, ['3 in this organization\n@alice @bob']);
  });

  it('asks the assistant without posting anything to the channel', async () => {
    const {log} = await run('ai', 'what did we decide?', {sessionId: 'ai-1'});
    assert.deepEqual(log.asked, [['ai-1', 'what did we decide?']]);
    assert.deepEqual(log.said, [], 'nothing reaches the channel');
    assert.deepEqual(log.notes, ['asking the assistant; nothing is posted to #design']);
  });

  it('needs a question', async () => {
    const {log} = await run('ai', '  ', {sessionId: 'ai-2'});
    assert.deepEqual(log.fails, ['/ai needs an argument: /ai what did we decide?']);
    assert.deepEqual(log.asked, []);
  });
});

describe('/close', () => {
  it('hangs up on whatever the pane was waiting for', async () => {
    // A closed pane has nowhere to draw an answer, and the route behind the
    // assistant only stops the provider when the client disconnects, so a close
    // that did not cancel would leave work running for nobody.
    const {log} = await run('close', '', {sessionId: 'x-1'});
    assert.deepEqual(callsTo(log, 'close'), [['close', 'x-1']]);
    assert.deepEqual(log.cancelled, ['x-1']);
  });

  it('leaves the last pane and its answer alone', async () => {
    const {log} = await run('close', '', {sessionId: 'x-2', closeResult: false});
    assert.deepEqual(log.fails, ['this is the only pane']);
    assert.deepEqual(log.cancelled, [], 'the pane is still there to show the answer');
  });
});

describe('every verb', () => {
  it('answers, whatever it is given', async () => {
    // The one rule that has no exception among the argument-taking verbs: run
    // one with nothing, from a pane where it may not even apply, and it still
    // says what happened or why it will not. Silence is the failure mode this
    // whole package exists to remove. The three that act on the pane itself are
    // deliberately quiet on success, and are pinned separately.
    const quietOnSuccess = new Set(['clear', 'split', 'close']);
    for (const command of VERBS) {
      if (quietOnSuccess.has(command.name)) continue;
      const made = makeCtx({sessionId: `silent-${command.name}`, ...ASSISTANT_PANE, commands: VERBS});
      await runCommand(command, '', made.ctx);
      assert.ok(spoke(made.log).length > 0, `/${command.name} said nothing`);
    }
  });

  it('has a usage line for each argument it takes, and none for the others', async () => {
    for (const command of VERBS) {
      assert.equal(typeof command.id, 'string');
      assert.equal(typeof command.name, 'string');
      assert.equal(typeof command.run, 'function');
      assert.ok(command.description, `/${command.name} has no description for the menu`);
      if (command.usage !== undefined) assert.equal(typeof command.usage, 'string');
    }
    assert.equal(VERBS.length, new Set(VERBS.map((v) => v.id)).size, 'two verbs share an id');
    assert.equal(verb('who').usage, undefined);
    assert.equal(verb('dm').usage, '@person');
  });
});
