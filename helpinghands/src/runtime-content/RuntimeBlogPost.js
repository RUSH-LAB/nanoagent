import React from 'react';
import {BlogPostProvider} from '@docusaurus/plugin-content-blog/client';
import BlogPostItem from '@theme/BlogPostItem';
import BlogPostPaginator from '@theme/BlogPostPaginator';
import SafeDocument from './SafeDocument';
import DocumentEditAction from './DocumentEditAction';

function permalink(workspaceSlug, path) {
  const route = path.replace(/\.(md|mdx)$/i, '').replace(/\/index$/i, '');
  return `/w/${encodeURIComponent(workspaceSlug)}/documents/${route}`;
}

function tagMetadata(tags, workspaceSlug, collectionPath) {
  return (tags || []).map(label => ({
    label,
    permalink: `/w/${encodeURIComponent(workspaceSlug)}/documents/${collectionPath}?tag=${encodeURIComponent(label)}`,
  }));
}

// The server resolves a post's GitHub usernames to accounts (routes/content.js).
function authorMetadata(authors) {
  return (authors || []).map(author => (author.name ? {
    key: author.login,
    name: author.name,
    title: author.bio,
    url: `https://github.com/${encodeURIComponent(author.login)}`,
    imageURL: author.image,
  } : {key: author.login, name: `Unknown author: no Mochi account has the GitHub username ${author.login}`}));
}

function contentFor({document, tree, workspaceSlug, collectionPath, previous, next, showReadingTime, authors}) {
  const frontmatter = document.frontmatter || {};
  const postPermalink = permalink(workspaceSlug, document.path);
  return {
    metadata: {
      source: document.path,
      title: document.title,
      date: frontmatter.date || document.createdAt || document.updatedAt || new Date(0).toISOString(),
      permalink: postPermalink,
      description: frontmatter.description || document.description || '',
      ...(showReadingTime ? {readingTime: document.readingTime} : {}),
      hasTruncateMarker: Boolean(document.hasTruncateMarker),
      authors: authorMetadata(authors),
      tags: tagMetadata(frontmatter.tags, workspaceSlug, collectionPath),
      unlisted: false,
      frontMatter: {
        ...frontmatter,
        hide_table_of_contents: false,
        toc_min_heading_level: 2,
        toc_max_heading_level: 3,
      },
      ...(previous ? {prevItem: {title: previous.title, permalink: permalink(workspaceSlug, previous.path)}} : {}),
      ...(next ? {nextItem: {title: next.title, permalink: permalink(workspaceSlug, next.path)}} : {}),
    },
    frontMatter: {
      ...frontmatter,
      hide_table_of_contents: false,
      toc_min_heading_level: 2,
      toc_max_heading_level: 3,
    },
    assets: {authorsImageUrls: []},
    toc: [],
    tree,
  };
}

export function createRuntimeBlogContent({
  document, tree, toc = [], workspaceId, workspaceSlug, collectionPath,
  previous = null, next = null, showReadingTime = false, authors = [], onEdit = null,
}) {
  const content = contentFor({document, tree, workspaceSlug, collectionPath, previous, next, showReadingTime, authors});
  function RuntimeBlogContent() {
    return (
      <>
        <DocumentEditAction onEdit={onEdit} />
        <SafeDocument
          tree={tree}
          workspaceId={workspaceId}
          workspaceSlug={workspaceSlug}
          documentPath={document.path}
        />
      </>
    );
  }
  Object.assign(RuntimeBlogContent, content, {toc});
  return RuntimeBlogContent;
}

export default function RuntimeBlogPost({
  document, tree, workspaceId, workspaceSlug, collectionPath,
  isBlogPostPage = false, previous = null, next = null, showReadingTime = false, authors = [], onEdit = null,
}) {
  const Content = createRuntimeBlogContent({
    document, tree, workspaceId, workspaceSlug, collectionPath,
    previous, next, showReadingTime, authors, onEdit,
  });
  return (
    <BlogPostProvider content={Content} isBlogPostPage={isBlogPostPage}>
      <BlogPostItem>
        <Content />
      </BlogPostItem>
      {isBlogPostPage && (previous || next) ? (
        <BlogPostPaginator
          prevItem={previous ? {title: previous.title, permalink: permalink(workspaceSlug, previous.path)} : undefined}
          nextItem={next ? {title: next.title, permalink: permalink(workspaceSlug, next.path)} : undefined}
        />
      ) : null}
    </BlogPostProvider>
  );
}
