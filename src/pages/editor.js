import React from 'react';
import Layout from '@theme/Layout';
import BrowserOnly from '@docusaurus/BrowserOnly';
import ErrorBoundary from '@site/src/components/ErrorBoundary';

export default function EditorPage() {
  return (
    <Layout title="Editor" noFooter>
      <BrowserOnly fallback={<div style={{padding: 40, textAlign: 'center'}}>Loading editor...</div>}>
        {() => {
          // AuthGuard relies on Clerk's useUser hook, which must run inside a
          // ClerkProvider that only exists in the browser. Rendering it inside
          // BrowserOnly keeps the auth gate client side so static site
          // generation never calls useUser outside a provider. The editor it
          // protects is already browser only, so nothing is lost.
          const AuthGuard = require('../components/AuthGuard').default;
          const Editor = require('../components/Editor').default;
          const params = new URLSearchParams(window.location.search);
          const initialFile = params.get('file') || null;
          return (
            <AuthGuard role="editor">
              <ErrorBoundary>
                <Editor initialFile={initialFile} />
              </ErrorBoundary>
            </AuthGuard>
          );
        }}
      </BrowserOnly>
    </Layout>
  );
}
