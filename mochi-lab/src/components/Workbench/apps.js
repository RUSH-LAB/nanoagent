/**
 * Which app edits a file, as an operating system knows which program opens
 * one. The built-in apps keep their records under the folders fs/records.js
 * names; a plugin declares its own in plugin.json `opens`, which the workspace
 * site lists. Returns `{title, page}` (a workspace page such as "tasks") or null.
 */

// Domain folder → the built-in page that edits its records.
const CORE_APPS = Object.freeze({
  tasks: {title: 'Tasks', page: 'tasks'},
  flashcards: {title: 'Flashcards', page: 'flashcards'},
  glossary: {title: 'Glossary', page: 'glossary'},
  whiteboards: {title: 'Whiteboard', page: 'whiteboard'},
  'reading-lists': {title: 'Reading lists', page: 'reading-lists'},
  schedule: {title: 'Timeline', page: 'timeline'},
});

export function appFor(path, plugins = []) {
  for (const plugin of plugins) {
    for (const rule of plugin.opens ?? []) {
      if ((rule.path && path.startsWith(rule.path)) || (rule.extension && path.toLowerCase().endsWith(rule.extension.toLowerCase()))) {
        return {title: plugin.title, page: rule.page};
      }
    }
  }
  const parts = path.split('/');
  const domain = parts[0] === 'apps' ? parts[1] : parts[0] === 'home' ? parts[2] : null;
  return CORE_APPS[domain] ?? null;
}
