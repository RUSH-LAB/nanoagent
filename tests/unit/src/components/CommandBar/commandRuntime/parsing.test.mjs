import {describe, it} from 'node:test';
import assert from 'node:assert/strict';

// commandRuntime.js is the one part of the CLI that is worth unit testing and
// can be: it holds no React, no JSX and no browser API, so Node's module-syntax
// detection lets this .mjs test import the real source rather than a copy of
// it. Everything below pins the behaviour the rest of the CLI is built on: the
// verb/argument split that makes `/dm alice` possible at all, the ranking the
// slash menu draws, and the resolution `/help <verb>` reads.
import {
  parseCommand,
  rankCommands,
  resolveCommand,
} from '../../../../../../src/components/CommandBar/commandRuntime.js';

/* A registry shaped like the real one: verbs first, then a page command. */
const COMMANDS = [
  {id: 'v-add', name: 'add', category: 'Chat', description: 'Add someone to this channel', usage: '@person', run() {}},
  {id: 'v-ai', name: 'ai', category: 'Assistant', description: 'Ask a question', usage: 'question', run() {}},
  {id: 'v-archive', name: 'archive', category: 'Chat', description: 'Put this channel away', run() {}},
  {id: 'v-new', name: 'new', category: 'Chat', description: 'Create a channel', usage: '#name', run() {}},
  {id: 'v-unarchive', name: 'unarchive', category: 'Chat', description: 'Bring it back', run() {}},
  {id: 'p-people', name: 'people', category: 'Navigate', title: 'People', description: 'The directory', href: '/people'},
];

describe('parseCommand', () => {
  it('is null for anything that is not a command', () => {
    for (const line of ['hello', '', ' /late', null, undefined, 42, {}]) {
      assert.equal(parseCommand(line), null, `expected ${JSON.stringify(line)} to parse as not a command`);
    }
  });

  it('splits the verb from the rest of the line', () => {
    assert.deepEqual(parseCommand('/dm alice'), {verb: 'dm', args: ['alice'], argLine: 'alice'});
  });

  it('keeps the argument line whole, and also offers it as words', () => {
    assert.deepEqual(parseCommand('/rename  My   Room  '), {
      verb: 'rename',
      args: ['My', 'Room'],
      argLine: 'My   Room',
    });
  });

  it('has no arguments when only a verb was typed', () => {
    assert.deepEqual(parseCommand('/help'), {verb: 'help', args: [], argLine: ''});
    assert.deepEqual(parseCommand('/help   '), {verb: 'help', args: [], argLine: ''});
  });

  it('parses a bare slash as an empty verb, which is what opens the whole menu', () => {
    assert.deepEqual(parseCommand('/'), {verb: '', args: [], argLine: ''});
  });

  it('keeps a newline inside the arguments, because a question may have one', () => {
    assert.equal(parseCommand('/ai what did we\ndecide?').argLine, 'what did we\ndecide?');
  });
});

describe('rankCommands', () => {
  it('offers everything for an empty verb, in the order given', () => {
    assert.deepEqual(rankCommands(COMMANDS, ''), COMMANDS);
  });

  it('survives a registry that has not loaded yet', () => {
    assert.deepEqual(rankCommands(undefined, 'ai'), []);
    assert.deepEqual(rankCommands(null, ''), []);
  });

  it('puts a name that starts with the verb above one that merely contains it', () => {
    const names = rankCommands(COMMANDS, 'ai').map((c) => c.name);
    assert.equal(names[0], 'ai');
    // 'archive' keeps a subsequence match on a-i, which is worth offering and
    // is not worth offering first.
    assert.ok(names.includes('archive'));
  });

  it('drops what does not match at all', () => {
    assert.deepEqual(rankCommands(COMMANDS, 'zzz').map((c) => c.name), []);
  });

  it('carries the command through, so the menu can run what it drew', () => {
    const [first] = rankCommands(COMMANDS, 'add');
    assert.equal(first.name, 'add');
    assert.equal(typeof first.run, 'function');
    assert.equal(first.id, 'v-add');
  });

  it('does not search fields a command does not have', () => {
    // A missing title interpolated into the haystack would read as the literal
    // "undefined", and every command would answer to /und.
    assert.deepEqual(rankCommands([{id: 'x', name: 'x'}], 'und').map((c) => c.name), []);
  });
});

describe('resolveCommand', () => {
  it('takes an exact name over a longer one that starts with it', () => {
    assert.equal(resolveCommand(COMMANDS, 'new').id, 'v-new');
    assert.equal(resolveCommand(COMMANDS, 'archive').id, 'v-archive');
  });

  it('resolves a prefix only when it can mean one command', () => {
    assert.equal(resolveCommand(COMMANDS, 'una').id, 'v-unarchive');
    assert.equal(resolveCommand(COMMANDS, 'a'), null, 'add, ai and archive all start with a');
  });

  it('ignores case, because a command typed in capitals is the same command', () => {
    assert.equal(resolveCommand(COMMANDS, 'AI').id, 'v-ai');
  });

  it('is null for nothing, for the unknown, and for a registry that is missing', () => {
    assert.equal(resolveCommand(COMMANDS, ''), null);
    assert.equal(resolveCommand(COMMANDS, 'nope'), null);
    assert.equal(resolveCommand(undefined, 'ai'), null);
  });
});
