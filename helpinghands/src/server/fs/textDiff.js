'use strict';

/**
 * The one span where two texts differ, found from their common prefix and
 * suffix: `{from, to, insert}` replaces `current.slice(from, to)` with
 * `insert` to give `target`, or null when they are equal. Mergeable Markdown
 * (crdt.js) folds a plain write into its document with it, and the workbench
 * editor reads in a file changed elsewhere without moving the cursor
 * (components/Workbench/Editor.js).
 *
 * CommonJS because the browser needs it too (see utils/paths.js).
 */
function changedRange(current, target) {
  if (current === target) return null;
  let start = 0;
  while (start < current.length && start < target.length && current[start] === target[start]) start += 1;
  let end = 0;
  while (end < current.length - start && end < target.length - start
    && current[current.length - 1 - end] === target[target.length - 1 - end]) end += 1;
  return {from: start, to: current.length - end, insert: target.slice(start, target.length - end)};
}

module.exports = {changedRange};
