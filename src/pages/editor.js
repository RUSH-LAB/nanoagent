import React from 'react';
import Layout from '@theme/Layout';
import BrowserOnly from '@docusaurus/BrowserOnly';
import AuthGuard from '../components/AuthGuard';
import ErrorBoundary from '@site/src/components/ErrorBoundary';

export default function EditorPage() {
  return (
    <Layout title="Editor" noFooter>
      <AuthGuard role="editor">
        <BrowserOnly fallback={<div style={{padding: 40, textAlign: 'center'}}>Loading editor...</div>}>
          {() => {
            const Editor = require('../components/Editor').default;
            const params = new URLSearchParams(window.location.search);
            const initialFile = params.get('file') || null;
            return (
              <ErrorBoundary>
                <Editor initialFile={initialFile} />
              </ErrorBoundary>
            );
          }}
        </BrowserOnly>
      </AuthGuard>
    </Layout>
  );
}
