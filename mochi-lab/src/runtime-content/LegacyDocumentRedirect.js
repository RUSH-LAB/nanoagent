import React, {useEffect, useState} from 'react';
import {useHistory, useLocation} from '@docusaurus/router';
import Layout from '@theme/Layout';
import {loadWorkspaces} from '@site/src/utils/workspaces';

/** Resolve old document links using the default workspace for navigation only. */
export default function LegacyDocumentRedirect() {
  const location = useLocation();
  const history = useHistory();
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    loadWorkspaces()
      .then(data => {
        if (cancelled) return;
        const workspace = data.workspaces.find(item => item.id === data.defaultWorkspaceId)
          ?? data.workspaces[0];
        if (!workspace) throw new Error('Create or join a workspace before opening documents.');
        const suffix = location.pathname.replace(/^\/documents/, '');
        history.replace(`/w/${encodeURIComponent(workspace.slug)}/documents${suffix}${location.search}${location.hash}`);
      })
      .catch(reason => {
        if (!cancelled) setError(reason.message);
      });
    return () => { cancelled = true; };
  }, [history, location.pathname, location.search, location.hash]);

  return (
    <Layout title="Documents">
      <main className="container margin-vert--lg">
        <p>{error || 'Opening your workspace…'}</p>
      </main>
    </Layout>
  );
}
