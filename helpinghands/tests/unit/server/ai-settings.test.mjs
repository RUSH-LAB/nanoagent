import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const aiSettings = createRequire(import.meta.url)('../../../src/server/ai-settings.js');

describe('AI settings', () => {
  const value = aiSettings.normalize({
    behaviour: {thinking: 'low', temperature: 0.5, maxSteps: 4, costLimit: 0.05},
    instructions: '  Cite sources.  ',
  }).value;

  const model = {provider: 'openrouter', model: 'deepseek/deepseek-v4-flash-0731'};

  it('sends each use the one model and what applies to it', () => {
    assert.deepEqual(aiSettings.MODEL, model);
    assert.deepEqual(aiSettings.forRun(value, 'chat'), {
      model, settings: {thinking_level: 'low', temperature: 0.5}, instructions: 'Cite sources.',
    });
    assert.deepEqual(aiSettings.forRun(value, 'apps'), {
      model, settings: {temperature: 0.5, max_steps: 4, cost_limit: 0.05}, instructions: 'Cite sources.',
    });
    assert.deepEqual(aiSettings.forRun(value, 'inline'), {model});
  });

  it('reads an unset or partial preference as the defaults', () => {
    assert.deepEqual(aiSettings.stored(undefined), {behaviour: {}, instructions: ''});
    // A model a member chose before there was one model is not theirs to keep.
    assert.deepEqual(aiSettings.stored({chat: {provider: 'p', model: 'm'}}), {behaviour: {}, instructions: ''});
  });

  it('refuses settings out of range and unknown keys', () => {
    for (const bad of [
      {runner: 'local'},
      {chat: {provider: 'p', model: 'm'}},
      {behaviour: {thinking: 'deep'}},
      {behaviour: {temperature: 3}},
      {behaviour: {maxTokens: 1.5}},
      {draw: {provider: 'p', model: 'm'}},
    ]) assert.ok(aiSettings.normalize(bad).error, JSON.stringify(bad));
  });
});
