'use strict';

/**
 * A member's AI settings (Settings → AI), kept as their `ai` preference. Every
 * run is on their own computer (server/runner.js), so these are its:
 *
 *   behaviour           how NanoAgent behaves for them
 *   instructions        their own words, added to chat and app runs
 *   model               a model one of their own servers serves, or null for MODEL
 *
 * Every run, of every use, is on their model: the one they chose, else MODEL.
 */

// The one model chat, inline completion and apps run on, through the member's OpenRouter key,
// unless the member chose one their own server serves.
const MODEL = Object.freeze({provider: 'openrouter', model: 'deepseek/deepseek-v4-flash-0731'});
// The engines a member's own server may run, by NanoAgent's name (nanoagent.inference.providers.SERVERS).
const SERVER_PROVIDERS = ['vllm', 'sglang'];
const MAX_MODEL_ID = 200;
const THINKING = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const MAX_INSTRUCTIONS = 4000;

// Each behaviour setting: its check, and the name NanoAgent knows it by.
const BEHAVIOUR = {
  thinking: {valid: value => THINKING.includes(value), nano: 'thinking_level'},
  temperature: {valid: value => typeof value === 'number' && value >= 0 && value <= 2, nano: 'temperature'},
  maxTokens: {valid: value => Number.isInteger(value) && value >= 1 && value <= 1_000_000, nano: 'max_tokens'},
  maxSteps: {valid: value => Number.isInteger(value) && value >= 1 && value <= 1000, nano: 'max_steps'},
  costLimit: {valid: value => typeof value === 'number' && value > 0 && value <= 1000, nano: 'cost_limit'},
};
// Which behaviour each use takes: chat runs on PI (one answer, no tools), apps on NanoAgent's
// loop, and inline completion on its NanoAgent's own settings.
const APPLIES = {
  chat: ['thinking', 'temperature', 'maxTokens'],
  inline: [],
  apps: ['temperature', 'maxTokens', 'maxSteps', 'costLimit'],
};

const empty = () => ({behaviour: {}, instructions: '', model: null});
const isObject = value => value && typeof value === 'object' && !Array.isArray(value);

/** Why `value` is not a model of a member's own server, {provider, model}, or null when it is. */
function modelError(value) {
  if (!isObject(value) || Object.keys(value).some(key => key !== 'provider' && key !== 'model')) {
    return 'model must be {"provider": "<engine>", "model": "<id>"}, or null for RUSH\'s';
  }
  if (!SERVER_PROVIDERS.includes(value.provider)) return `model.provider must be a server's engine: choose from ${SERVER_PROVIDERS.join(', ')}`;
  if (typeof value.model !== 'string' || !value.model.trim() || value.model.length > MAX_MODEL_ID) {
    return `model.model must be a model id of ${MAX_MODEL_ID} characters or fewer`;
  }
  return null;
}

/** The member's settings, from their stored `ai` preference (written only through normalize). */
function stored(value) {
  if (!isObject(value)) return empty();
  return {
    behaviour: isObject(value.behaviour) ? value.behaviour : {},
    instructions: typeof value.instructions === 'string' ? value.instructions : '',
    model: modelError(value.model) ? null : {provider: value.model.provider, model: value.model.model},
  };
}

/** `{value}`, the settings `input` describes, or `{error}`. */
function normalize(input, sanitizeText = text => text) {
  if (!isObject(input)) return {error: 'settings must be an object'};
  const out = empty();
  for (const key of Object.keys(input)) {
    if (!['behaviour', 'instructions', 'model'].includes(key)) return {error: `${key} is not an AI setting: choose from behaviour, instructions, model`};
  }
  if (input.model != null) {
    const error = modelError(input.model);
    if (error) return {error};
    out.model = {provider: input.model.provider, model: input.model.model.trim()};
  }
  const behaviour = input.behaviour ?? {};
  if (!isObject(behaviour)) return {error: 'behaviour must be an object'};
  for (const [key, setting] of Object.entries(behaviour)) {
    if (!BEHAVIOUR[key]) return {error: `behaviour.${key} is not a setting: choose from ${Object.keys(BEHAVIOUR).join(', ')}`};
    if (setting === null) continue;
    if (!BEHAVIOUR[key].valid(setting)) return {error: `behaviour.${key} is out of range`};
    out.behaviour[key] = setting;
  }
  const instructions = input.instructions ?? '';
  if (typeof instructions !== 'string') return {error: 'instructions must be a string'};
  if (instructions.length > MAX_INSTRUCTIONS) return {error: `instructions must be ${MAX_INSTRUCTIONS} characters or fewer`};
  out.instructions = sanitizeText(instructions).trim();
  return {value: out};
}

/**
 * What a run for `use` sends NanoAgent from `settings`: `{model}` (the member's
 * own, else MODEL), `settings`, and the member's `instructions` for chat and apps.
 */
function forRun(settings, use) {
  const run = {model: {...(settings.model ?? MODEL)}};
  const tuned = Object.fromEntries(APPLIES[use]
    .filter(key => settings.behaviour[key] != null)
    .map(key => [BEHAVIOUR[key].nano, settings.behaviour[key]]));
  if (Object.keys(tuned).length) run.settings = tuned;
  if (use !== 'inline' && settings.instructions) run.instructions = settings.instructions;
  return run;
}

module.exports = {MODEL, SERVER_PROVIDERS, THINKING, MAX_INSTRUCTIONS, APPLIES, stored, normalize, forRun};
