/**
 * Toast notification API.
 *
 * Usage:
 *   import { toast } from '@site/src/components/Toast/toast';
 *   toast.success('Saved!');
 *   toast.error('Something went wrong');
 *   toast.warning('Check your input');
 *   toast.info('Tip: you can use keyboard shortcuts');
 */

let nextId = 0;
let toasts = [];
const subscribers = new Set();

function notify() {
  const snapshot = [...toasts];
  subscribers.forEach((cb) => cb(snapshot));
}

function add(type, message, options = {}) {
  const id = ++nextId;
  const duration = options.duration ?? 3000;

  const entry = {id, type, message, duration, action: options.action || null, actionLabel: options.actionLabel || null};
  toasts = [...toasts, entry];
  notify();

  if (duration > 0) {
    setTimeout(() => remove(id), duration);
  }

  return id;
}

function remove(id) {
  toasts = toasts.filter((t) => t.id !== id);
  notify();
}

/**
 * Subscribe to toast state changes.
 * Returns an unsubscribe function.
 */
export function subscribe(callback) {
  subscribers.add(callback);
  return () => subscribers.delete(callback);
}

/** Get current toasts (snapshot). */
export function getToasts() {
  return [...toasts];
}

export const toast = {
  success: (msg, opts) => add('success', msg, opts),
  error: (msg, opts) => add('error', msg, opts),
  warning: (msg, opts) => add('warning', msg, opts),
  info: (msg, opts) => add('info', msg, opts),
  dismiss: (id) => remove(id),
};
