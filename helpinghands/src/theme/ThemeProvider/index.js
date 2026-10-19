import React from 'react';
import ThemeProvider from '@theme-original/ThemeProvider';
import Frame from '@site/src/components/Shell/Frame';

/**
 * Docusaurus's ThemeProvider, the one theme component that wraps the router's
 * pages and outlives every page change, with the frame every page is drawn in
 * (components/Shell/Frame.js) inside it.
 */
export default function ThemeProviderWithFrame({children}) {
  return (
    <ThemeProvider>
      <Frame>{children}</Frame>
    </ThemeProvider>
  );
}
