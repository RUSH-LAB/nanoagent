'use strict';

/**
 * Mochi Paper Protocol v1.
 *
 * A paper is deliberately small: enough information to identify and cite it,
 * where that information came from, where the official paper lives, where its
 * PDF lives, and the tags a workspace uses to organize it.  The normalizer
 * accepts the older bibliography shape so existing references need no bulk
 * migration.
 */
const PAPER_SCHEMA = 'mochi.paper/1';
const SOURCE_TYPES = new Set(['doi', 'arxiv', 'publisher', 'url', 'bibtex', 'manual']);
const API_TEST_KEY_PATTERNS = Object.freeze([
  /^__test_\d+_(?:ref|import)$/,
  /^__wf_\d+_ref$/,
  /^wftest-\d+_ref$/,
]);

const CONFERENCES = new Set([
  'NeurIPS', 'NIPS', 'ICML', 'ICLR', 'CVPR', 'ICCV', 'ECCV', 'BMVC',
  'ACL', 'EMNLP', 'NAACL', 'EACL', 'COLING', 'CoNLL', 'AAAI', 'IJCAI',
  'UAI', 'AISTATS', 'COLT', 'KDD', 'SIGIR', 'WWW', 'WSDM', 'CIKM',
  'RecSys', 'SIGMOD', 'VLDB', 'ICDE', 'OSDI', 'SOSP', 'NSDI', 'ATC',
  'EuroSys', 'SoCC', 'MLSys', 'PLDI', 'POPL', 'OOPSLA', 'ICFP', 'ICSE',
  'FSE', 'ASE', 'ISSTA', 'MICCAI', 'RSS', 'ICRA', 'IROS', 'CoRL',
  'SIGGRAPH', 'CHI', 'UIST', 'CSCW', 'CCS', 'NDSS', 'AISec', 'STOC',
  'FOCS', 'SODA', 'INTERSPEECH', 'ICASSP', 'TREC', 'EMNLP Findings',
  'ACL Findings', 'NAACL Findings',
]);

const LATEX_ESCAPES = {
  '\\': '\\textbackslash{}', '&': '\\&', '%': '\\%', '$': '\\$',
  '#': '\\#', '_': '\\_', '{': '\\{', '}': '\\}',
  '~': '\\textasciitilde{}', '^': '\\textasciicircum{}',
};

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeDoi(value) {
  return text(value)
    .replace(/^doi:\s*/i, '')
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .trim() || null;
}

