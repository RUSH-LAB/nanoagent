'use strict';

/**
 * Real HTML for a published page, for visitors and crawlers that read the page
 * before (or without) running the application.
 *
 * A public document's URL is the one members use, /w/:slug/documents/<route>.
 * The application shell is served there as for any route, with the document's
 * title and description in <head> and its content in <noscript>, rendered from
 * the compiler's inert tree (mdx.js). Every text and attribute is escaped and
 * only the tree's own node types are rendered, so no author input becomes
 * markup. The application then renders the same page in full after it starts.
 */
const fs = require('fs');
const path = require('path');

const ROUTE = /^\/w\/([^/]+)\/documents(?:\/(.*))?$/;

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));

function safeHref(url) {
  const value = String(url ?? '');
  return /^(https?:|mailto:|#|\/|\.{0,2}\/|[\w-])/i.test(value) && !/^\s*(javascript|data|vbscript):/i.test(value) ? value : '#';
}

/** The inert render tree as escaped HTML. */
function treeToHtml(node) {
  const children = () => (node.children ?? []).map(treeToHtml).join('');
  switch (node?.type) {
    case 'root': return children();
    case 'text': return escape(node.value);
    case 'paragraph': return `<p>${children()}</p>`;
    case 'heading': return `<h${node.depth} id="${escape(node.id)}">${children()}</h${node.depth}>`;
    case 'emphasis': return `<em>${children()}</em>`;
    case 'strong': return `<strong>${children()}</strong>`;
    case 'delete': return `<del>${children()}</del>`;
    case 'blockquote': return `<blockquote>${children()}</blockquote>`;
    case 'admonition': return `<aside><p><strong>${escape(node.title ?? node.admonitionType)}</strong></p>${children()}</aside>`;
    case 'thematicBreak': return '<hr>';
    case 'break': return '<br>';
    case 'inlineCode': return `<code>${escape(node.value)}</code>`;
    case 'code': return `<pre><code>${escape(node.value)}</code></pre>`;
    case 'link': return `<a href="${escape(safeHref(node.url))}">${children()}</a>`;
    case 'image': return `<img src="${escape(safeHref(node.url))}" alt="${escape(node.alt)}">`;
    case 'list': return node.ordered ? `<ol start="${Number(node.start) || 1}">${children()}</ol>` : `<ul>${children()}</ul>`;
    case 'listItem': return `<li>${children()}</li>`;
    case 'table': return `<table>${children()}</table>`;
    case 'tableRow': return `<tr>${children()}</tr>`;
    case 'tableCell': return node.header ? `<th>${children()}</th>` : `<td>${children()}</td>`;
    // KaTeX output is generated from the TeX with trust disabled, not author markup.
    case 'math': return node.html ?? '';
    case 'element': return ['details', 'summary', 'strong'].includes(node.name) ? `<${node.name}>${children()}</${node.name}>` : children();
    case 'component': return children();
    default: return '';
  }
}

function textOf(node) {
  if (!node) return '';
  if (node.type === 'text' || node.type === 'inlineCode') return node.value ?? '';
  return (node.children ?? []).map(textOf).join(' ');
}

function describeTree(tree) {
  const paragraph = (tree.children ?? []).find(node => node.type === 'paragraph');
  return textOf(paragraph).replace(/\s+/g, ' ').trim().slice(0, 300);
}

/**
 * Serve the shell for a public document's URL with the document in it, or
 * return false so the ordinary static site answers.
 */
async function servePublicPage(req, res, {root, publicFs, compileMarkdown, parseFrontmatter, resolveWorkspaceSite, files = fs}) {
  if (!publicFs || !['GET', 'HEAD'].includes(req.method)) return false;
  const match = ROUTE.exec(new URL(req.url, 'http://localhost').pathname);
  if (!match) return false;
  let slug;
  let route;
  try {
    slug = decodeURIComponent(match[1]);
    route = decodeURIComponent(match[2] ?? '').replace(/^\/+|\/+$/g, '');
  } catch {
    return false;
  }
  const workspace = await publicFs.workspace(slug);
  if (!workspace) return false;
  const site = resolveWorkspaceSite(workspace.site);
  const target = route || site.site?.homeDocument || '';
  if (!target) return false;
  const candidates = /\.mdx?$/.test(target)
    ? [target]
    : [`${target}.md`, `${target}.mdx`, `${target}/index.md`, `${target}/index.mdx`];
  const found = (await publicFs.readMany(workspace.id, {paths: candidates}).catch(error => {
    // A route that is not a workspace path is simply not a public document.
    if (error.code === 'bad-path') return [];
    throw error;
  }))
    .sort((a, b) => candidates.indexOf(a.path) - candidates.indexOf(b.path))[0];
  if (!found) return false;
  const markdown = found.body.toString('utf8');
  let tree;
  try {
    tree = await compileMarkdown(markdown, site);
  } catch {
    // The application reports the document's MDX error itself.
    return false;
  }
  const frontmatter = parseFrontmatter(markdown);
  const title = found.meta?.title || found.path;
  const description = frontmatter.description || describeTree(tree);
  const shell = files.readFileSync(path.join(root, 'index.html'), 'utf8');
  const head = [
    `<title>${escape(title)} | ${escape(workspace.name)}</title>`,
    `<meta name="description" content="${escape(description)}">`,
    `<meta property="og:title" content="${escape(title)}">`,
    `<meta property="og:description" content="${escape(description)}">`,
    `<meta property="og:site_name" content="${escape(workspace.name)}">`,
  ].join('');
  const body = `<noscript><article><h1>${escape(title)}</h1>${treeToHtml(tree)}</article></noscript>`;
  const html = shell
    .replace(/<title>[\s\S]*?<\/title>/, '')
    .replace(/<meta name="description"[^>]*>/, '')
    .replace('</head>', `${head}</head>`)
    .replace(/<body([^>]*)>/, `<body$1>${body}`);
  const payload = Buffer.from(html);
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-cache',
  });
  res.end(req.method === 'HEAD' ? undefined : payload);
  return true;
}

module.exports = {servePublicPage, treeToHtml};
