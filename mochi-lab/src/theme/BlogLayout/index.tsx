import React, {type ReactNode} from 'react';
import clsx from 'clsx';
import Layout from '@theme/Layout';
import BlogSidebar from '@theme/BlogSidebar';

import type {Props} from '@theme/BlogLayout';
import styles from './styles.module.css';

export default function BlogLayout(props: Props): ReactNode {
  const {sidebar, toc, children, ...layoutProps} = props;

  return (
    <Layout {...layoutProps}>
      <div className={clsx('container margin-vert--lg', styles.blogContainer)}>
        <div className="row">
          <BlogSidebar sidebar={sidebar} />
          <main className={clsx('col', toc && styles.blogContentCol)}>
            {children}
          </main>
          {toc && <div className={clsx('col', styles.blogTocCol)}>{toc}</div>}
        </div>
      </div>
    </Layout>
  );
}
