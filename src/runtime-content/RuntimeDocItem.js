import React from 'react';
import {DocsVersionProvider} from '@docusaurus/plugin-content-docs/client';
import DocItem from '@theme/DocItem';
import SafeDocument from './SafeDocument';

function routeFor(workspaceSlug, path) {
  const route = path.replace(/\.(md|mdx)$/i, '').replace(/\/index$/i, '');
  return `/w/${encodeURIComponent(workspaceSlug)}/documents/${route}`;
}

function hasTopLevelTitle(tree) {
  return Boolean((tree?.children || []).some(node => node.type === 'heading' && node.depth === 1));
}

export default function RuntimeDocItem({
  document, tree, toc, workspaceId, workspaceSlug, previous, next,
}) {
  const frontmatter = document.frontmatter || {};
  const tags = (frontmatter.tags || []).map(label => ({label, permalink: '#'}));
  const metadata = {
    id: document.path,
    version: 'current',
    title: document.title,
    description: frontmatter.description || '',
    source: document.path,
    sourceDirName: document.path.includes('/') ? document.path.slice(0, document.path.lastIndexOf('/')) : '.',
    slug: document.path,
    permalink: routeFor(workspaceSlug, document.path),
    draft: Boolean(frontmatter.draft),
    unlisted: false,
    sidebarPosition: frontmatter.sidebarPosition,
    tags,
    frontMatter: {
      ...frontmatter,
      sidebar_position: frontmatter.sidebarPosition,
      hide_breadcrumbs: true,
      hide_table_of_contents: false,
      toc_min_heading_level: 2,
      toc_max_heading_level: 3,
    },
    ...(previous ? {previous: {title: previous.title, permalink: routeFor(workspaceSlug, previous.path)}} : {}),
    ...(next ? {next: {title: next.title, permalink: routeFor(workspaceSlug, next.path)}} : {}),
  };
  function RuntimeDocContent() {
    return (
      <SafeDocument
        tree={tree}
        workspaceId={workspaceId}
        workspaceSlug={workspaceSlug}
        documentPath={document.path}
      />
    );
  }
  Object.assign(RuntimeDocContent, {
    metadata,
    frontMatter: metadata.frontMatter,
    assets: {},
    contentTitle: hasTopLevelTitle(tree) ? document.title : undefined,
    toc,
  });
  const version = {
    name: 'current',
    label: 'Current',
    path: '',
    banner: null,
    badge: false,
    className: 'docs-version-current',
    isLast: true,
    noIndex: false,
  };

  return (
    <DocsVersionProvider version={version}>
      <DocItem content={RuntimeDocContent} />
    </DocsVersionProvider>
  );
}
