import React, {useEffect} from 'react';
import clsx from 'clsx';
import BrowserOnly from '@docusaurus/BrowserOnly';
import Layout from '@theme/Layout';
import useWorkspaceSite from '@site/src/hooks/useWorkspaceSite';
import {navigateClient} from '@site/src/utils/workspaces';
import Link from '@docusaurus/Link';
import {workspaceDocumentHref} from '@site/src/utils/documentUrls';
import styles from './workspaceHome.module.css';

/**
 * A workspace's home, /w/:slug, where the workspace name in the navbar goes.
 * For now it is the workspace's name and nothing else, laid out as a Markdown
 * page whose first heading is the page's banner, so that the workspace's own
 * home document can take its place without a new design.
 *
 * An owner who chose one page as the workspace's home (site.homeLayout
 * 'document') is sent to that page instead. A workspace that takes
 * submissions (site.submissions) links to its Submit page under the name,
 * which shows what a submitter agrees to.
 */
function WorkspaceHome() {
  const {slug, workspace, site, loading, error} = useWorkspaceSite();
  const pinned = site?.site?.homeLayout === 'document' && site.site.homeDocument;

  useEffect(() => {
    if (!loading && !error && slug && pinned) {
      navigateClient(workspaceDocumentHref(site.site.homeDocument, slug, ''), {replace: true});
    }
  }, [error, loading, pinned, site, slug]);

  if (error) return <p className={styles.message}>{error}</p>;
  if (!workspace || !site || pinned) return null;
  return (
    <article className={clsx('markdown', styles.page)}>
      <h1>{site.site?.title || workspace.name}</h1>
      {site.submissions && (
        <div className={styles.submissions}>
          <Link className="button button--primary button--lg" to={`/w/${encodeURIComponent(slug)}/submit`}>
            Submit your artifact
          </Link>
        </div>
      )}
    </article>
  );
}

export default function WorkspaceHomeRoute() {
  return (
    <Layout title="Home">
      <main className={styles.home}>
        <BrowserOnly fallback={null}>{() => <WorkspaceHome />}</BrowserOnly>
      </main>
    </Layout>
  );
}
