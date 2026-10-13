function cleanTitle(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

export function slugifyDocumentTitle(value) {
  return cleanTitle(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
}

function availableSlug(base, prefix, existingPaths) {
  const routes = new Set((existingPaths || []).map(path => String(path)
    .replace(/\.(md|mdx)$/i, '')
    .replace(/\/index$/i, '')));
  let slug = base;
  let suffix = 2;
  while (routes.has(`${prefix}/${slug}`)) {
    slug = `${base}-${suffix}`;
    suffix += 1;
  }
  return slug;
}

function documentPosition(document) {
  if (Number.isFinite(document?.frontmatter?.sidebarPosition)) return document.frontmatter.sidebarPosition;
  const filename = String(document?.path || '').split('/').pop().replace(/\.(md|mdx)$/i, '');
  if (/^\d+[-_.]\d+/.test(filename)) return undefined;
  const match = /^(\d+)\s*[-_.]+\s*[^-_.\s]/.exec(filename);
  return match ? Number(match[1]) : undefined;
}

/** Position a new docs page immediately before or after a sibling page. */
export function adjacentDocumentPosition(documents, currentPath, direction) {
  const current = documents.find(document => document.path === currentPath);
  if (!current) return undefined;
  const directory = current.path.includes('/') ? current.path.slice(0, current.path.lastIndexOf('/')) : '';
  const siblings = documents
    .filter(document => (document.path.includes('/') ? document.path.slice(0, document.path.lastIndexOf('/')) : '') === directory)
    .sort((a, b) => {
      const aPosition = documentPosition(a) ?? Number.MAX_SAFE_INTEGER;
      const bPosition = documentPosition(b) ?? Number.MAX_SAFE_INTEGER;
      return aPosition - bPosition || a.path.localeCompare(b.path);
    });
  const index = siblings.findIndex(document => document.path === currentPath);
  const currentPosition = documentPosition(current);
  const neighbor = siblings[index + (direction === 'before' ? -1 : 1)];
  const neighborPosition = documentPosition(neighbor);
  if (Number.isFinite(currentPosition) && Number.isFinite(neighborPosition)) {
    return (currentPosition + neighborPosition) / 2;
  }
  if (Number.isFinite(currentPosition)) return currentPosition + (direction === 'before' ? -1 : 1);
  if (Number.isFinite(neighborPosition)) return neighborPosition + (direction === 'before' ? 1 : -1);
  return undefined;
}

/** Build a useful first draft inside a configured docs or blog collection. */
export function newDocumentDraft({
  collection, title, existingPaths = [], author = null, group = null,
  sidebarPosition = null, now = new Date(),
}) {
  const clean = cleanTitle(title);
  if (!clean) throw new TypeError('A title is required');

  const isBlog = collection?.type === 'blog';
  const prefix = String(collection?.pathPrefix || 'pages').replace(/^\/+|\/+$/g, '');
  const fallback = isBlog ? 'new-post' : 'new-page';
  const slug = availableSlug(slugifyDocumentTitle(clean) || fallback, prefix, existingPaths);
  const quotedTitle = JSON.stringify(clean);
  const fields = isBlog
    ? [
        '---',
        `slug: ${slug}`,
        `title: ${quotedTitle}`,
        `date: ${now.toISOString().slice(0, 10)}`,
        ...(author ? [`authors: [${JSON.stringify(author)}]`] : []),
        ...(group ? [`group: ${JSON.stringify(cleanTitle(group))}`] : []),
        '---',
        '',
        'Start writing here.',
      ]
    : [
        '---',
        `title: ${quotedTitle}`,
        ...(Number.isFinite(sidebarPosition) ? [`sidebar_position: ${sidebarPosition}`] : []),
        '---',
        '',
        `# ${clean}`,
        '',
        'Start writing here.',
      ];

  return {path: `${prefix}/${slug}.md`, markdown: `${fields.join('\n')}\n`, type: isBlog ? 'post' : 'page'};
}
