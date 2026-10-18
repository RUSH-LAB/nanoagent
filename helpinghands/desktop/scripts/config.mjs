/**
 * config.yaml as an app bundles it (scripts/stage.mjs, resources/config.json): RUSH Lab's, or with
 * `dev`, RUSH Lab Dev's, its `dev` block over it. Either way flat, without the `dev` block itself.
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import YAML from 'yaml';

const CONFIG = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'config.yaml');

export function readConfig({dev = false} = {}, file = CONFIG) {
  const {dev: overrides, ...config} = YAML.parse(fs.readFileSync(file, 'utf8'));
  if (typeof overrides !== 'object' || overrides === null) throw new Error(`${file} has no dev block for RUSH Lab Dev`);
  for (const key of Object.keys(overrides)) {
    if (!(key in config)) throw new Error(`${file}: dev.${key} overrides nothing RUSH Lab has`);
  }
  return dev ? {...config, ...overrides} : config;
}
