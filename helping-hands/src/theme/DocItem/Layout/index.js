import React from 'react';
import Layout from '@theme-original/DocItem/Layout';
import {useDoc} from '@docusaurus/plugin-content-docs/client';
import Backlinks from '@site/src/components/Backlinks';

export default function DocItemLayoutWrapper(props) {
  const {metadata} = useDoc();
  const source = metadata.source?.replace('@site/', '');

  return (
    <>
      <Layout {...props} />
      <Backlinks filePath={source} />
    </>
  );
}
