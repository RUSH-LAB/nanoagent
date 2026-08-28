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
      {/* The theme ships `margin-vert--lg` here, which drops the post title 2rem
          below the navbar while DocRoot's container uses `padding-top--md`, 1rem.
          Match the docs spacing so a post and a doc open at the same height. */}
      <div
        className={clsx(
          'container padding-top--md padding-bottom--lg',
          styles.blogContainer,
        )}>
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
