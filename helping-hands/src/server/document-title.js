'use strict';

const yaml = require('js-yaml');

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const FIRST_H1_RE = /^#[ \t]+(.+?)[ \t]*#*[ \t]*$/m;

function frontmatterTitle(markdown) {
  const match = FRONTMATTER_RE.exec(String(markdown ?? ''));
  if (!match) return null;
  try {
    const value = yaml.load(match[1]);
    return typeof value?.title === 'string' && value.title.trim() ? value.title.trim() : null;
  } catch {
    return null;
  }
}

/** Docusaurus-style title fallback: frontmatter, then the first H1, then filename. */
function titleOf(markdown, path) {
  const source = String(markdown ?? '');
  const configured = frontmatterTitle(source);
  if (configured) return configured;
  const heading = FIRST_H1_RE.exec(source.replace(FRONTMATTER_RE, ''))?.[1]?.trim();
  if (heading) return heading;
  return (String(path ?? '').split('/').pop() ?? '').replace(/\.mdx?$/i, '');
}

module.exports = {titleOf};
