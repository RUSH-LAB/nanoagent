import React from 'react';
import {useLocation} from '@docusaurus/router';
import {PageMetadata} from '@docusaurus/theme-common';
import SECTIONS from './registry';
import {sectionAt} from './sectionList';
import {useShell} from './context';

/**
 * The route of the workspace's sections (runtime-content). It draws nothing
 * but the page's title: the shell holds the sections (./Sections.js), and this
 * tells it which is open, and at what address, once the route is drawn.
 */
export default function SectionPage() {
  const location = useLocation();
  const section = SECTIONS.find(item => item.id === sectionAt(location.pathname).id);
  const show = useShell()?.show;
  React.useLayoutEffect(() => show?.({section, location}), [show, section, location]);
  return <PageMetadata title={section.page.title} description={section.page.description} />;
}
