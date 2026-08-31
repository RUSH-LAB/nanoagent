/**
 * Parse user-authored content into a small, inert render tree.
 *
 * User content must never become JavaScript in the signed-in origin. This
 * module therefore returns data, not a function body. The client renders only
 * the node types and component names explicitly allowed below.
 */
const {unified} = require('unified');
const remarkParse = require('remark-parse').default;
const remarkMdx = require('remark-mdx').default;
const remarkMath = require('remark-math').default;
const remarkGfm = require('remark-gfm').default;
const katex = require('katex');
const {loadRuntimeRemarkPlugins, loadSafeComponents} = require('../../plugins/loader');

const CORE_SAFE_COMPONENTS = Object.freeze({
  VectorPlayground: {}, LinearTransformDemo: {}, GradientDescentDemo: {}, EigenDemo: {},
  RiemannSumDemo: {}, DistributionExplorer: {}, Surface3DDemo: {},
});

const ALLOWED_COMPONENT_PROPS = Object.freeze({
  ...loadSafeComponents(),
  ...CORE_SAFE_COMPONENTS,
});

const MAX_CACHE_ENTRIES = 500;
const MAX_NODES = 20_000;
const cache = new Map();
const parser = unified()
  .use(remarkParse)
  .use(remarkMdx)
  .use(remarkMath)
  .use(remarkGfm);
for (const plugin of loadRuntimeRemarkPlugins()) parser.use(plugin);

function renderError(message, node) {
  const line = node?.position?.start?.line;
  const column = node?.position?.start?.column;
  const error = new Error(`${message}${line ? ` (${line}:${column})` : ''}`);
  error.code = 'unsafe-markdown';
  return error;
}

function safeUrl(value, node) {
  const url = String(value ?? '').trim();
  if (!url || url.startsWith('//') || url.includes('\\')) throw renderError('Unsafe URL', node);
  if (/^(?:https?:|mailto:)/i.test(url) || url.startsWith('/') || url.startsWith('#')) return url;
  throw renderError('Only http, https, mailto, root-relative, and anchor URLs are allowed', node);
}

function componentProps(node) {
  const schema = ALLOWED_COMPONENT_PROPS[node.name];
  if (!schema) throw renderError(`Component <${node.name || '?'}> is not allowed`, node);
  const props = {};
  for (const attribute of node.attributes ?? []) {
    const type = schema[attribute.name];
    if (attribute.type !== 'mdxJsxAttribute' || !attribute.name || !type) {
      throw renderError(`Attribute on <${node.name}> is not allowed`, attribute);
    }
    if (attribute.value !== null && typeof attribute.value !== 'string') {
      throw renderError(`Expressions are not allowed in <${node.name}>`, attribute);
    }
    const value = attribute.value === null ? true : attribute.value;
    if (type === 'number') {
      const number = Number(value);
      if (!Number.isFinite(number)) throw renderError(`${attribute.name} on <${node.name}> must be numeric`, node);
      props[attribute.name] = number;
    } else if (type === 'boolean') {
      if (value !== true && !['true', 'false'].includes(value)) {
        throw renderError(`${attribute.name} on <${node.name}> must be true or false`, node);
      }
      props[attribute.name] = value === true || value === 'true';
    } else if (type === 'stringOrBoolean') {
      props[attribute.name] = value;
    } else if (type === 'string' && typeof value === 'string') {
      props[attribute.name] = value;
    } else {
      throw renderError(`${attribute.name} on <${node.name}> must be ${type}`, node);
    }
  }
  return props;
}

function stripFrontmatter(markdown) {
  return String(markdown ?? '').replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
}

