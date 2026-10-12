import React, {useEffect, useState} from 'react';
import BrowserOnly from '@docusaurus/BrowserOnly';
import Layout from '@theme/Layout';
import useWorkspaceSite from '@site/src/hooks/useWorkspaceSite';
import {navigateClient} from '@site/src/utils/workspaces';
import {workspaceDocumentHref} from '@site/src/utils/documentUrls';

function WorkspaceHome() {
  const {slug, workspace, site, loading, error} = useWorkspaceSite();
  const [navigationError, setNavigationError] = useState(null);

  useEffect(() => {
    if (loading || error || !slug || !workspace || !site) return;
    try {
      const target = site.site?.homeDocument
        ? workspaceDocumentHref(site.site.homeDocument, slug, '')
        : `/w/${encodeURIComponent(slug)}/documents`;
      navigateClient(target, {replace: true});
    } catch (reason) {
      setNavigationError(reason.message);
    }
  }, [error, loading, site, slug, workspace]);

  return error || navigationError
    ? <p>{error || navigationError}</p>
    : <p>Opening workspace…</p>;
}

export default function WorkspaceHomeRoute() {
  return (
    <Layout title="Workspace">
      <main className="container margin-vert--lg">
        <BrowserOnly fallback={<p>Opening workspace…</p>}>
          {() => <WorkspaceHome />}
        </BrowserOnly>
      </main>
    </Layout>
  );
}
