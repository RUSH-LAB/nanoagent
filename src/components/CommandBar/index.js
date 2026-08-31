import React from 'react';
import BrowserOnly from '@docusaurus/BrowserOnly';
import Shell from './Shell';

/**
 * The mount point of the CLI, and nothing else.
 *
 * Everything the window does needs a browser: localStorage for its height and
 * its panes, the root element for the footprint it publishes, a clock for the
 * chat poll. None of that exists during the static build, so the whole shell
 * sits behind BrowserOnly and this file stays the one place that decides it.
 *
 * Keeping the wrapper here rather than at the call site is what lets the CLI be
 * imported at the top level of a layout or a provider without any of them
 * having to know that it is client only.
 */
export default function CommandBar() {
  return <BrowserOnly>{() => <Shell />}</BrowserOnly>;
}
