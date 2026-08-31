import {useMemo} from 'react';
import useGlobalData from '@docusaurus/useGlobalData';

/**
 * The commands the shell offers, collected from the plugins that offer them.
 *
 * This was a hardcoded list, and a tool was a page under src/pages plus a line
 * here plus a route in the plugin plus handlers in whichever server module had
 * room: four places, none of which was the tool. Now a plugin declares its own
 * way in, by putting a `command` in its global data, and both launchers read
 * whatever is there. Adding a tool is adding a plugin; the shell learns of it
 * without being edited.
 *
 * Icons are named rather than passed. Global data is serialized into the build,
 * and a React element does not survive that, so a plugin names one of the icons
 * below and gets the fallback if it names something else.
 */

/* ── SVG icons (inline to avoid any external dependency) ────────── */
export const icons = {
  book: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </svg>
  ),
  // What a plugin gets when it names an icon this shell does not have, and what
  // the palette draws in its own search field.
  search: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  ),
};

/** Haystack a fuzzy match runs against, so both launchers rank identically. */
export function commandHaystack(cmd) {
  return `${cmd.name} ${cmd.title} ${cmd.description} ${cmd.category}`;
}

/**
 * Every plugin's declared command, in a stable order.
 *
 * Global data is keyed by plugin name and then by instance id, and a plugin
 * that declares no command contributes nothing, so most of this is skipping
 * over the plugins that are here for other reasons.
 */
export function useCommands() {
  const globalData = useGlobalData();
  return useMemo(() => {
    const found = [];
    for (const instances of Object.values(globalData ?? {})) {
      for (const data of Object.values(instances ?? {})) {
        const command = data?.command;
        if (!command?.name || !command?.href) continue;
        found.push({...command, icon: icons[command.icon] ?? icons.search});
      }
    }
    return found.sort((a, b) => a.name.localeCompare(b.name));
  }, [globalData]);
}
