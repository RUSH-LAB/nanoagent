import React from 'react';
import BrowserOnly from '@docusaurus/BrowserOnly';
import {useLocation} from '@docusaurus/router';
import {workspaceSlugFromPath} from '@site/src/utils/workspaces';
import Shell from './Shell';

function WorkspaceCommandBar() {
  const location = useLocation();
  const workspaceKey = workspaceSlugFromPath(location.pathname) || 'unscoped';

  // Root deliberately survives Docusaurus navigation. A workspace boundary is
  // different: every Agent, channel, person, poll, and in-flight request is
  // scoped to it, so remount the runtime immediately when that URL segment
  // changes instead of waiting for old polling effects to catch up.
  return <Shell key={workspaceKey} workspaceKey={workspaceKey} />;
}

/**
 * The mount point of the CLI, and nothing else.
 *
 * Everything the window does needs client capabilities: storage for its height and
 * its panes, the root element for the footprint it publishes, a clock for the
 * chat poll. None of that exists during the static build, so the whole shell
 * sits behind BrowserOnly and this file stays the one place that decides it.
 *
 * Keeping the wrapper here rather than at the call site is what lets the CLI be
 * imported at the top level of a layout or a provider without any of them
 * having to know that it is client only.
 */
export default function CommandBar() {
  return <BrowserOnly>{() => <WorkspaceCommandBar />}</BrowserOnly>;
}
