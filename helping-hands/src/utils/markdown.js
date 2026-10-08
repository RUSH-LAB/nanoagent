/**
 * The markdown the assistant is allowed to speak.
 *
 * The site renders authored content through MDX at build time, so nothing in
 * the app can turn a string into formatted output at runtime. The assistant's
 * replies arrive as markdown anyway, and without a parser they land in the CLI
 * as raw asterisks and backticks. This module turns such a reply into a small
 * tree of blocks and spans that a React component can render as elements, and
 * tells that component how much of a still arriving reply is already decided,
 * so a streamed answer is parsed as it lands rather than from the top on every
 * delta.
 *
 * It is deliberately a small renderer for assistant replies, not a CommonMark
 * implementation. It handles ATX headings up to three hashes, fenced code with
 * an optional language, unordered and ordered lists, blockquotes, thematic
 * breaks, inline code, strong, emphasis, autolinks and inline links. Anything
 * else degrades to text, which is the failure mode we want: an unsupported
 * construct reads as the characters the assistant typed instead of vanishing.
 *
 * Safety is the reason this is a tree and not a string of HTML. There is no
 * HTML passthrough and no escape hatch, so the renderer never needs
 * dangerouslySetInnerHTML, and a link keeps its href only when that href is
 * http, https, mailto or a site relative path. Every other href, notably
 * javascript: and data:, is dropped and the link is emitted as literal text,
 * so a hostile URL cannot hide behind friendly link text. That allowlist is
 * the whole sanitizer story here, which is why it is an allowlist and never a
 * list of things to block.
 *
 * @typedef {{type: 'text'|'code'|'strong'|'em'|'link', text: string, href?: string}} Span
 * @typedef {{type: 'paragraph', spans: Span[]}
 *   | {type: 'heading', level: number, spans: Span[]}
 *   | {type: 'list', ordered: boolean, items: Span[][]}
 *   | {type: 'code', lang: string|null, code: string}
 *   | {type: 'quote', spans: Span[]}
 *   | {type: 'rule'}} Block
 */

/* ── Block grammar ──────────────────────────────────── */

/* Up to three leading spaces still counts as a block marker, matching every
   markdown dialect; four or more is left as text, because indented code blocks
   are the one CommonMark feature this parser deliberately omits. Fenced code
   is unambiguous and a stray indent in a reply should not become a code box. */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)/;
const HEADING_RE = /^ {0,3}(#{1,3})(?:[ \t]+(.*))?$/;
const QUOTE_RE = /^ {0,3}> ?(.*)$/;
const RULE_RE = /^ {0,3}(?:\*[ \t]*){3,}$|^ {0,3}(?:-[ \t]*){3,}$|^ {0,3}(?:_[ \t]*){3,}$/;
const BULLET_RE = /^ {0,3}[-*][ \t]+(.*)$/;
const ORDERED_RE = /^ {0,3}\d{1,9}[.)][ \t]+(.*)$/;

/* A closing fence is the same character as the opener, at least as long, and
   alone on its line. Length is compared by the caller, which knows the opener. */
const CLOSING_FENCE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/* A trailing run of hashes is decoration on an ATX heading, not content. */
const HEADING_TAIL_RE = /(?:^|[ \t])#+[ \t]*$/;

/* ── Inline grammar ─────────────────────────────────── */

/* Sticky, so the scanner can test for a construct at its current index without
   slicing the string. Each exec is preceded by an assignment to lastIndex. */
/* Only the tail of a link, matched at the closing bracket rather than at the
   opening one. A label may not contain a bracket, so the ']' that ends a link
   is always the first one after its '[', and every '[' before that bracket
   therefore asks the same question about the same tail. Matching the tail on
   its own lets the scanner ask it once. */
const LINK_TAIL_RE = /\]\(([^)\s]*)\)/y;
const ANGLE_AUTOLINK_RE = /<((?:https?:\/\/|mailto:)[^\s<>]+)>/iy;
const BARE_URL_RE = /https?:\/\/[^\s<>]+/iy;

/* The allowlist that makes this renderer safe: an absolute web or mail URL, or
   a path inside this site. A path starting with two slashes or a backslash is
   protocol relative, which is an off site navigation wearing a local costume,
   so it is not accepted. */
