/**
 * The unread count in the browser tab's title.
 *
 * The CLI is docked to the bottom of the page, so a reader who has scrolled
 * into a document, or switched to another tab entirely, has no way of noticing
 * that someone answered them. The tab title is the one piece of chrome that is
 * visible from outside the page, which is why every chat client claims it.
 *
 * The complication is that the title is not ours. Docusaurus rewrites it on
 * every navigation, and a badge written once would be wiped by the next route
 * change and never come back. Watching the title element and re-applying the
 * prefix is what survives that. Re-applying is idempotent: the desired title is
 * computed from the current one with any previous badge stripped, so our own
 * write produces no second change and the observer cannot loop.
 */
import {useEffect} from 'react';

/* The badge this hook owns, and the only thing it will ever strip. */
const BADGE = /^\(\d+\)\s+/;

/** @param count unread messages across every conversation, or nothing at all. */
export default function useUnreadTitle(count) {
  useEffect(() => {
    const unread = Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0;
    const titleEl = document.querySelector('title');

    const apply = () => {
      const bare = document.title.replace(BADGE, '');
      const wanted = unread ? `(${unread}) ${bare}` : bare;
      if (document.title !== wanted) document.title = wanted;
    };

    apply();
    if (!titleEl) return undefined;

    const observer = new MutationObserver(apply);
    observer.observe(titleEl, {childList: true, characterData: true, subtree: true});
    return () => {
      observer.disconnect();
      document.title = document.title.replace(BADGE, '');
    };
  }, [count]);
}
