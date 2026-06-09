import React, {type ReactNode} from 'react';
import clsx from 'clsx';
import ErrorBoundary from '@docusaurus/ErrorBoundary';
import {
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
import QuickActions from '@site/src/components/QuickActions';
import styles from './styles.module.css';

export default function Layout(props: Props): ReactNode {
  const {
    children,
    noFooter,
    wrapperClassName,
    title,
    description,
  } = props;

  return (
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

      <Navbar />

      <div
        id={SkipToContentFallbackId}
        className={clsx(
          ThemeClassNames.layout.main.container,
          ThemeClassNames.wrapper.main,
          styles.mainWrapper,
          wrapperClassName,
        )}>
        <ErrorBoundary fallback={(params) => <ErrorPageContent {...params} />}>
          {children}
        </ErrorBoundary>
      </div>

      {!noFooter && <Footer />}

      <QuickActions />
    </LayoutProvider>
  );
}
