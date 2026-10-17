import {useEffect, useState} from 'react';
import API_BASE, {apiRequest} from '@site/src/utils/api';

// How often the connect link is asked for again: its token lasts an hour.
const LINK_MS = 30 * 60_000;

// The RUSH Lab app for each kind of Mac (server/routes/lab.js).
export const DOWNLOADS = {
  appleSilicon: `${API_BASE}/api/lab/bundles/aarch64-apple-darwin`,
  intel: `${API_BASE}/api/lab/bundles/x86_64-apple-darwin`,
};

export const INSTALL_HINT = 'Drag RUSH Lab into Applications and open it. The first time, macOS blocks it: click Open Anyway in System Settings, Privacy & Security.';

// What each kind of Mac is called (DOWNLOADS).
export const CHIPS = {appleSilicon: 'Apple silicon', intel: 'Intel'};

/**
 * Which kind of Mac this browser is on, as a key of DOWNLOADS, or null when it does not say.
 * Chromium names its architecture; Safari and Firefox do not, so the GPU WebGL names tells
 * instead, when it is named: an Apple M chip is Apple silicon, and an Intel, AMD or NVIDIA GPU
 * an Intel Mac. Safari calls every GPU "Apple GPU", which says neither.
 */
async function macChip() {
  const architecture = await navigator.userAgentData?.getHighEntropyValues?.(['architecture'])
    .then(values => values.architecture, () => null);
  if (architecture === 'arm') return 'appleSilicon';
  if (architecture === 'x86') return 'intel';
  const gl = document.createElement('canvas').getContext('webgl');
  if (!gl) return null;
  const debug = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = String(gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
  if (/Apple M\d/.test(renderer)) return 'appleSilicon';
  if (/Intel|AMD|Radeon|NVIDIA/i.test(renderer)) return 'intel';
  return null;
}

/** The kind of Mac this browser is on (macChip): undefined while it is asked, then a key of DOWNLOADS or null. */
export function useMacChip() {
  const [chip, setChip] = useState(undefined);
  useEffect(() => {
    let cancelled = false;
    macChip().then(value => { if (!cancelled) setChip(value); });
    return () => { cancelled = true; };
  }, []);
  return chip;
}

/** The command that installs RUSH Lab on a Mac from this site and opens it (server/lab-install.js). */
export const installCommand = () => `curl -fsSL ${window.location.origin}/install.sh | sh`;
export const CONNECT_HINT = 'Once RUSH Lab is open, this hands it your account. The link is yours: keep it to yourself.';

/**
 * Which system this browser is on, by what it says of itself: 'mac', 'windows' or null for
 * another (an iPhone or iPad says so, though an iPad may call itself a Mac).
 */
export function visitorSystem() {
  const said = navigator.userAgentData?.platform || navigator.userAgent;
  if (/iPhone|iPad|iPod|Android/i.test(said)) return null;
  if (/Mac/i.test(said)) return 'mac';
  if (/Win/i.test(said)) return 'windows';
  return null;
}

/** Whether this page is in the RUSH Lab app's own window, which says so (desktop/src-tauri/src/main.rs). */
export const inLabApp = () => typeof window !== 'undefined' && window.__RUSH_LAB_APP__ === true;

/** Whether the app signs its window in itself (macOS), rather than the page signing in as on the site (Windows). */
export const labAppSignsIn = () => typeof window !== 'undefined' && window.__RUSH_LAB_SIGNS_IN__ === true;

/**
 * What the RUSH Lab app is doing to set this computer up, as its window is told: {stage, error},
 * `stage` one of install, python, nanoagent and connect, in that order, `error` why it stopped
 * there, or null. The app keeps the latest in window.__RUSH_LAB_SETUP__ and sends each change
 * as the window event rushlab:setup; null until it has said.
 */
export function useLabSetup() {
  const [setup, setSetup] = useState(() => (typeof window === 'undefined' ? null : window.__RUSH_LAB_SETUP__ ?? null));
  useEffect(() => {
    const hear = event => setSetup(event.detail);
    window.addEventListener('rushlab:setup', hear);
    setSetup(window.__RUSH_LAB_SETUP__ ?? null);
    return () => window.removeEventListener('rushlab:setup', hear);
  }, []);
  return setup;
}

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
