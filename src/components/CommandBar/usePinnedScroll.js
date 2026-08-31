/**
 * A transcript that follows the newest line only while the reader is watching
 * the newest line.
 *
 * The window used to scroll every pane to the bottom whenever anything changed,
 * and a conversation is re-read every three seconds, so scrolling up to reread
 * something lasted until the next poll. Pinning has to be conditional: a reader
 * who has scrolled away has said, by scrolling, that the bottom is not where
 * they want to be, and the only correct thing to do with a new line is leave
 * them alone and let the pane offer them a way back.
 *
 * `keepAnchor` is the same idea from the other end. Prepending older messages
 * grows the box upwards, which moves everything the reader is looking at down
 * by the height of what was added; measuring the box before and after and
 * putting the offset back is what keeps the viewport still.
 */
import {useCallback, useLayoutEffect, useRef, useState} from 'react';

/* Within this much of the end counts as being at the end. A line height of
   slack, so a browser that lands a pixel short of the bottom, or a reader who
   nudges the wheel once, does not unpin the pane. */
const BOTTOM_SLACK = 24;

/**
 * @param deps what a new line looks like from outside: when one of these
 *             changes and the reader is at the bottom, the pane follows. The
 *             array's length must be constant, as for any hook dependency list.
 */
export default function usePinnedScroll(deps) {
  const ref = useRef(null);
  const [atBottom, setAtBottom] = useState(true);
  // The effect below runs before the state has been re-read, so the decision to
  // follow is taken from the ref, not from the rendered flag.
  const atBottomRef = useRef(true);

  const scrollToBottom = useCallback((smooth = false) => {
    const el = ref.current;
    if (!el) return;
    if (typeof el.scrollTo === 'function') {
      el.scrollTo({top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto'});
    } else {
      el.scrollTop = el.scrollHeight;
    }
    atBottomRef.current = true;
    setAtBottom(true);
  }, []);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK;
    atBottomRef.current = bottom;
    // Guarded because a scroll event fires per frame and the flag changes twice
    // a session.
    setAtBottom((prev) => (prev === bottom ? prev : bottom));
  }, []);

  // Before paint, so a followed line never appears at the old offset first.
  useLayoutEffect(() => {
    if (atBottomRef.current) scrollToBottom();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  /**
   * Run something that prepends content, and put the reader back where they
   * were. Awaited across a frame because the messages are only in the box once
   * React has committed them.
   */
  const keepAnchor = useCallback(async (fn) => {
    const before = ref.current?.scrollHeight ?? 0;
    try {
      await fn();
    } finally {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const el = ref.current;
      if (el) el.scrollTop += el.scrollHeight - before;
    }
  }, []);

  return {scrollProps: {ref, onScroll}, atBottom, scrollToBottom, keepAnchor};
}
