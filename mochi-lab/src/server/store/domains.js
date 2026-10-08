/**
 * Which feature owns its data how.
 *
 * Every domain below used to be a JSON file with no notion of who anything
 * belonged to. Deciding that per feature, at each of the handlers that touches
 * it, is how one of them ends up wrong; deciding it once, here, is what lets
 * ./index apply it without the handler participating.
 *
 * Two answers only:
 *
 *   'user'  the item is one person's, inside one workspace. Two members of the
 *           same lab have separate bookmarks, and the same account in two
 *           workspaces has separate bookmarks in each, because a scope is a
 *           pair. This is the default for anything the product describes with
 *           the word "your".
 *   'org'   the item is the workspace's, and every member sees the same one. A
 *           lab has one glossary, a course has one schedule.
 *
 * Getting this wrong in the 'user' direction hides data from people who should
 * see it, which they report. Getting it wrong in the 'org' direction shows
 * people each other's, which they do not, so where a domain was genuinely
 * ambiguous it is 'user' here.
 */

/**
 * `domain -> {owner}`. Adding a feature means adding a line; ./index refuses a
 * domain that is not in this table, so a typo cannot quietly create a
 * thirteenth-and-a-half store nobody scopes.
 */
const DOMAINS = Object.freeze({
  // ── One person's, within one workspace ──────────────────────────────────
  // Yours: the pages you saved.
  bookmarks: {owner: 'user'},
  // Yours: study state. Both of these were already keyed by user id inside
  // their JSON file, which is the shape this makes structural.
  flashcards: {owner: 'user'},
  streaks: {owner: 'user'},
  // Yours: what you mean to get done.
  tasks: {owner: 'user'},
  // Yours: what you mean to read.
  'reading-lists': {owner: 'user'},
  // Yours: what you thought about a page. The product calls these personal
  // reading notes, as distinct from comments, which are addressed to others.
  notes: {owner: 'user'},
  // Yours: the ones jotted without picking a page first, and how you like the
  // app set up. Neither reached ctx through a named constant, which is how they
  // went unlisted here at first: both are built inline from dataFileSegs().
  quicknotes: {owner: 'user'},

  // ── The workspace's, shared by every member ─────────────────────────────
  // The lab's vocabulary. One definition of a term, or it is not a glossary.
  glossary: {owner: 'org'},
  // The workspace's calendar: a reading group meets once, not once per member.
  schedule: {owner: 'org'},
  // Collaborative by definition.
  whiteboards: {owner: 'org'},
  // Derived from the workspace's content, and about it rather than about any
  // one reader: page views, and snapshots of the tree.
  analytics: {owner: 'org'},
  snapshots: {owner: 'org'},
  // Reusable AI teammates. Their instructions are shared with the workspace so
  // an agent has the same identity for everyone who can talk to it.
  agents: {owner: 'org'},
});

/** Every registered domain name. */
const DOMAIN_NAMES = Object.freeze(Object.keys(DOMAINS));

/** Whether `domain` is one this store knows how to scope. */
function isDomain(domain) {
  return Object.prototype.hasOwnProperty.call(DOMAINS, domain)
    || (typeof domain === 'string' && domain.startsWith('plugin:'));
}

/**
 * Whether items in `domain` belong to a person rather than to the workspace.
 * Throws on an unregistered domain: see the note on DOMAINS.
 */
function isPerUser(domain) {
  if (!isDomain(domain)) {
    throw new Error(`Unknown store domain: ${domain}. Add it to server/store/domains.js.`);
  }
  // Plugin collections are collaborative workspace data. A plugin never gets
  // to choose an owner column or organization id; the host binds both and
  // keeps plugin data under a namespace derived from the plugin directory.
  if (domain.startsWith('plugin:')) return false;
  return DOMAINS[domain].owner === 'user';
}

module.exports = {DOMAINS, DOMAIN_NAMES, isDomain, isPerUser};
