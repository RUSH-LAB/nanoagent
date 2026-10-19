import React, {Activity} from 'react';
import clsx from 'clsx';
import ErrorBoundary from '@docusaurus/ErrorBoundary';
import {SkipToContentFallbackId, ThemeClassNames} from '@docusaurus/theme-common';
// The router Docusaurus itself runs on, for a Route that gives a hidden section its own address.
import {Route} from 'react-router';
import ErrorPageContent from '@theme/ErrorPageContent';
import layoutStyles from '@site/src/theme/Layout/styles.module.css';
import SECTIONS from './registry';
import {sectionHrefs} from './context';

/** Where `section` lives in the workspace at `base` (/w/<slug>): Home at `base` itself. */
export const sectionPath = (base, section) => (section.path ? `${base}/${section.path}` : base);

/**
 * The workspace's sections as VS Code keeps its views: all of them mounted
 * while the member is in the workspace (./index.js), whatever page is open,
 * the open one shown and the rest hidden, most by React's <Activity>,
 * which keeps a hidden section's state and DOM but stops its effects, so
 * nothing hidden listens for keys, observes or fetches, and choosing one on
 * the activity bar shows it as it was left. Those not yet opened are rendered
 * hidden ahead of time, at low priority. One that keeps running while hidden
 * (`running`) is hidden by CSS alone: Plugins, whose plugin page talks to
 * NanoAgent through a bridge its effects hold (components/PluginFrame), and
 * goes on doing so while another section or page is open, as VS Code keeps a
 * hidden webview running. Each section reads the address it was last open at,
 * never another's, and the activity bar returns to it (sectionHrefs).
 *
 * `shown` is the open section and its address, `{section, location}`, as its
 * route last drew it (./SectionPage.js), or null while another page is open,
 * when the sections are not laid out. It is the route's and not the address
 * bar's, which runs ahead of it while a page's code loads.
 */
export default function Sections({base, shown}) {
  const open = shown?.section ?? null;
  // Where each section was last open; each starts at its own path.
  const seen = React.useRef(null);
  seen.current ??= new Map(SECTIONS.map(section => [section.id, {pathname: sectionPath(base, section), search: '', hash: ''}]));
  if (shown) seen.current.set(shown.section.id, shown.location);

  React.useLayoutEffect(() => {
    if (!shown) return;
    const {section, location} = shown;
    sectionHrefs.set(sectionPath(base, section), `${location.pathname}${location.search}${location.hash}`);
  }, [base, shown]);

  // Laid out as a page's Layout lays out its main (theme/Layout).
  return (
    <div
      id={open ? SkipToContentFallbackId : undefined}
      className={clsx(ThemeClassNames.layout.main.container, ThemeClassNames.wrapper.main, layoutStyles.mainWrapper, layoutStyles.shellWrapper)}
      style={open ? undefined : {display: 'none'}}
    >
      {SECTIONS.map(section => {
        const {id, Section, running} = section;
        const shown = id === open?.id;
        const content = (
          <ErrorBoundary fallback={params => <ErrorPageContent {...params} />}>
            <Route location={seen.current.get(id)} render={() => <Section />} />
          </ErrorBoundary>
        );
        if (running) {
          // `contents` leaves the page laid out as if the wrapper were not there.
          return <div key={id} style={{display: shown ? 'contents' : 'none'}}>{content}</div>;
        }
        return <Activity key={id} mode={shown ? 'visible' : 'hidden'}>{content}</Activity>;
      })}
    </div>
  );
}
