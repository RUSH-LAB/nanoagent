import React from 'react';
import {useDoc} from '@docusaurus/plugin-content-docs/client';
import DocBreadcrumbs from '@theme-original/DocBreadcrumbs';

export default function DocBreadcrumbsWrapper(props) {
  const {frontMatter} = useDoc();
  if (frontMatter.hide_breadcrumbs) return null;
  return <DocBreadcrumbs {...props} />;
}
