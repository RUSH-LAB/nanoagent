/**
 * Client capabilities that may differ between a browser tab and a future
 * desktop shell.
 *
 * Components use this stable facade instead of importing a Tauri/Electron API
 * or reaching directly into browser persistence and navigation. The desktop
 * bootstrap can install an adapter before React mounts; the ordinary web build
 * uses the safe browser adapter below.
 *
 * This is an integration boundary, not a security boundary. Native adapters
 * must still validate filesystem paths and commands on the privileged side.
 */

function browserScope() {
  return typeof window === 'undefined' ? null : window;
}

function createWebAdapter() {
  return {
    kind: 'web',
    capabilities: Object.freeze({
      filesystem: false,
      terminal: false,
      nativeNotifications: typeof Notification !== 'undefined',
    }),
    runtimeConfig() {
      return browserScope()?.__MOCHI_RUNTIME_CONFIG__ ?? {};
    },
    location: {
      href: () => browserScope()?.location?.href ?? '',
      origin: () => browserScope()?.location?.origin ?? '',
      pathname: () => browserScope()?.location?.pathname ?? '',
      search: () => browserScope()?.location?.search ?? '',
      hash: () => browserScope()?.location?.hash ?? '',
      assign: target => browserScope()?.location?.assign(target),
      reload: () => browserScope()?.location?.reload(),
    },
    storage: {
      getItem: key => browserScope()?.localStorage?.getItem(key) ?? null,
      setItem: (key, value) => browserScope()?.localStorage?.setItem(key, value),
      removeItem: key => browserScope()?.localStorage?.removeItem(key),
      keys: () => {
        const storage = browserScope()?.localStorage;
        if (!storage) return [];
        return Array.from({length: storage.length}, (_, index) => storage.key(index))
          .filter(Boolean);
      },
    },
    clipboard: {
      writeText(text) {
        const clipboard = browserScope()?.navigator?.clipboard;
        if (!clipboard?.writeText) return Promise.reject(new Error('Clipboard access is unavailable'));
        return clipboard.writeText(text);
      },
    },
    dialogs: {
      confirm: message => browserScope()?.confirm(message) ?? false,
      prompt: (message, defaultValue) => {
        const scope = browserScope();
        if (!scope) return null;
        return (defaultValue === undefined ? scope.prompt(message) : scope.prompt(message, defaultValue)) ?? null;
      },
    },
    notifications: {
      permission: () => typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
      requestPermission: () => typeof Notification === 'undefined'
        ? Promise.resolve('unsupported')
        : Notification.requestPermission(),
      show: (title, options) => typeof Notification === 'undefined' ? null : new Notification(title, options),
    },
  };
}

const webAdapter = createWebAdapter();
let installedAdapter = null;

function activeAdapter() {
  return installedAdapter ?? webAdapter;
}

function capability(group, method, args, fallback) {
  try {
    const owner = activeAdapter()?.[group];
    const fn = owner?.[method];
    return typeof fn === 'function' ? fn.apply(owner, args) : fallback;
  } catch {
    return fallback;
  }
}

/** Install the adapter supplied by a desktop bootstrap. */
export function installClientPlatform(adapter) {
  if (!adapter || typeof adapter !== 'object') throw new TypeError('A client platform adapter is required');
  installedAdapter = adapter;
}

/** Restore the web adapter. Primarily useful for isolated tests. */
export function resetClientPlatform() {
  installedAdapter = null;
}

export const clientPlatform = Object.freeze({
  get kind() {
    return activeAdapter().kind ?? 'unknown';
  },
  get capabilities() {
    return activeAdapter().capabilities ?? {};
  },
  runtimeConfig() {
    try {
      const value = activeAdapter().runtimeConfig?.();
      return value && typeof value === 'object' ? value : {};
    } catch {
      return {};
    }
  },
  location: Object.freeze({
    href: () => capability('location', 'href', [], ''),
    origin: () => capability('location', 'origin', [], ''),
    pathname: () => capability('location', 'pathname', [], ''),
    search: () => capability('location', 'search', [], ''),
    hash: () => capability('location', 'hash', [], ''),
    assign: target => capability('location', 'assign', [target]),
    reload: () => capability('location', 'reload', []),
  }),
  storage: Object.freeze({
    getItem: key => capability('storage', 'getItem', [key], null),
    setItem: (key, value) => capability('storage', 'setItem', [key, value]),
    removeItem: key => capability('storage', 'removeItem', [key]),
    keys: () => capability('storage', 'keys', [], []),
    removeMatching(predicate) {
      for (const key of this.keys()) {
        if (predicate(key)) this.removeItem(key);
      }
    },
  }),
  clipboard: Object.freeze({
    writeText(text) {
      const clipboard = activeAdapter()?.clipboard;
      const fn = clipboard?.writeText;
      if (typeof fn !== 'function') return Promise.reject(new Error('Clipboard access is unavailable'));
      try {
        return Promise.resolve(fn.call(clipboard, text));
      } catch (error) {
        return Promise.reject(error);
      }
    },
  }),
  dialogs: Object.freeze({
    confirm: message => capability('dialogs', 'confirm', [message], false),
    prompt: (message, defaultValue) => capability('dialogs', 'prompt', [message, defaultValue], null),
  }),
  notifications: Object.freeze({
    permission: () => capability('notifications', 'permission', [], 'unsupported'),
    requestPermission: () => Promise.resolve(
      capability('notifications', 'requestPermission', [], 'unsupported'),
    ),
    show: (title, options) => capability('notifications', 'show', [title, options], null),
  }),
});

export default clientPlatform;
