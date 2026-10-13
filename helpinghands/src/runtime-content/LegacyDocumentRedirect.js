import React from 'react';
import {Redirect, useLocation} from '@docusaurus/router';
import Layout from '@theme/Layout';
import {useAccount} from '@site/src/utils/account';

/** Resolve old document links using the default workspace for navigation only. */
export default function LegacyDocumentRedirect() {
  const location = useLocation();
  const {workspaces, defaultWorkspaceId} = useAccount();
  const workspace = workspaces.find(item => item.id === defaultWorkspaceId) ?? workspaces[0];
  if (workspace) {
    const suffix = location.pathname.replace(/^\/documents/, '');
    return <Redirect to={`/w/${encodeURIComponent(workspace.slug)}/documents${suffix}${location.search}${location.hash}`} />;
  }

  return (
    <Layout title="Documents">
      <main className="container margin-vert--lg">
        <p>Create or join a workspace before opening documents.</p>
      </main>
    </Layout>
  );
}
