/**
 * Storage key for the editor's session-scoped presence userId.
 *
 * The id is persisted in sessionStorage as an opaque string and identifies the
 * current browser session to the presence, streak, goal, and role APIs.
 * Centralizing the key here keeps every call site in sync: TipTapEditor reads
 * or lazily generates it in getSessionUserId, the streak and goal fetches read
 * it, and the Editor in index.js reads it for the role check.
 *
 * Only the key is shared. Each call site keeps its own fallback on purpose (the
 * streak and goal fetches default to 'default', the role check defaults to
 * 'anonymous', and getSessionUserId generates and stores a fresh id), so the
 * read logic is intentionally not factored out.
 */
export const PRESENCE_USER_ID_KEY = 'mochi-presence-userId';
