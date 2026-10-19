/**
 * The workspace's sections, the one list of them: each opened from the
 * activity bar and kept mounted while the member is in the workspace
 * (./Sections.js), by the path under /w/<slug>/ each lives at, Home at
 * /w/<slug> itself. The build reads it for the route they share
 * (runtime-content), the browser for the activity bar and what each section
 * draws (./registry.js), which must name every section here and no other.
 *
 * `running` keeps a section running while hidden (./Sections.js); `foot`
 * puts its icon at the foot of the activity bar.
 *
 * CommonJS for the same reason as utils/paths.js: the build needs it too.
 */
const SECTIONS = [
  {id: 'home', title: 'Home', path: ''},
  {id: 'plugins', title: 'Plugins', path: 'apps', running: true},
  {id: 'marketplace', title: 'Marketplace', path: 'marketplace'},
  {id: 'workspace', title: 'Filesystem', path: 'workspace'},
  {id: 'settings', title: 'Settings', path: 'settings', foot: true},
];

/** The section open at `pathname`, a path under /w/<slug>, or null for any other page there. */
function sectionAt(pathname) {
  const parts = pathname.split('/');
  if (parts.length > 5 || (parts.length === 5 && parts[4] !== '')) return null;
  return SECTIONS.find(section => section.path === (parts[3] ?? '')) ?? null;
}

module.exports = {SECTIONS, sectionAt};
