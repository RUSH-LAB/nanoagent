import React from 'react';
import {Redirect} from '@docusaurus/router';

/** An address the site has no page for goes to the landing page (pages/index). */
export default function NotFound() {
  return <Redirect to="/" />;
}
