// The user's workspace through the bridge, for a renderer that shows a file a task saved: listing
// and reading files.

import { request } from "./bridge.js";

const IMAGE_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml" };

/**
 * The workspace's files, sorted by path.
 * @param {{prefix?: string, extensions?: string[]}} [filter] Keep paths starting with `prefix`
 *   and/or ending with one of `extensions` (e.g. `[".bib"]`, case-insensitive).
 * @returns {Promise<Array<{path: string, size: number}>>}
 */
export async function listFiles({ prefix = "", extensions } = {}) {
  const result = await request("workspace.list");
  if (!result || !Array.isArray(result.files)) throw new Error("The host's workspace.list reply has no files list.");
  const endings = extensions?.map((ending) => ending.toLowerCase());
  return result.files
    .filter((file) => file.path.startsWith(prefix) && (!endings || endings.some((ending) => file.path.toLowerCase().endsWith(ending))))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * A workspace file as the host sends it: `{text}` for UTF-8 text, otherwise `{base64}`.
 * @param {string} path
 * @returns {Promise<{text?: string, base64?: string}>}
 */
export async function readFile(path) {
  const file = await request("workspace.read", { path });
  if (!file || (typeof file.text !== "string" && typeof file.base64 !== "string")) {
    throw new Error(`The host's workspace.read reply for ${path} has neither text nor base64.`);
  }
  return file;
}

/**
 * A workspace text file's contents; rejects when the file is not UTF-8 text.
 * @param {string} path
 * @returns {Promise<string>}
 */
export async function readText(path) {
  const file = await readFile(path);
  if (typeof file.text !== "string") throw new Error(`${path} is not a text file.`);
  return file.text;
}

/**
 * A workspace JSON file, parsed; rejects with a message naming the file when it does not parse.
 * @param {string} path
 * @returns {Promise<unknown>}
 */
export async function readJSON(path) {
  const text = await readText(path);
  try {
    return JSON.parse(text);
  } catch (problem) {
    throw new Error(`${path} is not valid JSON: ${problem.message}`);
  }
}
