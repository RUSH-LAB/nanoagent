import React from 'react';
import Layout from '@theme-original/DocItem/Layout';
import {useDoc} from '@docusaurus/plugin-content-docs/client';
import {EditablePageWrapper} from '@site/src/components/MarkdownEditor';

export default function DocItemLayoutWrapper(props) {
  const {metadata} = useDoc();
  const source = metadata.source?.replace('@site/', '');

  return (
    <EditablePageWrapper source={source}>
      <Layout {...props} />
    </EditablePageWrapper>
  );
}
