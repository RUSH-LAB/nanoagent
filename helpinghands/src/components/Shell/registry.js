import React from 'react';
import {HomeSection, page as homePage} from '@site/src/runtime-content/WorkspaceHomeRoute.js';
import {AppsSection, page as appsPage} from '@site/src/pages/apps/index.js';
import {MarketplaceSection, page as marketplacePage} from '@site/src/pages/marketplace/index.js';
import {SettingsSection, page as settingsPage} from '@site/src/pages/settings/index.js';
import {WorkspaceSection, page as workspacePage} from '@site/src/pages/workspace/index.js';
import {SECTIONS} from './sectionList';

/** What each section in ./sectionList.js draws: its icon, its content and its page's title and description. */
const DRAWN = {
  home: {
    Section: HomeSection,
    page: homePage,
    icon: <path d="M3.5 9.25 10 3.75l6.5 5.5V16a.75.75 0 0 1-.75.75H12.5v-4.5h-5v4.5H4.25A.75.75 0 0 1 3.5 16z" />,
  },
  plugins: {
    Section: AppsSection,
    page: appsPage,
    icon: <path d="M9 3.5h3.5a1 1 0 0 1 1 1V8a2 2 0 1 1 0 4v3.5a1 1 0 0 1-1 1H9a2 2 0 1 0-4 0H4.5a1 1 0 0 1-1-1V12a2 2 0 1 0 0-4V4.5a1 1 0 0 1 1-1H5a2 2 0 1 1 4 0z" />,
  },
  marketplace: {
    Section: MarketplaceSection,
    page: marketplacePage,
    icon: <path d="M3.5 8h13l-1.1 9h-10.8zM7 8V6.5a3 3 0 0 1 6 0V8" />,
  },
  workspace: {
    Section: WorkspaceSection,
    page: workspacePage,
    icon: <path d="M2.75 5.25a1.5 1.5 0 0 1 1.5-1.5h3.5l1.75 2h6.25a1.5 1.5 0 0 1 1.5 1.5v7.5a1.5 1.5 0 0 1-1.5 1.5H4.25a1.5 1.5 0 0 1-1.5-1.5z" />,
  },
  settings: {
    Section: SettingsSection,
    page: settingsPage,
    // Lucide's settings gear (ISC), on its 24-unit grid.
    icon: (
      <g transform="scale(0.8333)" strokeWidth="1.8">
        <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
        <circle cx="12" cy="12" r="3" />
      </g>
    ),
  },
};

const listed = new Set(SECTIONS.map(section => section.id));
const unlisted = Object.keys(DRAWN).filter(id => !listed.has(id));
const undrawn = SECTIONS.filter(section => !DRAWN[section.id]).map(section => section.id);
if (unlisted.length || undrawn.length) {
  throw new Error(`Shell sections out of step with sectionList.js: not listed ${unlisted.join(', ') || 'none'}; not drawn ${undrawn.join(', ') || 'none'}`);
}

/** The sections of ./sectionList.js, each with what it draws. */
export default SECTIONS.map(section => ({...section, ...DRAWN[section.id]}));
