// The plugin UI kit: one import for a plugin's ui/renderers.js.
//
//   import { dataTable, h } from "./kit/components.js";
//
// NanoAgent serves kit/ to every plugin's page; a plugin's renderers draw its outputs with it, and
// add their own pieces in their own files next to renderers.js. See docs/plans/plugin-ui.md.

export { ICON_NAMES, formatDuration, h, humanize, icon, plural } from "./dom.js";
export { TONES, dataTable, disclosure, statusPill } from "./display.js";
export { markdown } from "./markdown.js";
export { schemaView } from "./result.js";
