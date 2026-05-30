import React from 'react';
import BlogPostItem from '@theme-original/BlogPostItem';
import {useBlogPost} from '@docusaurus/plugin-content-blog/client';
import {EditablePageWrapper} from '@site/src/components/MarkdownEditor';

export default function BlogPostItemWrapper(props) {
  const {metadata, isBlogPostPage} = useBlogPost();

  if (!isBlogPostPage) {
    return <BlogPostItem {...props} />;
  }

  const source = metadata.source?.replace('@site/', '');

  return (
    <EditablePageWrapper source={source}>
      <BlogPostItem {...props} />
    </EditablePageWrapper>
  );
}
