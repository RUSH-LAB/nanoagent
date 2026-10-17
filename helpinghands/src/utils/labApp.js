import {useEffect, useState} from 'react';
import API_BASE, {apiRequest} from '@site/src/utils/api';

// How often the connect link is asked for again: its token lasts an hour.
const LINK_MS = 30 * 60_000;

// The RUSH Lab app for each kind of Mac (server/routes/lab.js).
export const DOWNLOADS = {
  appleSilicon: `${API_BASE}/api/lab/bundles/aarch64-apple-darwin`,
  intel: `${API_BASE}/api/lab/bundles/x86_64-apple-darwin`,
};

export const INSTALL_HINT = 'Open the download and drag RUSH Lab into Applications, then open it there. The first time, macOS blocks it: open System Settings, Privacy & Security, and click Open Anyway.';

/** The command that installs RUSH Lab on a Mac from this site and opens it (server/lab-install.js). */
export const installCommand = () => `curl -fsSL ${window.location.origin}/install.sh | sh`;
export const CONNECT_HINT = 'Once RUSH Lab is open, this hands it your account. The link is yours: keep it to yourself.';

/** Whether this page is in the RUSH Lab app's own window, which says so (desktop/src-tauri/src/main.rs). */
export const inLabApp = () => typeof window !== 'undefined' && window.__RUSH_LAB_APP__ === true;

/** Whether the app signs its window in itself (macOS), rather than the page signing in as on the site (Windows). */
export const labAppSignsIn = () => typeof window !== 'undefined' && window.__RUSH_LAB_SIGNS_IN__ === true;

/**
 * The link that connects the RUSH Lab app on this computer to the member's account
 * (rushlab://connect, server/routes/lab.js): {link, error}.
 */
export function useConnectLink() {
  const [link, setLink] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    const load = () => apiRequest('/api/lab/connect')
      .then(value => { setLink(value.link); setError(null); })
      .catch(err => setError(err.message));
    load();
    const timer = setInterval(load, LINK_MS);
    return () => clearInterval(timer);
  }, []);
  return {link, error};
}
