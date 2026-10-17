'use strict';

/**
 * A member's AI settings (Settings → AI), kept as their `ai` preference. They
 * are for the NanoAgent on their own computer (server/runner.js); RUSH Lab
 * cloud's runs on its own model and limits, and takes only their instructions:
 *
 *   behaviour           how NanoAgent behaves for them
 *   instructions        their own words, added to chat and app runs
 *
 * The model is not one of them: every run, of every use, is on MODEL.
 */

// The one model chat, inline completion and apps run on, through the member's OpenRouter key.
const MODEL = Object.freeze({provider: 'openrouter', model: 'deepseek/deepseek-v4-flash-0731'});
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

const empty = () => ({behaviour: {}, instructions: ''});
const isObject = value => value && typeof value === 'object' && !Array.isArray(value);

/** The member's settings, from their stored `ai` preference (written only through normalize). */
function stored(value) {
  if (!isObject(value)) return empty();
  return {
    behaviour: isObject(value.behaviour) ? value.behaviour : {},
    instructions: typeof value.instructions === 'string' ? value.instructions : '',
  };
}

/** `{value}`, the settings `input` describes, or `{error}`. */
function normalize(input, sanitizeText = text => text) {
  if (!isObject(input)) return {error: 'settings must be an object'};
  const out = empty();
  for (const key of Object.keys(input)) {
    if (key !== 'behaviour' && key !== 'instructions') return {error: `${key} is not an AI setting: choose from behaviour, instructions`};
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
 * What a run for `use` sends NanoAgent from `settings`: `{model}` (MODEL),
 * `settings`, and the member's `instructions` for chat and apps. A NanoAgent
 * many members share (`shared`, RUSH Lab cloud: server/cloud-runs.js) runs its
 * configured model, MODEL too, within its own limits, and refuses a run that
 * names a model or asks past those limits: it is sent only the instructions.
 */
function forRun(settings, use, {shared = false} = {}) {
  if (shared) return use !== 'inline' && settings.instructions ? {instructions: settings.instructions} : {};
  const run = {model: {...MODEL}};
  const tuned = Object.fromEntries(APPLIES[use]
    .filter(key => settings.behaviour[key] != null)
    .map(key => [BEHAVIOUR[key].nano, settings.behaviour[key]]));
  if (Object.keys(tuned).length) run.settings = tuned;
  if (use !== 'inline' && settings.instructions) run.instructions = settings.instructions;
  return run;
}

module.exports = {MODEL, THINKING, MAX_INSTRUCTIONS, APPLIES, stored, normalize, forRun};
