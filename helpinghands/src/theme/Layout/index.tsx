import React, {type ReactNode} from 'react';
import clsx from 'clsx';
import ErrorBoundary from '@docusaurus/ErrorBoundary';
import {
  PageMetadata,
  SkipToContentFallbackId,
  ThemeClassNames,
} from '@docusaurus/theme-common';
import {PluginHtmlClassNameProvider} from '@docusaurus/theme-common/internal';
import Navbar from '@theme/Navbar';
import Footer from '@theme/Footer';
import ErrorPageContent from '@theme/ErrorPageContent';
import type {Props} from '@theme/Layout';
import ReadingProgress from '@site/src/components/ReadingProgress';
import {useShell} from '@site/src/components/Shell/context';
import styles from './styles.module.css';

/**
 * Every page's own frame, inside the one every page shares
 * (components/Shell/Frame.js). Inside a workspace the member is in, that one
 * draws the shell, whose activity bar stands in for the navbar and the footer,
 * and the page tells it no section is open; everywhere else the page has both.
 */
export default function Layout(props: Props): ReactNode {
  const {
    children,
    noFooter,
    wrapperClassName,
    title,
    description,
  } = props;
  const shell = useShell();
  const show = shell?.show;
  React.useLayoutEffect(() => show?.(null), [show]);

  const main = (
    <div
      id={SkipToContentFallbackId}
      className={clsx(
        ThemeClassNames.layout.main.container,
        ThemeClassNames.wrapper.main,
        styles.mainWrapper,
        shell && styles.shellWrapper,
        wrapperClassName,
      )}>
      <ErrorBoundary fallback={(params) => <ErrorPageContent {...params} />}>
        {children}
      </ErrorBoundary>
    </div>
  );

  return (
    <PluginHtmlClassNameProvider>
      <ReadingProgress />
      <PageMetadata title={title} description={description} />
      {shell ? main : (
        <>
          <Navbar />
          {main}
          {!noFooter && <Footer />}
        </>
      )}
    </PluginHtmlClassNameProvider>
  );
}
