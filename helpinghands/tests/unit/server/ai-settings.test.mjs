import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const require = createRequire(import.meta.url);
const aiSettings = require('../../../src/server/ai-settings.js');
const yaml = require('js-yaml');
// The NanoAgent checkout beside Mochi's, whose Railway configuration RUSH Lab cloud's runner runs.
const nanoagent = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../nanoagent');

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

  it('sends a NanoAgent many members share (RUSH Lab cloud) only the member\'s instructions: its own model and limits run', () => {
    assert.deepEqual(aiSettings.forRun(value, 'chat', {shared: true}), {instructions: 'Cite sources.'});
    assert.deepEqual(aiSettings.forRun(value, 'apps', {shared: true}), {instructions: 'Cite sources.'});
    assert.deepEqual(aiSettings.forRun(value, 'inline', {shared: true}), {});
    assert.deepEqual(aiSettings.forRun(aiSettings.stored(null), 'apps', {shared: true}), {});
    assert.deepEqual(aiSettings.forRun(value, 'apps', {shared: false}), aiSettings.forRun(value, 'apps'));
  });

  it('is the model RUSH Lab cloud\'s NanoAgent runs when a run names none (its Railway configuration)', () => {
    const config = yaml.load(fs.readFileSync(path.join(nanoagent, 'deploy/railway/nanoagent.yaml'), 'utf8'));
    const configured = config['model > nanoagent.runtime.config.ModelConfig'];
    assert.deepEqual({provider: configured.provider, model: configured.model}, model);
    // Its profiles run it too: chat's default one and the apps one.
    for (const file of config.profiles) {
      assert.equal(yaml.load(fs.readFileSync(path.join(nanoagent, file), 'utf8')).model, model.model, file);
    }
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
