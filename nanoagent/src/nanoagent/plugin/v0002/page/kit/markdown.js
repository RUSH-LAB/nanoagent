// The agent's answers as Markdown: paragraphs, headings, lists, quotes, fenced code, and inline
// code, bold, italics and links. Built as DOM nodes, never as HTML, so an answer can't inject markup.

import { h } from "./dom.js";

const INLINE = /`([^`]+)`|\*\*(.+?)\*\*|\*([^*\s][^*]*?)\*|_([^_\s][^_]*?)_|\[([^\]]+)\]\((\S+?)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

/** `text`'s inline Markdown as nodes. */
function inline(text) {
  const nodes = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const [whole, code, bold, star, under, label, href, bare] = match;
    if (code !== undefined) nodes.push(h("code", { text: code }));
    else if (bold !== undefined) nodes.push(h("strong", {}, inline(bold)));
    else if (star !== undefined || under !== undefined) nodes.push(h("em", {}, inline(star ?? under)));
    else if (label !== undefined) nodes.push(/^https?:\/\//i.test(href) ? h("a", { href, target: "_blank", rel: "noopener noreferrer" }, inline(label)) : whole);
    else nodes.push(h("a", { href: bare, target: "_blank", rel: "noopener noreferrer", text: bare }));
    last = match.index + whole.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

const LIST_ITEM = /^\s*(?:[-*+]|(\d+)[.)])\s+(.*)$/;

/**
 * `text` as Markdown, in a `div.markdown`.
 * @param {string} text
 * @returns {HTMLElement}
 */
export function markdown(text) {
  const blocks = [];
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
    } else if (line.trimStart().startsWith("```")) {
      const code = [];
      for (i += 1; i < lines.length && !lines[i].trimStart().startsWith("```"); i += 1) code.push(lines[i]);
      i += 1;
      blocks.push(h("pre", {}, h("code", { text: code.join("\n") })));
    } else if (/^#{1,6}\s/.test(line)) {
      const level = Math.min(line.match(/^#+/)[0].length + 2, 6);
      blocks.push(h(`h${level}`, {}, inline(line.replace(/^#+\s+/, ""))));
      i += 1;
    } else if (/^\s*>/.test(line)) {
      const quote = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]); i += 1) quote.push(lines[i].replace(/^\s*>\s?/, ""));
      blocks.push(h("blockquote", {}, markdown(quote.join("\n"))));
    } else if (LIST_ITEM.test(line)) {
      const ordered = Boolean(line.match(LIST_ITEM)[1]);
      const items = [];
      for (; i < lines.length && (LIST_ITEM.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length)); i += 1) {
        const item = lines[i].match(LIST_ITEM);
        if (item) items.push(item[2]);
        else items[items.length - 1] += ` ${lines[i].trim()}`;
      }
      blocks.push(h(ordered ? "ol" : "ul", {}, items.map((item) => h("li", {}, inline(item)))));
    } else {
      const paragraph = [];
      for (; i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*>|\s*```)/.test(lines[i]) && !LIST_ITEM.test(lines[i]); i += 1) paragraph.push(lines[i].trim());
      blocks.push(h("p", {}, paragraph.flatMap((part, index) => (index ? [h("br"), ...inline(part)] : inline(part)))));
    }
  }
  return h("div", { class: "markdown" }, blocks);
}
