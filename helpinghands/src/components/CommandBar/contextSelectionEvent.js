export const CONTEXT_SELECTION_EVENT = 'mochi:show-context-selection';

/** Let rich editors offer a selection through the global copy-as-context UI. */
export function showContextSelection(detail) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(CONTEXT_SELECTION_EVENT, {detail}));
}

export function hideContextSelection() {
  showContextSelection({dismiss: true});
}
