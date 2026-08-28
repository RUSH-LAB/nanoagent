import React from 'react';
import Layout from '@theme-original/DocItem/Layout';
import {useDoc} from '@docusaurus/plugin-content-docs/client';
import {EditablePageWrapper} from '@site/src/components/EditPageButton';
import Backlinks from '@site/src/components/Backlinks';

export default function DocItemLayoutWrapper(props) {
  const {metadata} = useDoc();
  const source = metadata.source?.replace('@site/', '');

  // EditablePageWrapper pins its Edit link to the top-right corner, so nothing
  // else belongs in that corner.
  return (
    <EditablePageWrapper source={source}>
      <Layout {...props} />
      <Backlinks filePath={source} />
    </EditablePageWrapper>
  );
}
