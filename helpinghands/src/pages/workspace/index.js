import React from 'react';
import Layout from '@theme/Layout';
import BrowserOnly from '@docusaurus/BrowserOnly';
import ErrorBoundary from '@site/src/components/ErrorBoundary';
import useWorkspaceSite from '@site/src/hooks/useWorkspaceSite';
import styles from './styles.module.css';

/**
 * The caller's own agent workspace: every file the apps saved for them, and
 * any they make themselves, in a small VS Code (src/components/Workbench).
 */

function WorkspaceContent() {
  const {slug, workspace, error} = useWorkspaceSite();
  if (!slug) return <p className={styles.message}>Open Workspace from a workspace.</p>;
  if (error) return <p className={styles.message}>{error}</p>;
  if (!workspace) return null;
  // Required here, in the browser only: the editor and its languages do not render on the server.
  const Workbench = require('@site/src/components/Workbench').default;
  return <Workbench key={workspace.id} workspace={workspace} />;
}

/** The page's Layout props, here and in the shell (components/Shell/Sections.js). */
export const page = {title: 'Filesystem', description: 'Your files', noFooter: true};

export function WorkspaceSection() {
  return (
    <BrowserOnly fallback={<div className={styles.message}>Loading…</div>}>
      {() => <ErrorBoundary><WorkspaceContent /></ErrorBoundary>}
    </BrowserOnly>
  );
}

export default function WorkspacePage() {
  return (
    <Layout {...page}>
      <WorkspaceSection />
    </Layout>
  );
}
