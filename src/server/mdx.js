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
const remarkDirective = require('remark-directive').default;
const GithubSlugger = require('github-slugger');
const katex = require('katex');
const yaml = require('js-yaml');
const {loadRuntimePluginContracts} = require('../../plugins/loader');

const CORE_SAFE_COMPONENTS = Object.freeze({
  VectorPlayground: {}, LinearTransformDemo: {}, GradientDescentDemo: {}, EigenDemo: {},
  RiemannSumDemo: {}, DistributionExplorer: {}, Surface3DDemo: {},
});

const RUNTIME_PLUGIN_CONTRACTS = Object.freeze(loadRuntimePluginContracts());
const ALLOWED_COMPONENT_PROPS = Object.freeze(Object.assign(
  {},
  ...RUNTIME_PLUGIN_CONTRACTS.map(plugin => plugin.safeComponents),
  CORE_SAFE_COMPONENTS,
));

const SAFE_NATIVE_ELEMENTS = Object.freeze({
  details: {open: 'boolean'},
  summary: {},
  strong: {},
});

const NATIVE_JSX_ALIASES = Object.freeze({
  MochiDetails: 'details',
  MochiSummary: 'summary',
  MochiStrong: 'strong',
});

const SAFE_JSX_NAMES = new Set([
  ...Object.keys(ALLOWED_COMPONENT_PROPS),
  ...Object.keys(SAFE_NATIVE_ELEMENTS),
  ...Object.keys(NATIVE_JSX_ALIASES),
]);

const DANGEROUS_HTML = new Set([
  'script', 'iframe', 'object', 'embed', 'style', 'link', 'meta', 'base',
]);

const MAX_CACHE_ENTRIES = 500;
const MAX_NODES = 20_000;
const cache = new Map();

function pluginEnabled(settings, name) {
  return settings?.plugins?.[name]?.enabled !== false;
}

const compilerContracts = new Map();

function contractFor(settings = {}) {
  const disabled = RUNTIME_PLUGIN_CONTRACTS
    .filter(plugin => !pluginEnabled(settings, plugin.name))
    .map(plugin => plugin.name)
    .sort();
  if (settings?.rendering?.math === false) disabled.push('core:math');
  disabled.sort();
  const key = disabled.join(',');
  if (compilerContracts.has(key)) return compilerContracts.get(key);

  const parser = unified().use(remarkParse);
  if (settings?.rendering?.math !== false) parser.use(remarkMath);
  parser
    .use(remarkGfm)
    .use(remarkDirective)
    .use(remarkMdx);
  const componentSchemas = {...CORE_SAFE_COMPONENTS};
  for (const plugin of RUNTIME_PLUGIN_CONTRACTS) {
    if (!pluginEnabled(settings, plugin.name)) continue;
    if (plugin.remark) parser.use(plugin.remark);
    Object.assign(componentSchemas, plugin.safeComponents);
  }
  const contract = {parser, componentSchemas: Object.freeze(componentSchemas), key};
  compilerContracts.set(key, contract);
  return contract;
}

function renderError(message, node) {
  const line = node?.position?.start?.line;
  const column = node?.position?.start?.column;
  const error = new Error(`${message}${line ? ` (${line}:${column})` : ''}`);
  error.code = 'unsafe-markdown';
  return error;
}

function safeUrl(value, node) {
  const url = String(value ?? '').trim();
  if (!url || url.startsWith('//') || url.includes('\\') || /[\u0000-\u001f]/.test(url)) {
    throw renderError('Unsafe URL', node);
  }
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase();
  if (scheme && !['http', 'https', 'mailto'].includes(scheme)) {
    throw renderError('Only relative, http, https, mailto, root-relative, and anchor URLs are allowed', node);
  }
  return url;
}

function componentProps(node, schemas = ALLOWED_COMPONENT_PROPS) {
  const schema = schemas[node.name];
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

function parseFrontmatter(markdown) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(String(markdown ?? ''));
  if (!match || Buffer.byteLength(match[1]) > 32 * 1024) return {};
  let source;
  try { source = yaml.load(match[1]) || {}; } catch { return {}; }
  if (!source || typeof source !== 'object' || Array.isArray(source)) return {};
  const value = {};
  if (typeof source.title === 'string') value.title = source.title.slice(0, 200);
  if (typeof source.description === 'string') value.description = source.description.slice(0, 500);
  if (typeof source.slug === 'string') value.slug = source.slug.slice(0, 400);
  if (Number.isFinite(Number(source.sidebar_position))) value.sidebarPosition = Number(source.sidebar_position);
  if (typeof source.date === 'string' || source.date instanceof Date) {
    const date = new Date(source.date);
    if (!Number.isNaN(date.getTime())) value.date = date.toISOString();
  }
  if (typeof source.draft === 'boolean') value.draft = source.draft;
  const strings = input => (Array.isArray(input) ? input : input == null ? [] : [input])
    .filter(item => typeof item === 'string').slice(0, 30).map(item => item.slice(0, 100));
  value.authors = strings(source.authors);
  value.tags = strings(source.tags);
  return value;
}

