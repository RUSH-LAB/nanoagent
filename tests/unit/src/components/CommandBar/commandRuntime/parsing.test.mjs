import {describe, it} from 'node:test';
import assert from 'node:assert/strict';

// commandRuntime.js is the one part of the CLI that is worth unit testing and
// can be: it holds no React, no JSX and no browser API, so Node's module-syntax
// detection lets this .mjs test import the real source rather than a copy of
// it. Everything below pins the behaviour the rest of the CLI is built on: the
// verb/argument split used by `/model` and `/harness`, plus the ranking and
// exact resolution used by the slash menu.
import {
  parseCommand,
  rankCommandOptions,
  rankCommands,
  resolveCommand,
} from '../../../../../../src/components/CommandBar/commandRuntime.js';

/* The complete runtime command registry. */
const COMMANDS = [
  {id: 'v-harness', name: 'harness', category: 'Agent', description: 'Select a harness', usage: '[harness]', run() {}},
  {id: 'v-model', name: 'model', category: 'Agent', description: 'Select a model', usage: '[model]', run() {}},
];

describe('parseCommand', () => {
  it('is null for anything that is not a command', () => {
    for (const line of ['hello', '', ' /late', null, undefined, 42, {}]) {
      assert.equal(parseCommand(line), null, `expected ${JSON.stringify(line)} to parse as not a command`);
    }
  });

  it('splits the verb from the rest of the line', () => {
    assert.deepEqual(parseCommand('/model openrouter/test'), {
      verb: 'model', args: ['openrouter/test'], argLine: 'openrouter/test',
    });
  });

  it('keeps the argument line whole, and also offers it as words', () => {
    assert.deepEqual(parseCommand('/harness  Hermes   Agent  '), {
      verb: 'harness',
      args: ['Hermes', 'Agent'],
      argLine: 'Hermes   Agent',
    });
  });

  it('has no arguments when only a verb was typed', () => {
    assert.deepEqual(parseCommand('/model'), {verb: 'model', args: [], argLine: ''});
    assert.deepEqual(parseCommand('/model   '), {verb: 'model', args: [], argLine: ''});
  });

  it('parses a bare slash as an empty verb, which is what opens the whole menu', () => {
    assert.deepEqual(parseCommand('/'), {verb: '', args: [], argLine: ''});
  });

  it('keeps a newline inside the arguments, because a question may have one', () => {
    assert.equal(parseCommand('/model provider/long\nname').argLine, 'provider/long\nname');
  });
});

describe('rankCommands', () => {
  it('offers everything for an empty verb, in the order given', () => {
    assert.deepEqual(rankCommands(COMMANDS, ''), COMMANDS);
  });

  it('survives a registry that has not loaded yet', () => {
    assert.deepEqual(rankCommands(undefined, 'model'), []);
    assert.deepEqual(rankCommands(null, ''), []);
  });

  it('finds the command by a typed prefix', () => {
    assert.deepEqual(rankCommands(COMMANDS, 'mod').map(command => command.name), ['model']);
  });

  it('drops what does not match at all', () => {
    assert.deepEqual(rankCommands(COMMANDS, 'zzz').map((c) => c.name), []);
  });

  it('carries the command through, so the menu can run what it drew', () => {
    const [first] = rankCommands(COMMANDS, 'harness');
    assert.equal(first.name, 'harness');
    assert.equal(typeof first.run, 'function');
    assert.equal(first.id, 'v-harness');
  });

  it('does not search fields a command does not have', () => {
    // A missing title interpolated into the haystack would read as the literal
    // "undefined", and every command would answer to /und.
    assert.deepEqual(rankCommands([{id: 'x', name: 'x'}], 'und').map((c) => c.name), []);
  });
});

describe('resolveCommand', () => {
  it('takes an exact name over a longer one that starts with it', () => {
    assert.equal(resolveCommand(COMMANDS, 'model').id, 'v-model');
    assert.equal(resolveCommand(COMMANDS, 'harness').id, 'v-harness');
  });

  it('resolves a prefix only when it can mean one command', () => {
    assert.equal(resolveCommand(COMMANDS, 'har').id, 'v-harness');
    assert.equal(resolveCommand([
      ...COMMANDS,
      {id: 'v-mode', name: 'mode'},
    ], 'mod'), null);
  });

  it('ignores case, because a command typed in capitals is the same command', () => {
    assert.equal(resolveCommand(COMMANDS, 'MODEL').id, 'v-model');
  });

  it('is null for nothing, for the unknown, and for a registry that is missing', () => {
    assert.equal(resolveCommand(COMMANDS, ''), null);
    assert.equal(resolveCommand(COMMANDS, 'nope'), null);
    assert.equal(resolveCommand(undefined, 'model'), null);
  });
});

describe('rankCommandOptions', () => {
  const calls = [];
  const command = {
    name: 'model',
    icon: 'star',
    options: () => [
      {id: 'fast', value: 'fast', name: 'Fast', description: 'Low latency'},
      {id: 'smart', value: 'smart', name: 'Smart', description: 'Deep reasoning'},
    ],
    run: (ctx, value) => calls.push([ctx, value]),
  };

  it('creates executable second-level picker rows and filters them', () => {
    const [choice] = rankCommandOptions(command, {chat: 'one'}, 'sma');
    assert.equal(choice.kind, 'argument');
    assert.equal(choice.commandLine, '/model smart');
    assert.equal(choice.argument, 'smart');
    assert.equal(choice.icon, 'star');
    choice.run('runtime-context');
    assert.deepEqual(calls.pop(), ['runtime-context', 'smart']);
  });

  it('returns no rows when a command has no dynamic options', () => {
    assert.deepEqual(rankCommandOptions({name: 'model'}, null), []);
  });
});