const ABSOLUTE_HREF_RE = /^(?:https?:\/\/|mailto:)./i;
const SITE_RELATIVE_HREF_RE = /^\/(?![/\\])/;

/* A URL at the end of a sentence swallows the punctuation that ended it. These
   characters are trimmed back off the tail of a bare autolink. */
const URL_TAIL_PUNCTUATION = '.,;:!?\'"’”)]}';

/* Emphasis may not open on whitespace or close on it, which is the cheap half
   of CommonMark's flanking rule. It is what keeps "2 * 3 * 4" from turning
   into an italic 3. */
const WHITESPACE_RE = /\s/;

function matchAt(re, text, index) {
  re.lastIndex = index;
  return re.exec(text);
}

function isSafeHref(href) {
  return ABSOLUTE_HREF_RE.test(href) || SITE_RELATIVE_HREF_RE.test(href);
}

/**
 * Read a code span starting at a run of backticks.
 *
 * The closing run must be exactly as long as the opening one, so a span can
 * quote backticks by opening with more of them. An unterminated run has no
 * closer and returns null, which leaves the backtick as literal text.
 *
 * `noCloser` is the caller's set of opening widths already proved unclosable
 * in this block. Failing here is a fact about the rest of the block, not about
 * this backtick, so it is recorded and the next run of the same width is
 * refused without walking the block again.
 */
function readCode(text, start, noCloser) {
  let open = 0;
  while (text[start + open] === '`') open++;
  if (noCloser.has(open)) return null;
  let i = start + open;
  while (i < text.length) {
    if (text[i] !== '`') { i++; continue; }
    let run = 0;
    while (text[i + run] === '`') run++;
    if (run === open) {
      // A code span is one line by definition, and one padding space on each
      // side is the author making room for a backtick rather than content.
      let inner = text.slice(start + open, i).replace(/\n/g, ' ');
      if (inner.length > 2 && inner.startsWith(' ') && inner.endsWith(' ') && inner.trim() !== '') {
        inner = inner.slice(1, -1);
      }
      return {span: {type: 'code', text: inner}, next: i + open};
    }
    i += run;
  }
  noCloser.add(open);
  return null;
}

/**
 * Read an inline link, and refuse the ones that are not navigations.
 *
 * A refused link is returned as the literal source text rather than as its
 * label alone, so the reader sees the whole thing the assistant wrote and a
 * misleading label cannot quietly stand in for the URL it hid.
 *
 * `bracket` is the caller's memo of the closing bracket in play: `close` is
 * the first ']' at or after the scan head, or -1 once the block has none left,
 * and `tail` is the '](href)' match there. Both answer for every '[' up to
 * that bracket, so a paragraph of stray brackets costs one lookup rather than
 * one per bracket.
 */
function readLink(text, start, bracket) {
  if (bracket.close !== -1 && bracket.close < start) {
    bracket.close = text.indexOf(']', start);
    bracket.tail = bracket.close === -1 ? null : matchAt(LINK_TAIL_RE, text, bracket.close);
  }
  if (!bracket.tail) return null;
  const label = text.slice(start + 1, bracket.close);
  const href = bracket.tail[1];
  const next = bracket.close + bracket.tail[0].length;
  if (!isSafeHref(href)) return {span: {type: 'text', text: text.slice(start, next)}, next};
  return {span: {type: 'link', text: label, href}, next};
}

function readAngleAutolink(text, start) {
  const m = matchAt(ANGLE_AUTOLINK_RE, text, start);
  if (!m) return null;
  return {span: {type: 'link', text: m[1], href: m[1]}, next: start + m[0].length};
}

/**
 * Read a bare URL, giving back the punctuation that ended the sentence.
 *
 * A closing parenthesis is kept when the URL opened one, because Wikipedia
 * style paths end in a real bracket that is part of the address.
 */
