import React from 'react';
import BrowserOnly from '@docusaurus/BrowserOnly';
import {useLocation} from '@docusaurus/router';
import {composeProviders, HtmlClassNameProvider, SkipToContentFallbackId} from '@docusaurus/theme-common';
import {
  AnnouncementBarProvider,
  ColorModeProvider,
  NavbarProvider,
  ScrollControllerProvider,
} from '@docusaurus/theme-common/internal';
import {DocsPreferredVersionContextProvider} from '@docusaurus/plugin-content-docs/client';
import AnnouncementBar from '@theme/AnnouncementBar';
import SkipToContent from '@theme/SkipToContent';
import CommandPalette from '@site/src/components/CommandPalette';
import ToastContainer from '@site/src/components/Toast';
import {useAccount} from '@site/src/utils/account';
import {workspaceSlugFromPath} from '@site/src/utils/workspaces';
import layoutStyles from '@site/src/theme/Layout/styles.module.css';
import Shell from './index';

// The theme's Layout/Provider but for PluginHtmlClassNameProvider, which reads
// the route's plugin and so stays with each page (theme/Layout).
const Providers = composeProviders([
  ColorModeProvider,
  AnnouncementBarProvider,
  ScrollControllerProvider,
  DocsPreferredVersionContextProvider,
  NavbarProvider,
]);

/**
 * What every page is drawn inside, mounted once above the router's pages
 * (theme/ThemeProvider), so a page change remounts none of it: the theme's
 * providers, what belongs to the window rather than a page (the skip links,
 * the command palette, toasts, the announcement bar) and, in a workspace the
 * member is in, its shell (./index.js) with the workspace's sections, beside
 * whichever page is open. A page's own frame is theme/Layout.
 */
export default function Frame({children}) {
  const {pathname} = useLocation();
  const {workspaces} = useAccount();
  const slug = workspaceSlugFromPath(pathname);
  const workspace = slug === null ? null : workspaces.find(item => item.slug === slug) ?? null;

  // html.site-shell (src/css/custom.css), through Docusaurus's own <html> classes, which each page adds to.
  return (
    <Providers>
      <HtmlClassNameProvider className={workspace ? 'site-shell' : undefined}>
        <a className={layoutStyles.skipToContent} href={`#${SkipToContentFallbackId}`}>
          Skip to content
        </a>
        <BrowserOnly>{() => <CommandPalette />}</BrowserOnly>
        <ToastContainer />
        <SkipToContent />
        <AnnouncementBar />
        {/* One shell per workspace: entering another starts its sections anew. */}
        {workspace ? <Shell key={workspace.slug} slug={workspace.slug} workspace={workspace}>{children}</Shell> : children}
      </HtmlClassNameProvider>
    </Providers>
  );
}
