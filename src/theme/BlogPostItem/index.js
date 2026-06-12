import React from 'react';
import BlogPostItem from '@theme-original/BlogPostItem';
import {useBlogPost} from '@docusaurus/plugin-content-blog/client';
import {EditablePageWrapper} from '@site/src/components/EditPageButton';
import Comments from '@site/src/components/Comments';

export default function BlogPostItemWrapper(props) {
  const {metadata, isBlogPostPage} = useBlogPost();

  if (!isBlogPostPage) {
    return <BlogPostItem {...props} />;
  }

  const source = metadata.source?.replace('@site/', '');
  const pageId = metadata.permalink;

  return (
    <EditablePageWrapper source={source}>
      <BlogPostItem {...props} />
      <Comments pageId={pageId} />
    </EditablePageWrapper>
  );
}
