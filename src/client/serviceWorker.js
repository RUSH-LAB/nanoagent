/**
 * Install the worker that keeps the application on this computer (src/static/sw.js).
 *
 * Production builds only: the development server rebuilds its files on every
 * change, and a stored copy would hide each edit until the cache was cleared.
 */
if (typeof window !== 'undefined' && process.env.NODE_ENV === 'production' && 'serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      await navigator.serviceWorker.register('/sw.js');
      const registration = await navigator.serviceWorker.ready;
      const urls = performance.getEntriesByType('resource')
        .map(entry => new URL(entry.name))
        .filter(url => url.origin === window.location.origin && !url.pathname.startsWith('/api/'))
        .map(url => url.pathname);
      registration.active?.postMessage({type: 'keep', urls: [window.location.pathname, ...urls]});
    } catch (error) {
      console.error('[offline] The application could not be kept on this computer:', error);
    }
  });
}
