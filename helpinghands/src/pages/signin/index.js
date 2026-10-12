import React from 'react';
import Head from '@docusaurus/Head';
import AuthScreen from '@site/src/theme/Root/AuthScreen';

/**
 * Where a visitor without a session is sent, by the server before it sends a
 * page that needs one (src/utils/signIn.js). Its own page, built into the site
 * like any other, so the sign-in form is the first thing they see rather than
 * the page they asked for followed by the form.
 */
export default function SignIn() {
  return (
    <>
      <Head><title>Sign in</title></Head>
      <AuthScreen />
    </>
  );
}
