'use strict';

/**
 * Finding text in files as VS Code's Search view does, without regular
 * expressions, so no query can make the server search for long: `query` is
 * matched literally, ignoring case unless `matchCase`, and with `wholeWord`
 * only where neither side touches a letter, digit or underscore. The server
 * searches with it (routes/fs.js, GET search) and the workbench replaces with
 * it (components/Workbench/Search.js), so both find the same matches.
 *
 * CommonJS because the browser needs it too (see utils/paths.js).
 */

const WORD = /[\p{L}\p{N}_]/u;

/** Every match of `query` in `text`, as `[start, end]` offsets in order, none overlapping. */
function matchesIn(text, query, {matchCase = false, wholeWord = false} = {}) {
  if (!query) return [];
  const haystack = matchCase ? text : text.toLowerCase();
  const needle = matchCase ? query : query.toLowerCase();
  // Lowercasing keeps every offset only when it keeps every length.
  const exact = haystack.length === text.length && needle.length === query.length;
  const found = [];
  for (let index = haystack.indexOf(needle); index !== -1; index = haystack.indexOf(needle, index + needle.length)) {
    const end = index + needle.length;
    if (!exact && text.slice(index, end).toLowerCase() !== needle) continue;
    if (wholeWord && (WORD.test(text[index - 1] ?? '') || WORD.test(text[end] ?? ''))) continue;
    found.push([index, end]);
  }
  return found;
}

/**
 * The matches in `text` by line: `[{line, column, length, preview}]`, `line`
 * and `column` counted from 1, `preview` the line itself, at most `limit` of them.
 */
function lineMatches(text, query, options = {}, limit = Infinity) {
  const lines = [];
  let lineStart = 0;
  let lineNumber = 1;
  let nextBreak = text.indexOf('\n');
  for (const [start, end] of matchesIn(text, query, options)) {
    while (nextBreak !== -1 && nextBreak < start) {
      lineStart = nextBreak + 1;
      lineNumber += 1;
      nextBreak = text.indexOf('\n', lineStart);
    }
    const lineEnd = nextBreak === -1 ? text.length : nextBreak;
    lines.push({
      line: lineNumber,
      column: start - lineStart + 1,
      length: Math.min(end, lineEnd) - start,
      preview: text.slice(lineStart, lineEnd).replace(/\r$/, ''),
    });
    if (lines.length >= limit) break;
  }
  return lines;
}

/** `text` with every match of `query` replaced by `replacement`, and how many there were. */
function replaceAll(text, query, replacement, options = {}) {
  const found = matchesIn(text, query, options);
  let result = '';
  let last = 0;
  for (const [start, end] of found) {
    result += text.slice(last, start) + replacement;
    last = end;
  }
  return {text: result + text.slice(last), count: found.length};
}

module.exports = {matchesIn, lineMatches, replaceAll};