function stripFrontmatter(markdown) {
  return String(markdown ?? '').replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
}

function splitBlogPost(markdown) {
  const source = String(markdown ?? '');
  const match = /<!--\s*truncate\s*-->|\{\s*\/\*\s*truncate\s*\*\/\s*\}/i.exec(source);
  return {
    hasTruncateMarker: Boolean(match),
    excerpt: match ? source.slice(0, match.index) : source,
  };
}

function protect(source, pattern, values, body) {
  return source.replace(pattern, (...match) => {
    const token = `MOCHIPROTECTED${values.size}TOKEN`;
    values.set(token, body(...match));
    return match[0].replace(body(...match), token);
  });
}

/**
 * Preserve code and math before the MDX-JSX tokenizer sees them. In
 * particular, GFM table cells may contain LaTeX `|` and technical prose often
 * contains braces or comparisons that are not JavaScript.
 */
function prepareSource(markdown) {
  const values = new Map();
  let source = stripFrontmatter(markdown);
  source = source.replace(
    /(^|\n)([ \t]*)(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)\n\2\3(?=\n|$)/g,
    (_whole, prefix, indent, fence, info, body) => {
      const token = `MOCHIPROTECTED${values.size}TOKEN`;
      const dedented = body.split('\n')
        .map(line => line.startsWith(indent) ? line.slice(indent.length) : line)
        .join('\n');
      values.set(token, dedented);
      return `${prefix}${indent}${fence}${info}\n${indent}${token}\n${indent}${fence}`;
    },
  );
  source = protect(
    source,
    /(?<!`)(`+)(?!`)([^`\n]*?)(?<!`)\1(?!`)/g,
    values,
    (_whole, _ticks, body) => body,
  );
  // Keep display delimiters on their own lines while shielding the TeX body
  // from MDX. Collapsing a multiline block to `$$TOKEN$$` makes remark-math
  // classify it as inline math, which loses display layout and centering.
  source = source.replace(/\$\$([\s\S]*?)\$\$/g, (_whole, body) => {
    const token = `MOCHIPROTECTED${values.size}TOKEN`;
    values.set(token, body);
    return `$$\n${token}\n$$`;
  });
  source = protect(
    source,
    /(?<!\\)(?<!\$)\$(?!\$)([^$\n]+?)(?<!\\)\$(?!\$)/g,
    values,
    (_whole, body) => body,
  );

  source = source
    .replace(/<!--([\s\S]*?)-->/g, '')
    .replace(/\{\/\*([\s\S]*?)\*\/\}/g, '')
    .replace(/<(\/?)details(?=[\s/>])/gi, '<$1MochiDetails')
    .replace(/<(\/?)summary(?=[\s/>])/gi, '<$1MochiSummary')
    .replace(/<(\/?)strong(?=[\s/>])/gi, '<$1MochiStrong');

  // MDX requires a blank line between a Markdown list and the closing JSX
  // tag that owns it. Existing Docusaurus-authored pages commonly omit that
  // blank line, so normalize the boundary without changing the stored source.
  const closingNames = [...SAFE_JSX_NAMES].join('|');
  source = source.replace(
    new RegExp(`([^\\n])\\n(<\\/(?:${closingNames})>\\s*(?=\\n|$))`, 'g'),
    '$1\n\n$2',
  );

  if (/^\s*(?:import|export)\s/m.test(source)) {
    throw renderError('import and export are not allowed in workspace documents');
  }
  if (/\{\s*(?:globalThis|window|document|fetch\s*\(|eval\s*\(|Function\s*\(|process\b|require\s*\()/m.test(source)) {
    throw renderError('JavaScript expressions are not allowed in workspace documents');
  }
  if (/<[A-Za-z][^>\n]*=\s*\{/.test(source)) {
    throw renderError('Expressions are not allowed in workspace component attributes');
  }

  for (const match of source.matchAll(/<\/?([A-Za-z][A-Za-z0-9-]*)(?=[\s/>])/g)) {
    const name = match[1];
    if (DANGEROUS_HTML.has(name.toLowerCase())) {
      throw renderError(`Component <${name}> is not allowed`);
    }
    if (/^[A-Z]/.test(name) && !SAFE_JSX_NAMES.has(name)) {
      throw renderError(`Component <${name}> is not allowed`);
    }
  }

  source = source.replace(/</g, (character, offset) => {
    const tail = source.slice(offset + 1);
    const tag = /^\/?([A-Za-z][A-Za-z0-9-]*)(?=[\s/>])/.exec(tail);
    if (tag && SAFE_JSX_NAMES.has(tag[1])) return character;
    if (/^(?:https?:\/\/|mailto:)/i.test(tail)) return character;
    return '&lt;';
  });
  // Braces outside protected math and code are ordinary technical prose in
  // the existing Markdown corpus. Encode them before the full MDX parser so
  // they can never become executable expression nodes.
  source = source.replaceAll('{', '&#123;').replaceAll('}', '&#125;');

  return {source, values};
}

function restoreProtected(node, values) {
  if (!node || typeof node !== 'object') return node;
  for (const [key, value] of Object.entries(node)) {
    if (typeof value === 'string') {
      let restored = value;
      for (const [token, original] of values) restored = restored.replaceAll(token, original);
      node[key] = restored;
    } else if (Array.isArray(value)) {
      for (const child of value) restoreProtected(child, values);
    } else if (value && typeof value === 'object' && key !== 'position') {
      restoreProtected(value, values);
    }
  }
  return node;
}

function sanitizeTree(root, schemas = ALLOWED_COMPONENT_PROPS) {
  let count = 0;
  const slugger = new GithubSlugger();
  const cleanChildren = node => (node.children ?? []).map(clean);
  const textContent = node => {
    if (typeof node?.value === 'string') return node.value;
    return (node?.children ?? []).map(textContent).join('');
  };

  function clean(node) {
    if (++count > MAX_NODES) throw renderError(`Document exceeds ${MAX_NODES} render nodes`, node);
    switch (node.type) {
      case 'root': return {type: 'root', children: cleanChildren(node)};
      case 'text': return {type: 'text', value: String(node.value ?? '')};
      case 'paragraph': return {type: 'paragraph', children: cleanChildren(node)};
      case 'heading': return {
        type: 'heading',
        depth: Math.min(Math.max(node.depth || 1, 1), 6),
        id: slugger.slug(textContent(node)),
        children: cleanChildren(node),
      };
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
      case 'table': {
        const align = node.align ?? [];
        const rows = cleanChildren(node).map((row, rowIndex) => ({
          ...row,
          header: rowIndex === 0,
          children: row.children.map((cell, columnIndex) => ({
            ...cell,
            header: rowIndex === 0,
            align: align[columnIndex] ?? null,
          })),
        }));
        return {type: 'table', align, children: rows};
      }
      case 'tableRow': return {type: 'tableRow', children: cleanChildren(node)};
      case 'tableCell': return {type: 'tableCell', children: cleanChildren(node)};
      case 'containerDirective': {
        const type = String(node.name ?? '').toLowerCase();
        if (!['note', 'tip', 'info', 'warning', 'danger', 'caution'].includes(type)) {
          throw renderError(`Admonition :::${type || '?'} is not allowed`, node);
        }
        const children = cleanChildren(node);
        const labelIndex = (node.children ?? []).findIndex(child => child.data?.directiveLabel);
        const title = labelIndex >= 0 ? textContent(node.children[labelIndex]) : null;
        if (labelIndex >= 0) children.splice(labelIndex, 1);
        return {type: 'admonition', admonitionType: type, title, children};
      }
      // `remark-directive` also recognizes compact `:name` sequences. They
      // occur in ordinary technical notation such as `1:H`; only fenced
      // container directives (`:::tip`) are application syntax.
      case 'textDirective': return {
        type: 'text',
        value: `:${node.name}${textContent(node)}`,
      };
      case 'leafDirective': return {
        type: 'text',
        value: `::${node.name}${textContent(node)}`,
      };
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
      case 'mdxJsxTextElement': {
        const nativeName = NATIVE_JSX_ALIASES[node.name] ?? node.name;
        if (SAFE_NATIVE_ELEMENTS[nativeName]) {
          return {
            type: 'element', name: nativeName,
            props: componentProps({...node, name: nativeName}, SAFE_NATIVE_ELEMENTS),
            children: cleanChildren(node),
          };
        }
        return {
          type: 'component', name: node.name, props: componentProps(node, schemas),
          children: cleanChildren(node),
        };
      }
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

async function compileMarkdown(markdown, settings = {}) {
  const contract = contractFor(settings);
  const prepared = prepareSource(markdown);
  const tree = restoreProtected(contract.parser.parse(prepared.source), prepared.values);
  return sanitizeTree(await contract.parser.run(tree), contract.componentSchemas);
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

async function compileDocument(document, settings = {}) {
  const contract = contractFor(settings);
  const key = `${document.id}@${document.updatedAt}@${contract.key}`;
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;
  const tree = await compileMarkdown(document.markdown, settings);
  cacheSet(key, tree);
  return tree;
}

function _cacheSize() { return cache.size; }
function _clearCache() { cache.clear(); }

module.exports = {
  compileMarkdown,
  compileDocument,
  parseFrontmatter,
  splitBlogPost,
  sanitizeTree,
  safeUrl,
  prepareSource,
  ALLOWED_COMPONENT_PROPS,
  SAFE_NATIVE_ELEMENTS,
  MAX_CACHE_ENTRIES,
  MAX_NODES,
  _cacheSize,
  _clearCache,
};
