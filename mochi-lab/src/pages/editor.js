import React from 'react';
import Layout from '@theme/Layout';
import BrowserOnly from '@docusaurus/BrowserOnly';

export default function EditorPage() {
  return (
    <Layout title="Editor" noFooter>
      <BrowserOnly fallback={<div style={{padding: 40, textAlign: 'center'}}>Loading editor...</div>}>
        {() => {
          const Editor = require('../components/Editor').default;
          const params = new URLSearchParams(window.location.search);
          const initialFile = params.get('file') || null;
          return <Editor initialFile={initialFile} />;
        }}
      </BrowserOnly>
    </Layout>
  );
}
