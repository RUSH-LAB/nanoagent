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
