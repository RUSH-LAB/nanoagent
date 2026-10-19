import React, {type ReactNode} from 'react';
import clsx from 'clsx';
import ErrorBoundary from '@docusaurus/ErrorBoundary';
import {
  HtmlClassNameProvider,
  PageMetadata,
  SkipToContentFallbackId,
  ThemeClassNames,
} from '@docusaurus/theme-common';
import BrowserOnly from '@docusaurus/BrowserOnly';
import SkipToContent from '@theme/SkipToContent';
import AnnouncementBar from '@theme/AnnouncementBar';
import Navbar from '@theme/Navbar';
import Footer from '@theme/Footer';
import LayoutProvider from '@theme/Layout/Provider';
import ErrorPageContent from '@theme/ErrorPageContent';
import type {Props} from '@theme/Layout';
import ReadingProgress from '@site/src/components/ReadingProgress';
import CommandPalette from '@site/src/components/CommandPalette';
import ToastContainer from '@site/src/components/Toast';
import Shell from '@site/src/components/Shell';
import useWorkspaceSite from '@site/src/hooks/useWorkspaceSite';
import {useAccount} from '@site/src/utils/account';
import styles from './styles.module.css';

/**
 * Every page's frame. Inside a workspace the member is in, the shell
 * (components/Shell), its activity bar down the left edge, stands in for the
 * navbar and the footer; everywhere else the page has both.
 */
export default function Layout(props: Props): ReactNode {
  const {
    children,
    noFooter,
    wrapperClassName,
    title,
    description,
  } = props;
  const {slug, workspace} = useWorkspaceSite();
  const {account} = useAccount();
  const inShell = Boolean(slug && workspace && account);

  const main = (
    <div
      id={SkipToContentFallbackId}
      className={clsx(
        ThemeClassNames.layout.main.container,
        ThemeClassNames.wrapper.main,
        styles.mainWrapper,
        inShell && styles.shellWrapper,
        wrapperClassName,
      )}>
      <ErrorBoundary fallback={(params) => <ErrorPageContent {...params} />}>
        {children}
      </ErrorBoundary>
    </div>
  );

  // html.site-shell (src/css/custom.css), through Docusaurus's own <html> classes, which it rewrites on each page.
  return (
    <HtmlClassNameProvider className={inShell ? 'site-shell' : undefined}>
      <LayoutProvider>
        <a
          className={styles.skipToContent}
          href={`#${SkipToContentFallbackId}`}
        >
          Skip to content
        </a>

        <BrowserOnly>{() => <CommandPalette />}</BrowserOnly>
        <ReadingProgress />
        <ToastContainer />

        <PageMetadata title={title} description={description} />

        <SkipToContent />

        <AnnouncementBar />

        {inShell ? (
          <Shell slug={slug} workspace={workspace}>{main}</Shell>
        ) : (
          <>
            <Navbar />
            {main}
            {!noFooter && <Footer />}
          </>
        )}
      </LayoutProvider>
    </HtmlClassNameProvider>
  );
}
