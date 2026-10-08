/**
 * A way for the rest of the site to point the CLI at a conversation.
 *
 * The people directory has a Message button, and the CLI it needs to open is
 * docked to the bottom of the same page but is not its parent, its child, or
 * its sibling in any tree either of them can see. This is the smallest thing
 * that connects them: one function to ask, one to answer.
 *
 * A single listener rather than a list, because there is exactly one CLI. Two
 * of them would both open the conversation, and the second would be a bug in
 * the layout, not something to support here.
 */
let listener = null;

/**
 * Open a conversation in the CLI. Pass a `channelId` for a channel, or a
 * `userId` for the direct message with someone, which the CLI creates if this
 * is the first one. `label` is what to call it until the directory says
 * otherwise. Returns false when no CLI is listening, which is the static build
 * and nothing else.
 */
export function openConversation(target) {
  if (!listener) return false;
  listener(target);
  return true;
}

/** Register the CLI as the thing that answers. Returns an unsubscribe. */
export function onOpenConversation(handler) {
  listener = handler;
  return () => {
    // Only if it is still ours: a remount registers the new handler before the
    // old effect cleans up, and clearing unconditionally would drop it.
    if (listener === handler) listener = null;
  };
}
