/**
 * Install the worker that keeps the application on this computer (src/static/sw.js).
 * It prefers the network for anything that can change, so it is safe under the
 * development server as well as in a production build.
 */
if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
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
