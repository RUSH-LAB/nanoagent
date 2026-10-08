import {clientPlatform} from '../platform/client.js';

// Copies heading anchor URLs to clipboard on click
if (typeof document !== 'undefined') {
  document.addEventListener('click', (e) => {
    const link = e.target.closest('.hash-link');
    if (!link) return;

    e.preventDefault();
    const url = clientPlatform.location.origin() +
      clientPlatform.location.pathname() +
      link.getAttribute('href');

    clientPlatform.clipboard.writeText(url).then(() => {
      // Show brief "Copied!" feedback
      const tip = document.createElement('span');
      tip.textContent = 'Copied!';
      tip.style.cssText =
        'position:absolute;top:-1.6em;left:50%;transform:translateX(-50%);' +
        'font-size:0.7rem;background:#333;color:#fff;padding:2px 8px;' +
        'border-radius:4px;white-space:nowrap;pointer-events:none;z-index:10;';
      link.style.position = 'relative';
      link.appendChild(tip);
      setTimeout(() => tip.remove(), 1500);
    });
  });
}
