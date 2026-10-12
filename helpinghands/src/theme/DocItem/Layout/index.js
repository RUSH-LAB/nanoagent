import React from 'react';
import {useWindowSize} from '@docusaurus/theme-common';
import {useDoc} from '@docusaurus/plugin-content-docs/client';
import DocItemPaginator from '@theme/DocItem/Paginator';
import DocVersionBanner from '@theme/DocVersionBanner';
import DocVersionBadge from '@theme/DocVersionBadge';
import DocItemFooter from '@theme/DocItem/Footer';
import DocItemTOCMobile from '@theme/DocItem/TOC/Mobile';
import DocItemTOCDesktop from '@theme/DocItem/TOC/Desktop';
import DocItemContent from '@theme/DocItem/Content';
import DocBreadcrumbs from '@theme/DocBreadcrumbs';
import ContentVisibility from '@theme/ContentVisibility';
import Backlinks from '@site/src/components/Backlinks';
import ContentWithToc from '@site/src/components/ContentWithToc';
import styles from './styles.module.css';

/**
 * A book page: the theme's DocItem layout, with its columns drawn by
 * ContentWithToc, the component blog pages use too, rather than the theme's
 * `.row`. The theme's `docItemCol` capped the prose at 75% from a CSS cascade
 * layer, which outranks any unlayered override, so the TOC moved whenever the
 * sidebar changed width.
 */
export default function DocItemLayout({children}) {
  const {frontMatter, toc, metadata} = useDoc();
  const windowSize = useWindowSize();
  const showToc = !frontMatter.hide_table_of_contents && toc.length > 0;
  const source = metadata.source?.replace('@site/', '');

  return (
    <>
      <ContentWithToc toc={showToc && (windowSize === 'desktop' || windowSize === 'ssr') ? <DocItemTOCDesktop /> : null}>
        <ContentVisibility metadata={metadata} />
        <DocVersionBanner />
        <div className={styles.docItemContainer}>
          <article>
            <DocBreadcrumbs />
            <DocVersionBadge />
            {showToc && <DocItemTOCMobile />}
            <DocItemContent>{children}</DocItemContent>
            <DocItemFooter />
          </article>
          <DocItemPaginator />
        </div>
      </ContentWithToc>
      <Backlinks filePath={source} />
    </>
  );
}
