import React, {useEffect, useRef, useState} from 'react';
import {useColorMode} from '@docusaurus/theme-common';
import API_BASE, {apiFetch} from '@site/src/utils/api';
import {createBridgeHost} from './host';
import styles from './styles.module.css';

/**
 * A plugin's own page, from its ui/ folder, in a sandboxed frame: scripts,
 * forms and links that open in a new tab, but no same-origin access, so the
 * page has an opaque origin and none of Mochi's session, cookies or network. It reaches NanoAgent only through
 * the `nanoagent.ui/v1` bridge this component hosts (./host.js).
 */
export default function PluginFrame({app, workspace}) {
  const frame = useRef(null);
  const host = useRef(null);
  const {colorMode} = useColorMode();
  // Addressed by the install it runs from, so a new version is a new page, on
  // the member's computer that opened it (`app.computer`).
  const src = `${API_BASE}/api/apps/${app.sha256}/ui/${app.computer}/${encodeURIComponent(app.uiVersion)}/index.html`;
  const [page, setPage] = useState({src: null, error: null});

  // A frame shows whatever comes back, an error included, and cannot tell this
  // page what it was. So the page is also fetched here, to show a plugin
  // without a working UI as the error it is. The frame loads at the same time,
  // hidden until this check passes, so opening a plugin waits on neither.
  useEffect(() => {
    let cancelled = false;
    fetch(src).then(
      async response => {
        if (cancelled) return;
        if (response.ok) return setPage({src, error: null});
        const data = await response.json().catch(() => ({}));
        if (!cancelled) setPage({src, error: data.error || `Could not load ${app.name}'s page (${response.status})`});
      },
      () => !cancelled && setPage({src, error: 'Could not reach the API server'}),
    );
    return () => { cancelled = true; };
  }, [src, app.name]);

  // The host listens before the frame loads: the page asks to `describe` once.
  useEffect(() => {
    const bridge = createBridgeHost({
      frameWindow: () => frame.current?.contentWindow ?? null,
      plugin: app,
      workspaceId: workspace.id,
      theme: colorMode,
      request: (path, init) => apiFetch(`${API_BASE}${path}`, init),
    });
    host.current = bridge;
    window.addEventListener('message', bridge.onMessage);
    return () => {
      window.removeEventListener('message', bridge.onMessage);
      bridge.close();
      host.current = null;
    };
    // The theme reaches a running host through setTheme below, not a new host.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app, workspace.id]);

  useEffect(() => {
    host.current?.setTheme(colorMode);
  }, [colorMode]);

  const checked = page.src === src;
  if (checked && page.error) return <div className={styles.error}>{page.error}</div>;
  return (
    <>
      {!checked && <p className={styles.muted}>Loading {app.name}…</p>}
      <iframe
        ref={frame}
        className={styles.frame}
        title={app.name}
        sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"
        src={src}
        hidden={!checked}
        onLoad={() => host.current?.setTheme(colorMode)}
      />
    </>
  );
}
