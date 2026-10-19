import React from 'react';

/**
 * The shell's side bar, inside a workspace (components/Shell):
 * `{setOpen, toggle, title, setWidth, drag}`, `title` the open section's
 * name, which heads its side bar; or null outside one, where each page keeps
 * its own sidebar's state. Whether the side bar is open and how wide is not
 * here but on the shell's element, as data-side-folded and --site-side-width,
 * which every page's side bar is drawn from in CSS, so one click on the
 * activity bar hides or shows whichever is in view, and nothing re-renders.
 */
export const ShellContext = React.createContext(null);

export const useShell = () => React.useContext(ShellContext);

/** The side bar's width in pixels where it starts; it is never drawn narrower than its content needs (./Sash.js). */
export const SIDE_DEFAULT = 288;

/**
 * The address each section was last open at, by its own path (/w/<slug>/<section>),
 * which its icon on the activity bar returns to (./Sections.js).
 */
export const sectionHrefs = new Map();
