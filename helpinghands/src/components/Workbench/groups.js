/**
 * The workbench's editor groups, side by side as VS Code splits its editor:
 * each `{id, paths, active}`, its tabs' paths in order and the one shown. A
 * file open in two groups is one tab's state in the workbench, shown twice.
 * Every function returns new groups; there is always at least one, and only
 * the last one left may be empty.
 */

let nextId = 1;

export const newGroup = () => ({id: nextId++, paths: [], active: null});

// The tab shown once `path` at `index` leaves `paths`: the one after it, else the one before.
const neighbour = (paths, index) => paths[Math.min(index, paths.length - 1)] ?? null;

/** Groups without an empty one, unless it is the only one. */
const tidy = groups => {
  const kept = groups.filter(group => group.paths.length);
  return kept.length ? kept : [groups[0]];
};

/**
 * `path` shown in group `index`, a new group at the end when `index` is one
 * past the last: kept where it is when the group has it, else in place of
 * `replacing` (a preview tab), else after the group's active tab.
 */
export function showIn(groups, index, path, {replacing = null} = {}) {
  const all = index === groups.length ? [...groups, newGroup()] : groups;
  return all.map((group, at) => {
    if (at !== index) return group;
    if (group.paths.includes(path)) return {...group, active: path};
    const paths = [...group.paths];
    const place = replacing && paths.includes(replacing) ? paths.indexOf(replacing) : paths.indexOf(group.active) + 1 || paths.length;
    paths.splice(place, replacing && paths.includes(replacing) ? 1 : 0, path);
    return {...group, paths, active: path};
  });
}

// `group` without the paths for which `gone(path)` holds.
function without(group, gone) {
  if (!group.paths.some(gone)) return group;
  const paths = group.paths.filter(path => !gone(path));
  const active = group.active && gone(group.active) ? neighbour(paths, group.paths.indexOf(group.active)) : group.active;
  return {...group, paths, active};
}

/** Every path for which `gone(path)` holds taken out of every group. */
export const dropPaths = (groups, gone) => tidy(groups.map(group => without(group, gone)));

/** `path` closed in group `index` only. */
export const closeIn = (groups, index, path) => tidy(groups.map((group, at) => (at === index ? without(group, item => item === path) : group)));

/** Paths after renames: `moved` maps a path to where it is now. */
export const moveAll = (groups, moved) => groups.map(group => ({
  ...group, paths: group.paths.map(moved), active: group.active && moved(group.active),
}));

/**
 * The tab `path` of group `from` dragged to group `to`, before the tab
 * `before` there or at its end, and shown there; a group the tab leaves empty
 * closes.
 */
export function moveTab(groups, from, path, to, before = null) {
  return tidy(groups.map((group, at) => {
    if (at !== to) return at === from ? without(group, item => item === path) : group;
    const paths = group.paths.filter(item => item !== path);
    const place = before && paths.includes(before) ? paths.indexOf(before) : paths.length;
    return {...group, paths: [...paths.slice(0, place), path, ...paths.slice(place)], active: path};
  }));
}
