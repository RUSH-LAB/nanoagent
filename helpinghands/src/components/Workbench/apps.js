/**
 * Which app edits a file, as an operating system knows which program opens
 * one: a plugin declares the files it opens in plugin.json `opens`, which the
 * workspace site lists. The apps' own records are app state, which the
 * Explorer does not show (fs/records.js). Returns `{title, page}` (a workspace
 * page such as "bibliography") or null.
 */
export function appFor(path, plugins = []) {
  for (const plugin of plugins) {
    for (const rule of plugin.opens ?? []) {
      if ((rule.path && path.startsWith(rule.path)) || (rule.extension && path.toLowerCase().endsWith(rule.extension.toLowerCase()))) {
        return {title: plugin.title, page: rule.page};
      }
    }
  }
  return null;
}
