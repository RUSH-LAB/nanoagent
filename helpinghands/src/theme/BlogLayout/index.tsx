import React, {type ReactNode} from 'react';
import Layout from '@theme/Layout';
import BlogGroupSidebar from '@site/src/components/BlogGroupSidebar';
import TwoColumnLayout from '@site/src/components/TwoColumnLayout';
import ContentWithToc from '@site/src/components/ContentWithToc';

import type {Props} from '@theme/BlogLayout';

/**
 * A blog page: the group sidebar beside the prose and TOC columns a book page
 * also renders (src/components/ContentWithToc). Every blog page passes its
 * group navigation as `sidebar` (runtime-content/DocumentRoute).
 */
export default function BlogLayout(props: Props): ReactNode {
  const {sidebar, toc, children, ...layoutProps} = props;
  return (
    <Layout {...layoutProps}>
      <TwoColumnLayout
        sidebarKey="blog-groups"
        showSidebarOnMobile
        renderSidebar={({collapsed, onCollapse}) => (
          <BlogGroupSidebar
            navigation={sidebar}
            collapsed={collapsed}
            onCollapse={onCollapse}
          />
        )}
      >
        <ContentWithToc toc={toc}>{children}</ContentWithToc>
      </TwoColumnLayout>
    </Layout>
  );
}
