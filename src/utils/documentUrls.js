function splitSuffix(value) {
  const match = /^([^?#]*)([?#].*)?$/.exec(String(value ?? ''));
  return {pathname: match?.[1] ?? '', suffix: match?.[2] ?? ''};
}

function cleanSegments(pathname, base = []) {
  const segments = pathname.split('/');
  const result = [...base];
  for (const segment of segments) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (result.length === 0) return null;
      result.pop();
      continue;
    }
    result.push(segment);
  }
  return result;
}

function routePath(segments) {
  const joined = segments.join('/').replace(/\.(?:md|mdx)$/i, '').replace(/\/index$/i, '');
  return joined.split('/').map(segment => encodeURIComponent(segment)).join('/');
}

export function workspaceDocumentHref(url, workspaceSlug, documentPath) {
  const value = String(url ?? '');
  if (!value || value.startsWith('#') || /^(?:https?:|mailto:)/i.test(value)) return value;
  if (value.startsWith('/w/') || value.startsWith('/api/') || value.startsWith('/img/') || value.startsWith('/assets/')) {
    return value;
  }

  const {pathname, suffix} = splitSuffix(value);
  const absolute = pathname.startsWith('/');
  const normalizedInput = absolute ? pathname.slice(1).replace(/^documents\//, '') : pathname;
  const current = String(documentPath ?? '').split('/').filter(Boolean);
  if (current.length && /\.mdx?$/i.test(current[current.length - 1])) current.pop();
  const segments = cleanSegments(normalizedInput, absolute ? [] : current);
  if (!segments) return '#';
  const path = routePath(segments);
  return `/w/${encodeURIComponent(workspaceSlug)}/documents${path ? `/${path}` : ''}${suffix}`;
}

export function workspaceAssetHref(url, workspaceId, documentPath) {
  const value = String(url ?? '');
  if (!value || value.startsWith('/') || value.startsWith('#') || /^(?:https?:|data:|blob:)/i.test(value)) {
    return value;
  }
  const {pathname, suffix} = splitSuffix(value);
  const current = String(documentPath ?? '').split('/').filter(Boolean);
  if (current.length) current.pop();
  const segments = cleanSegments(pathname, current);
  if (!segments || !workspaceId) return value;
  const logicalPath = segments.join('/');
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/assets?path=${encodeURIComponent(logicalPath)}${suffix}`;
}
