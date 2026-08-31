import React, {useEffect, useState} from 'react';
import {useLocation} from '@docusaurus/router';
import BrowserOnly from '@docusaurus/BrowserOnly';
import Layout from '@theme/Layout';
import MDXComponents from '@theme/MDXComponents';
import * as jsxRuntime from 'react/jsx-runtime';
import API_BASE, {apiFetch} from '@site/src/utils/api';

/**
 * A page, fetched and rendered when somebody asks for it.
 *
 * What arrives from the API is not HTML and not markdown. It is the compiled
 * MDX: a string of JavaScript the server produced with the site's own remark
 * and rehype chain, which takes a JSX runtime and returns a component. So the
 * document decides the structure and this side decides what every name in it
 * means, which is what keeps `<Theorem>` the site's Theorem rather than
 * whatever a document might like it to be.
 */

/**
 * Run a compiled document.
 *
 * This is what `run` from @mdx-js/mdx does, written out, because importing it
 * would pull the compiler into the browser bundle to use three lines of it. The
 * compiler belongs on the server; the client only ever needs to call what it
 * produced.
 *
 * AsyncFunction rather than eval: the body is a function body by construction
 * (`outputFormat: 'function-body'`), it is read from our own API over the
 * caller's session, and it closes over nothing but the runtime handed to it.
 */
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

async function runCompiled(code, runtime) {
  return new AsyncFunction(String(code))(runtime);
}

/** The four states this route can be in. Rendered by the switch at the bottom. */
const LOADING = 'loading';
const READY = 'ready';
const MISSING = 'missing';
const BROKEN = 'broken';

function DocumentBody({documentPath}) {
  const [state, setState] = useState({status: LOADING});

  useEffect(() => {
    let cancelled = false;

    (async () => {
      setState({status: LOADING});
      try {
        const res = await apiFetch(
          `${API_BASE}/api/content?path=${encodeURIComponent(documentPath)}`,
        );
        const payload = await res.json().catch(() => ({}));

        if (cancelled) return;
        if (res.status === 404) {
          setState({status: MISSING});
          return;
        }
        if (!res.ok) {
          setState({status: BROKEN, message: payload.error || `Request failed (${res.status})`});
          return;
        }

        const {default: Content} = await runCompiled(payload.code, {
          ...jsxRuntime,
          baseUrl: typeof window === 'undefined' ? undefined : window.location.href,
        });
        if (cancelled) return;
        setState({status: READY, Content, document: payload.document});
      } catch (err) {
        if (!cancelled) setState({status: BROKEN, message: err.message});
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [documentPath]);

  if (state.status === LOADING) {
    return <p>Loading…</p>;
  }

  if (state.status === MISSING) {
    // The API answers the same way for a page that is not there and one this
    // caller may not read, so this wording has to cover both without implying
    // which. Saying "you do not have access" would tell an outsider that the
    // page exists, which is most of what a private page is hiding.
    return (
      <>
        <h1>Nothing here</h1>
        <p>
          There is no page at <code>{documentPath}</code> in this workspace.
        </p>
      </>
    );
  }

  if (state.status === BROKEN) {
    return (
      <>
        <h1>This page could not be rendered</h1>
        <p>{state.message}</p>
      </>
    );
  }

  const {Content, document} = state;
  return (
    <article>
      {document?.title ? <h1>{document.title}</h1> : null}
      <Content components={MDXComponents} />
    </article>
  );
}

export default function DocumentRoute() {
  const location = useLocation();
  // Everything after the route's own segment is the document. The base path is
  // the first segment of this route, so stripping it leaves exactly what the
  // API is asked for.
  const documentPath = location.pathname.replace(/^\/[^/]+\/?/, '').replace(/\/+$/, '');

  return (
    <Layout title={documentPath || 'Workspace'}>
      <main className="container margin-vert--lg">
        {/*
          The whole route is a fetch against the caller's session, so there is
          nothing for the static build to render and nothing it could render
          correctly: at build time there is no caller. BrowserOnly is how this
          site already keeps session-dependent trees out of the prerender.
        */}
        <BrowserOnly fallback={<p>Loading…</p>}>
          {() => <DocumentBody documentPath={documentPath} />}
        </BrowserOnly>
      </main>
    </Layout>
  );
}