function sanitizeTree(root) {
  let count = 0;
  const cleanChildren = node => (node.children ?? []).map(clean);

  function clean(node) {
    if (++count > MAX_NODES) throw renderError(`Document exceeds ${MAX_NODES} render nodes`, node);
    switch (node.type) {
      case 'root': return {type: 'root', children: cleanChildren(node)};
      case 'text': return {type: 'text', value: String(node.value ?? '')};
      case 'paragraph': return {type: 'paragraph', children: cleanChildren(node)};
      case 'heading': return {type: 'heading', depth: Math.min(Math.max(node.depth || 1, 1), 6), children: cleanChildren(node)};
      case 'emphasis': return {type: 'emphasis', children: cleanChildren(node)};
      case 'strong': return {type: 'strong', children: cleanChildren(node)};
      case 'delete': return {type: 'delete', children: cleanChildren(node)};
      case 'blockquote': return {type: 'blockquote', children: cleanChildren(node)};
      case 'thematicBreak': return {type: 'thematicBreak'};
      case 'break': return {type: 'break'};
      case 'inlineCode': return {type: 'inlineCode', value: String(node.value ?? '')};
      case 'code': return {
        type: 'code', value: String(node.value ?? ''),
        lang: typeof node.lang === 'string' ? node.lang.slice(0, 40) : null,
      };
      case 'link': return {
        type: 'link', url: safeUrl(node.url, node),
        title: typeof node.title === 'string' ? node.title : null,
        children: cleanChildren(node),
      };
      case 'image': return {
        type: 'image', url: safeUrl(node.url, node), alt: String(node.alt ?? ''),
        title: typeof node.title === 'string' ? node.title : null,
      };
      case 'list': return {
        type: 'list', ordered: Boolean(node.ordered), start: Number(node.start) || 1,
        children: cleanChildren(node),
      };
      case 'listItem': return {
        type: 'listItem', checked: typeof node.checked === 'boolean' ? node.checked : null,
        children: cleanChildren(node),
      };
      case 'table': return {type: 'table', align: node.align ?? [], children: cleanChildren(node)};
      case 'tableRow': return {type: 'tableRow', children: cleanChildren(node)};
      case 'tableCell': return {type: 'tableCell', children: cleanChildren(node)};
      case 'math':
      case 'inlineMath': {
        const display = node.type === 'math';
        return {
          type: 'math', display, tex: String(node.value ?? ''),
          html: katex.renderToString(String(node.value ?? ''), {
            displayMode: display, throwOnError: false, strict: 'warn', trust: false,
          }),
        };
      }
      case 'mdxJsxFlowElement':
      case 'mdxJsxTextElement':
        return {
          type: 'component', name: node.name, props: componentProps(node),
          children: cleanChildren(node),
        };
      case 'mdxjsEsm':
        throw renderError('import and export are not allowed in workspace documents', node);
      case 'mdxFlowExpression':
      case 'mdxTextExpression':
        throw renderError('JavaScript expressions are not allowed in workspace documents', node);
      case 'html':
        throw renderError('Raw HTML is not allowed in workspace documents', node);
      case 'definition':
        return {type: 'empty'};
      default:
        throw renderError(`Markdown node ${node.type} is not allowed`, node);
    }
  }

  return clean(root);
}

async function compileMarkdown(markdown) {
  const tree = parser.parse(stripFrontmatter(markdown));
  return sanitizeTree(await parser.run(tree));
}

function cacheGet(key) {
  const hit = cache.get(key);
  if (hit !== undefined) {
    cache.delete(key);
    cache.set(key, hit);
  }
  return hit;
}

function cacheSet(key, value) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
}

async function compileDocument(document) {
  const key = `${document.id}@${document.updatedAt}`;
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;
  const tree = await compileMarkdown(document.markdown);
  cacheSet(key, tree);
  return tree;
}

function _cacheSize() { return cache.size; }
function _clearCache() { cache.clear(); }

module.exports = {
  compileMarkdown,
  compileDocument,
  sanitizeTree,
  safeUrl,
  ALLOWED_COMPONENT_PROPS,
  MAX_CACHE_ENTRIES,
  MAX_NODES,
  _cacheSize,
  _clearCache,
};
