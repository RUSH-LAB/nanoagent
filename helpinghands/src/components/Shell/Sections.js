import React, {Activity} from 'react';
import Layout from '@theme/Layout';
import {useLocation} from '@docusaurus/router';
// The router Docusaurus itself runs on, for a Route that gives a hidden section its own address.
import {Route} from 'react-router';
import {AppsSection, page as appsPage} from '@site/src/pages/apps/index.js';
import {MarketplaceSection, page as marketplacePage} from '@site/src/pages/marketplace/index.js';
import {SettingsSection, page as settingsPage} from '@site/src/pages/settings/index.js';
import {WorkspaceSection, page as workspacePage} from '@site/src/pages/workspace/index.js';
import {sectionHrefs} from './context';

/**
 * The sections the activity bar opens, by the path under /w/<slug>/ each lives at.
 * One that keeps running while hidden (`running`) is hidden by CSS alone: Plugins,
 * whose plugin page talks to NanoAgent through a bridge its effects hold
 * (components/PluginFrame), and goes on doing so while another section is open,
 * as VS Code keeps a hidden webview running.
 */
const SECTIONS = {
  apps: {Section: AppsSection, page: appsPage, running: true},
  marketplace: {Section: MarketplaceSection, page: marketplacePage},
  workspace: {Section: WorkspaceSection, page: workspacePage},
  settings: {Section: SettingsSection, page: settingsPage},
};

/**
 * The workspace's sections as VS Code keeps its views: all of them mounted
 * under one Layout, the open one shown and the rest hidden, most by React's
 * <Activity>, which keeps a hidden section's state and DOM but stops its
 * effects, so nothing hidden listens for keys, observes or fetches, and
 * choosing one on the activity bar shows it as it was left. Those not yet
 * opened are rendered hidden ahead of time, at low priority. Each section
 * reads the address it was last open at, never another section's, and the
 * activity bar returns to it (sectionHrefs).
 */
export default function Sections() {
  const location = useLocation();
  const parts = location.pathname.split('/');
  const base = parts.slice(0, 3).join('/');
  const open = parts[3];
  // Where each section was last open, in this workspace; a workspace entered anew starts each at its own path.
  const seen = React.useRef(null);
  if (seen.current?.base !== base) {
    seen.current = {base, at: new Map(Object.keys(SECTIONS).map(id => [id, {pathname: `${base}/${id}`, search: '', hash: ''}]))};
  }
  seen.current.at.set(open, location);

  React.useLayoutEffect(() => {
    sectionHrefs.set(`${base}/${open}`, `${location.pathname}${location.search}${location.hash}`);
  }, [base, open, location]);

  return (
    <Layout {...SECTIONS[open].page}>
      {[...seen.current.at].map(([id, at]) => {
        const {Section, running} = SECTIONS[id];
        const section = <Route location={at} render={() => <Section />} />;
        if (running) {
          // `contents` leaves the page laid out as if the wrapper were not there.
          return <div key={id} style={{display: id === open ? 'contents' : 'none'}}>{section}</div>;
        }
        return <Activity key={id} mode={id === open ? 'visible' : 'hidden'}>{section}</Activity>;
      })}
    </Layout>
  );
}