function normalizeArxivId(value) {
  const raw = text(value);
  if (!raw) return null;
  const withoutUrl = raw
    .replace(/^arxiv:\s*/i, '')
    .replace(/^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\//i, '')
    .replace(/\.pdf(?:\?.*)?$/i, '')
    .replace(/[?#].*$/, '');
  return /^[a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?$/i.test(withoutUrl)
    || /^\d{4}\.\d{4,5}(?:v\d+)?$/i.test(withoutUrl)
    ? withoutUrl
    : null;
}

function normalizeAuthors(value) {
  const authors = Array.isArray(value) ? value : value ? [value] : [];
  return authors
    .map(author => typeof author === 'string' ? author.trim() : '')
    .filter(Boolean)
    .slice(0, 100);
}

function normalizeTags(value) {
  const tags = Array.isArray(value) ? value : [];
  const seen = new Set();
  const normalized = [];
  for (const raw of tags) {
    const tag = text(raw).replace(/\s+/g, ' ').slice(0, 80);
    const identity = tag.toLocaleLowerCase();
    if (!tag || seen.has(identity)) continue;
    seen.add(identity);
    normalized.push(tag);
    if (normalized.length === 50) break;
  }
  return normalized;
}

function normalizeUrl(value) {
  const url = text(value);
  if (!url) return null;
  if (url.startsWith('/')) return url;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

function isIntegrationTestPaper(key, input = {}) {
  const citationKey = String(key || '');
  if (API_TEST_KEY_PATTERNS.some(pattern => pattern.test(citationKey))) return true;
  return /^Test Paper __rem_\d+$/.test(text(input?.title));
}

function sourceFor(entry, {doi, arxivId, officialUrl}) {
  const supplied = entry.source && typeof entry.source === 'object' && !Array.isArray(entry.source)
    ? entry.source
    : {};
  let type = SOURCE_TYPES.has(supplied.type) ? supplied.type : null;
  if (!type) type = doi ? 'doi' : arxivId ? 'arxiv' : officialUrl ? 'url' : 'manual';

  const id = text(supplied.id) || (
    type === 'doi' ? doi : type === 'arxiv' ? arxivId : type === 'url' ? officialUrl : null
  );
  const canonicalUrl = type === 'doi' && doi
    ? `https://doi.org/${doi}`
    : type === 'arxiv' && arxivId
      ? `https://arxiv.org/abs/${arxivId}`
      : officialUrl;

  return {
    type,
    id: id || null,
    url: normalizeUrl(supplied.url) || canonicalUrl || null,
    provider: text(supplied.provider) || null,
  };
}

function normalizePaper(key, input = {}) {
  const entry = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const doi = normalizeDoi(entry.doi || entry.source?.type === 'doi' && entry.source?.id);
  const arxivId = normalizeArxivId(
    entry.arxivId
      || (entry.source?.type === 'arxiv' ? entry.source.id : '')
      || entry.officialUrl
      || entry.url,
  );
  const officialUrl = normalizeUrl(entry.officialUrl || entry.url)
    || (doi ? `https://doi.org/${doi}` : null)
    || (arxivId ? `https://arxiv.org/abs/${arxivId}` : null);
  const localPdf = normalizeUrl(entry.raw?.pdfUrl);
  const pdfUrl = normalizeUrl(entry.pdfUrl)
    || localPdf
    || (arxivId ? `https://arxiv.org/pdf/${arxivId}.pdf` : null);
  const year = Number.parseInt(entry.year, 10);

  return {
    ...entry,
    schema: PAPER_SCHEMA,
    ...(key ? {key: String(key)} : {}),
    type: text(entry.type).toLowerCase() || 'misc',
    title: text(entry.title),
    author: normalizeAuthors(entry.author),
    year: Number.isFinite(year) ? year : null,
    venue: text(entry.venue),
    doi,
    arxivId,
    source: sourceFor(entry, {doi, arxivId, officialUrl}),
    officialUrl,
    pdfUrl,
    tags: normalizeTags(entry.tags),
  };
}

function paperForStorage(input) {
  const paper = normalizePaper(null, input);
  const stored = {
    schema: paper.schema,
    type: paper.type,
    title: paper.title,
    author: paper.author,
    year: paper.year,
    venue: paper.venue,
    source: paper.source,
    officialUrl: paper.officialUrl,
    pdfUrl: paper.pdfUrl,
    tags: paper.tags,
  };
  for (const field of [
    'doi', 'arxivId', 'volume', 'issue', 'pages', 'publisher',
    'tracked', 'publishedVenue', 'journal', 'citationCount', 'referenceCount', 'tldr',
  ]) {
    if (paper[field] != null && paper[field] !== '') stored[field] = paper[field];
  }
  return stored;
}

function validatePaper(input) {
  const paper = normalizePaper(null, input);
  const errors = [];
  if (!paper.title) errors.push('title is required');
  if (!SOURCE_TYPES.has(paper.source.type)) errors.push('source type is invalid');
  if (paper.pdfUrl && !/^(?:https?:\/\/|\/)/.test(paper.pdfUrl)) errors.push('PDF URL is invalid');
  if (paper.officialUrl && !/^https?:\/\//.test(paper.officialUrl)) errors.push('official URL is invalid');
  return {paper, errors};
}

function citationKeyFor(input, usedKeys = []) {
  const paper = normalizePaper(null, input);
  const lastName = (paper.author[0] || 'paper').split(/\s+/).pop()
    .normalize('NFKD').replace(/[^a-zA-Z0-9]/g, '').toLowerCase() || 'paper';
  const base = `${lastName}${paper.year || 'nd'}`;
  const used = usedKeys instanceof Set ? usedKeys : new Set(usedKeys);
  if (!used.has(base)) return base;
  for (let i = 0; i < 26; i++) {
    const candidate = `${base}${String.fromCharCode(97 + i)}`;
    if (!used.has(candidate)) return candidate;
  }
  let suffix = 2;
  while (used.has(`${base}${suffix}`)) suffix++;
  return `${base}${suffix}`;
}

function cleanBibtexValue(value) {
  return String(value == null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\\&%$#_{}~^]/g, character => LATEX_ESCAPES[character]);
}

function inferBibtexType(input) {
  const paper = normalizePaper(null, input);
  if (paper.type === 'book') return 'book';
  if (paper.type === 'inproceedings') return 'inproceedings';
  if (paper.type === 'phdthesis' || paper.type === 'thesis') return 'phdthesis';
  if (paper.type === 'techreport') return 'techreport';
  if (CONFERENCES.has(paper.venue) || /proceedings|conference|workshop|symposium|findings/i.test(paper.venue)) {
    return 'inproceedings';
  }
  return paper.type === 'article' ? 'article' : 'misc';
}

function paperToBibtex(key, input) {
  const paper = normalizePaper(key, input);
  const type = inferBibtexType(paper);
  const fields = [`  title = {${cleanBibtexValue(paper.title)}}`];
  if (paper.author.length) fields.push(`  author = {${cleanBibtexValue(paper.author.join(' and '))}}`);
  if (paper.year) fields.push(`  year = {${paper.year}}`);
  if (paper.venue) {
    const name = type === 'inproceedings' ? 'booktitle' : type === 'article' ? 'journal' : type === 'book' ? 'publisher' : 'howpublished';
    fields.push(`  ${name} = {${cleanBibtexValue(paper.venue)}}`);
  }
  if (paper.doi) fields.push(`  doi = {${cleanBibtexValue(paper.doi)}}`);
  if (paper.officialUrl) fields.push(`  url = {${cleanBibtexValue(paper.officialUrl)}}`);
  for (const field of ['volume', 'issue', 'pages', 'publisher']) {
    if (paper[field] && !(field === 'publisher' && type === 'book' && paper.venue === paper[field])) {
      fields.push(`  ${field} = {${cleanBibtexValue(paper[field])}}`);
    }
  }
  return `@${type}{${key},\n${fields.join(',\n')}\n}`;
}

module.exports = {
  PAPER_SCHEMA,
  SOURCE_TYPES,
  normalizeDoi,
  normalizeArxivId,
  normalizeAuthors,
  normalizeTags,
  normalizePaper,
  paperForStorage,
  validatePaper,
  citationKeyFor,
  cleanBibtexValue,
  inferBibtexType,
  paperToBibtex,
  isIntegrationTestPaper,
};
