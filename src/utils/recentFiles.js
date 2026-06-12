/**
 * Storage key for the editor's recent-files list.
 *
 * The list is persisted in localStorage as an access-ordered JSON array of file
 * paths (first entry = most recent). Centralizing the key here keeps the three
 * call sites in sync: the RecentFiles sidebar and the TipTapEditor empty state
 * read it, and the Editor in index.js writes it whenever a file is opened.
 *
 * Only the key is shared. Each call site keeps its own parse, cap, and error
 * handling on purpose (the two readers cap at 5 and recover differently, while
 * the writer caps at 10), so that read logic is intentionally not factored out.
 */
export const RECENT_FILES_KEY = 'mochi-recent-files';