function readBareUrl(text, start) {
  // Only at a boundary, so the tail of an identifier such as xhttps://a is not
  // mistaken for an address.
  if (start > 0 && /[A-Za-z0-9]/.test(text[start - 1])) return null;
  const m = matchAt(BARE_URL_RE, text, start);
  if (!m) return null;
  let url = m[0];
  while (url.length > 0 && URL_TAIL_PUNCTUATION.includes(url[url.length - 1])) {
    const closesItsOwn = url.endsWith(')')
      && url.split('(').length >= url.split(')').length;
    if (closesItsOwn) break;
    url = url.slice(0, -1);
  }
  if (!isSafeHref(url)) return null;
  return {span: {type: 'link', text: url, href: url}, next: start + url.length};
}

/**
 * Read strong or emphasis at a run of asterisks.
 *
 * Underscores are not emphasis markers here on purpose: snake_case identifiers
 * are common in an assistant's answer and italicising half of one is worse
 * than never italicising at all.
 *
 * There are two ways to refuse, and only one of them is worth remembering.
 * The flanking guard below refuses this opener alone, so it says nothing about
 * the rest of the block: in "* a *b*" the first asterisk is refused for the
 * space behind it while the pair after it is real emphasis. Running the search
 * out instead proves the block holds no closer of this width at all, which no
 * later opener of the same width can change, so that one is recorded in the
 * caller's `noCloser` and never re-walked.
 */
function readEmphasis(text, start, noCloser) {
  const strong = text.startsWith('**', start);
  const width = strong ? 2 : 1;
  const kind = strong ? 'strong' : 'em';
  if (noCloser[kind]) return null;
  const open = start + width;
  const first = text[open];
  if (first === undefined || first === '*' || WHITESPACE_RE.test(first)) return null;

  let i = open;
  while (i < text.length) {
    if (text[i] !== '*') { i++; continue; }
    const isDouble = text.startsWith('**', i);
    if (strong !== isDouble) { i += isDouble ? 2 : 1; continue; }
    if (WHITESPACE_RE.test(text[i - 1])) { i += width; continue; }
    return {
      span: {type: kind, text: text.slice(open, i)},
      next: i + width,
    };
  }
  noCloser[kind] = true;
  return null;
}

/**
 * Turn one block's text into spans.
 *
 * The scan runs left to right and the first construct to open wins, which is
 * how inline code beats emphasis: in `a*b*c` the backtick comes first, so the
 * asterisks inside it stay literal. A construct that never closes contributes
 * its opening character as text and the scan carries on past it.
 *
 * The three memos below are what keep that last sentence affordable. Searching
 * for a closer walks the rest of the block, and a reply can hold thousands of
 * openers that never close, so without them one block of stray markers costs a
 * walk per marker and a streamed answer pays the whole bill again on every
 * delta. Each memo records only what a failed search proved about the rest of
 * the block, never what it proved about one opener.
 */
function parseInline(text) {
  const spans = [];
  let plain = '';
  const flush = () => {
    if (plain) spans.push({type: 'text', text: plain});
    plain = '';
  };

  const noCode = new Set();
  const noEmphasis = {em: false, strong: false};
  const bracket = {close: -2, tail: null};

  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    let read = null;
    if (ch === '`') read = readCode(text, i, noCode);
    else if (ch === '[') read = readLink(text, i, bracket);
    else if (ch === '<') read = readAngleAutolink(text, i);
    else if (ch === '*') read = readEmphasis(text, i, noEmphasis);
    else if (ch === 'h' || ch === 'H') read = readBareUrl(text, i);

    if (read) {
      // A construct that was read but refused comes back as text, and it joins
      // the run around it rather than becoming a span of its own.
      if (read.span.type === 'text') {
        plain += read.span.text;
      } else {
        flush();
        spans.push(read.span);
      }
      i = read.next;
      continue;
    }
    plain += ch;
    i++;
  }
  flush();
  return spans;
}

/** Does this line start a block, and therefore end the one being collected? */
function startsBlock(line) {
  return FENCE_RE.test(line)
    || RULE_RE.test(line)
    || HEADING_RE.test(line)
    || QUOTE_RE.test(line)
    || BULLET_RE.test(line)
    || ORDERED_RE.test(line);
}

/**
 * Parse a markdown document into blocks.
 *
 * @param {string} text
 * @returns {Block[]} Empty for anything that is not a non-blank string.
 */
