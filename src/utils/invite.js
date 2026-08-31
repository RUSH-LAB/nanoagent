/**
 * An invitation link, and getting it onto the clipboard.
 *
 * Shared by the two places that hand one out: the people directory, which shows
 * the link, and the CLI rail, which is too narrow to show it and copies it
 * instead. Both need the same URL, and a second spelling of it would be a link
 * that works from one page and not the other.
 */

/** Where an invitation is redeemed. Absolute, because it is meant to be pasted. */
export function linkFor(invitationId) {
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  return `${origin}/join?i=${encodeURIComponent(invitationId)}`;
}

/**
 * The invitation id inside whatever somebody pasted, or null.
 *
 * The other end of linkFor, and deliberately forgiving about what it is given.
 * An invitation arrives by whatever channel the inviter had to hand, so the text
 * that reaches the box may be the whole URL, the URL with a trailing space, the
 * path alone once a chat client has stripped the origin, or just the id because
 * the sender read it out. All four name the same invitation, and refusing three
 * of them would only be pedantry about copy and paste.
 */
export function idFromLink(text) {
  // The fragment goes first. URLSearchParams is given a query string, not a
  // URL, so it does not know that a trailing #anchor is not part of the last
  // value, and would have handed back an id with the anchor stuck to it.
  const trimmed = String(text ?? '').trim().split('#')[0];
  if (!trimmed) return null;
  const query = trimmed.indexOf('?');
  if (query === -1) {
    // No query string, so this is either a bare id or something that is not an
    // invitation at all. Ids have no spaces or slashes in them.
    return /^[^\s/?]+$/.test(trimmed) ? trimmed : null;
  }
  return new URLSearchParams(trimmed.slice(query + 1)).get('i');
}

/**
 * Copy the link, reporting whether it worked. A browser can refuse clipboard
 * access, and a caller that assumed otherwise would tell somebody they had a
 * link they do not have.
 */
export async function copyLink(invitationId) {
  const link = linkFor(invitationId);
  try {
    await navigator.clipboard.writeText(link);
    return {copied: true, link};
  } catch {
    return {copied: false, link};
  }
}
