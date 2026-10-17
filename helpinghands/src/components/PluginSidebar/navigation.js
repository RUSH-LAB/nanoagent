/**
 * Where the Plugins page's URL puts the reader (?tag=, ?app=), and the links
 * its sidebar offers from there. The tags are the member's own, which they
 * give the plugins they installed; a plugin may have several, or none. The
 * tag is chosen only in the sidebar's switcher, and without ?tag= every plugin
 * is shown. Beneath it the sidebar lists the plugins in view, one of which is
 * always open; each link keeps the chosen tag, so opening a plugin never changes it.
 * Below them are the drafts on the member's computer (?draft=), plugins they
 * are making there; with no plugin to open, the first draft opens.
 */
const byName = (a, b) => a.localeCompare(b);

export function pluginNavigation(apps, drafts, search, base) {
  const params = new URLSearchParams(search);
  const tags = [...new Set(apps.flatMap(item => item.tags))].sort(byName);
  const requestedTag = params.get('tag');
  const activeTag = tags.includes(requestedTag) ? requestedTag : null;
  const tagHref = tag => `${base}?${new URLSearchParams({tag})}`;
  const appHref = item => `${base}?${new URLSearchParams({...(activeTag ? {tag: activeTag} : {}), app: item.id})}`;
  const plugins = [...apps]
    .filter(item => !requestedTag || item.tags.includes(activeTag))
    .sort((a, b) => byName(a.name, b.name));

  // Like a book's landing page, a tag opens on a plugin: the one asked for,
  // else the first that is ready, else the first; a draft asked for opens instead.
  const requestedDraft = params.get('draft');
  const sortedDrafts = [...drafts].sort((a, b) => byName(a.name, b.name));
  let app = null;
  let draft = null;
  if (requestedDraft) {
    draft = sortedDrafts.find(item => item.id === requestedDraft) ?? null;
  } else if (params.get('app')) {
    app = plugins.find(item => item.id === params.get('app')) ?? null;
  } else {
    app = plugins.find(item => item.status === 'ready') ?? plugins[0] ?? null;
    if (!app) draft = sortedDrafts[0] ?? null;
  }

  return {
    app,
    requestedApp: params.get('app'),
    // A ?tag= naming no tag is reported, not swapped for another.
    unknownTag: requestedTag && !activeTag ? requestedTag : null,
    allTags: !requestedTag,
    activeTag,
    tags: [
      {title: 'All', all: true, permalink: base},
      ...tags.map(title => ({title, all: false, permalink: tagHref(title)})),
    ],
    plugins,
    links: plugins.map(item => ({
      id: item.id,
      title: item.name,
      maintenance: item.status !== 'ready',
      permalink: appHref(item),
    })),
    appHref,
    draft,
    requestedDraft,
    draftLinks: sortedDrafts.map(item => ({
      id: item.id,
      title: item.name,
      permalink: `${base}?${new URLSearchParams({draft: item.id})}`,
    })),
  };
}
