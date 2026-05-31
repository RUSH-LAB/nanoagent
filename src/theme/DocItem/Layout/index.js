import React from 'react';
import Layout from '@theme-original/DocItem/Layout';
import {useDoc} from '@docusaurus/plugin-content-docs/client';
import {EditablePageWrapper} from '@site/src/components/MarkdownEditor';
import Comments from '@site/src/components/Comments';
import Annotations from '@site/src/components/Annotations';
import Backlinks from '@site/src/components/Backlinks';
import BookmarkButton from '@site/src/components/BookmarkButton';

export default function DocItemLayoutWrapper(props) {
  const {metadata} = useDoc();
  const source = metadata.source?.replace('@site/', '');
  const pageId = metadata.permalink;

  return (
    <EditablePageWrapper source={source}>
      <div style={{display: 'flex', alignItems: 'center', justifyContent: 'flex-end'}}>
        <BookmarkButton pagePath={pageId} pageTitle={metadata.title} />
      </div>
      <Layout {...props} />
      <Comments pageId={pageId} />
      <Annotations pageId={pageId} />
      <Backlinks filePath={source} />
    </EditablePageWrapper>
  );
}