export function parseMarkdown(text) {
  if (typeof text !== 'string' || text.trim() === '') return [];

  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === '') { i++; continue; }

    const fence = FENCE_RE.exec(line);
    if (fence) {
      const [, marker, info] = fence;
      const code = [];
      i++;
      while (i < lines.length) {
        const close = CLOSING_FENCE_RE.exec(lines[i]);
        if (close && close[1][0] === marker[0] && close[1].length >= marker.length) { i++; break; }
        code.push(lines[i]);
        i++;
      }
      // An unclosed fence runs to the end of the reply rather than losing it,
      // which is what a half streamed answer looks like.
      blocks.push({type: 'code', lang: info ? info.toLowerCase() : null, code: code.join('\n')});
      continue;
    }

    // Before the bullet test, because "* * *" is a rule and not a list.
    if (RULE_RE.test(line)) {
      blocks.push({type: 'rule'});
      i++;
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      const content = (heading[2] || '').replace(HEADING_TAIL_RE, '').trim();
      blocks.push({type: 'heading', level: heading[1].length, spans: parseInline(content)});
      i++;
      continue;
    }

    const quote = QUOTE_RE.exec(line);
    if (quote) {
      const quoted = [];
      while (i < lines.length) {
        const next = QUOTE_RE.exec(lines[i]);
        if (!next) break;
        quoted.push(next[1].trim());
        i++;
      }
      blocks.push({type: 'quote', spans: parseInline(quoted.join('\n'))});
      continue;
    }

    const ordered = ORDERED_RE.test(line);
    const itemRe = ordered ? ORDERED_RE : BULLET_RE;
    if (ordered || BULLET_RE.test(line)) {
      const items = [];
      while (i < lines.length) {
        const item = itemRe.exec(lines[i]);
        if (item) { items.push(item[1]); i++; continue; }
        // An indented or plain line under an item continues that item; a blank
        // line or a new block ends the list. Switching from bullets to numbers
        // ends it too, because the other marker starts a block of its own.
        if (lines[i].trim() === '' || startsBlock(lines[i])) break;
        items[items.length - 1] += `\n${lines[i].trim()}`;
        i++;
      }
      blocks.push({type: 'list', ordered, items: items.map(parseInline)});
      continue;
    }

    const paragraph = [];
    while (i < lines.length && lines[i].trim() !== '' && !startsBlock(lines[i])) {
      paragraph.push(lines[i].trim());
      i++;
    }
    blocks.push({type: 'paragraph', spans: parseInline(paragraph.join('\n'))});
  }

  return blocks;
}

/* ── Streaming ──────────────────────────────────────── */

/**
 * How much of a still arriving reply is already decided?
 *
 * An answer streams in a token at a time and a renderer that parses the whole
 * thing on every delta re-reads the same opening paragraphs hundreds of times.
 * Most of that work is provably wasted: the parser carries no state across a
 * blank line, so once a blank line has arrived outside a fenced block, every
 * block before it is final and no later token can change it.
 *
 * This returns the length of that settled head. `parseMarkdown(text)` always
 * equals `parseMarkdown(head).concat(parseMarkdown(tail))` for the split it
 * names, so a caller can parse the head once and re-parse only the tail. The
 * answer is deliberately conservative: an unfinished line is never settled, a
 * blank line inside a fence does not count because an unclosed fence swallows
 * it, and anything the scan is unsure of returns 0, which is the correct if
 * slower behaviour of parsing everything again.
 *
 * @param {string} text
 * @returns {number} An index into `text`, 0 when nothing has settled yet.
 */
export function settledLength(text) {
  if (typeof text !== 'string') return 0;

  let settled = 0;
  let fence = null;
  let start = 0;
  while (start < text.length) {
    const end = text.indexOf('\n', start);
    // The last line has no newline yet, so it is still being written.
    if (end === -1) break;
    const line = text.slice(start, text[end - 1] === '\r' ? end - 1 : end);
    if (fence) {
      const close = CLOSING_FENCE_RE.exec(line);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
    } else {
      const open = FENCE_RE.exec(line);
      if (open) fence = open[1];
      else if (line.trim() === '') settled = end + 1;
    }
    start = end + 1;
  }
  return settled;
}
