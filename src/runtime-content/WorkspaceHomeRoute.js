import React, {useEffect, useState} from 'react';
import BrowserOnly from '@docusaurus/BrowserOnly';
import Layout from '@theme/Layout';
import {useLocation} from '@docusaurus/router';
import API_BASE, {apiFetch} from '@site/src/utils/api';
import {loadWorkspaces, navigateClient, workspaceSlugFromPath} from '@site/src/utils/workspaces';
import {workspaceDocumentHref} from '@site/src/utils/documentUrls';

function WorkspaceHome() {
  const location = useLocation();
  const slug = workspaceSlugFromPath(location.pathname);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const {workspaces} = await loadWorkspaces();
        const workspace = workspaces.find(item => item.slug === slug);
        if (!workspace) throw new Error('This workspace does not exist, or you are not a member.');
        const response = await apiFetch(`${API_BASE}/api/workspaces/${encodeURIComponent(workspace.id)}/site`);
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || 'Could not load workspace site');
        if (cancelled) return;
        const target = data.site?.site?.homeDocument
          ? workspaceDocumentHref(data.site.site.homeDocument, slug, '')
          : `/w/${encodeURIComponent(slug)}/documents`;
        navigateClient(target, {replace: true});
      } catch (reason) {
        if (!cancelled) setError(reason.message);
      }
    })();
    return () => { cancelled = true; };
  }, [slug]);

  return error ? <p>{error}</p> : <p>Opening workspace…</p>;
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
