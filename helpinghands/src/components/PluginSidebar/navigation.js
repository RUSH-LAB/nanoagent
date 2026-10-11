/**
 * Where the Plugins page's URL puts the reader (?group=, ?app=), and the links
 * its sidebar offers from there. The group is chosen only in the sidebar's
 * switcher, and without ?group= every group is shown together. Beneath it the
 * sidebar lists the plugins in view, one of which is always open; each link
 * keeps the chosen group, so opening a plugin never changes it.
 */
const byName = (a, b) => a.localeCompare(b);

export function pluginNavigation(apps, search, base) {
  const params = new URLSearchParams(search);
  const groups = [...new Set(apps.map(item => item.group))].sort(byName);
  const requestedGroup = params.get('group');
  const activeGroup = groups.includes(requestedGroup) ? requestedGroup : null;
  const groupHref = group => `${base}?${new URLSearchParams({group})}`;
  const appHref = item => `${base}?${new URLSearchParams({...(activeGroup ? {group: activeGroup} : {}), app: item.id})}`;
  const plugins = [...apps]
    .filter(item => !requestedGroup || item.group === activeGroup)
    .sort((a, b) => byName(a.name, b.name));

  // Like a book's landing page, a group opens on a plugin: the one asked for,
  // else the first that is ready, else the first.
  const app = params.get('app')
    ? plugins.find(item => item.id === params.get('app')) ?? null
    : plugins.find(item => item.status === 'ready') ?? plugins[0] ?? null;

  return {
    app,
    requestedApp: params.get('app'),
    // A ?group= naming no group is reported, not swapped for another.
    unknownGroup: requestedGroup && !activeGroup ? requestedGroup : null,
    allGroups: !requestedGroup,
    activeGroup,
    groups: [
      {title: 'All', all: true, permalink: base},
      ...groups.map(title => ({title, all: false, permalink: groupHref(title)})),
    ],
    plugins,
    links: plugins.map(item => ({
      id: item.id,
      title: item.name,
      maintenance: item.status !== 'ready',
      permalink: appHref(item),
    })),
    appHref,
  };
}
