// The plugin UI kit: one import for a plugin page's app.js.
//
//   import { appShell, taskRun, ... } from "./kit/components.js";
//
// Every file in kit/ is shared, byte for byte, by every built-in plugin; a page adds its own
// pieces in its own files next to app.js. See docs/plans/plugin-ui.md for the whole API.

export { PROTOCOL, hasHost, on, request, startRun } from "./bridge.js";
export { ICON_NAMES, announce, applyTheme, formatDuration, formatSize, h, humanize, icon, nextId, plural, pretty } from "./dom.js";
export { TONES, actionBar, banner, card, columns, dataTable, disclosure, emptyState, howItWorks, meter, skeleton, statusPill } from "./display.js";
export { chipRow, chipToggles, chipsInput, copyButton, copyField, copyText, dateInput, fileDrop, isoDate, labeled, numberStepper, segmented, workspacePicker } from "./inputs.js";
export { COMMON_ERRORS, block, errorCard, explainError, parseToolOutput, runButton, runControls, taskRun, taskView, toolItem, verdictBanner, verdictView } from "./run.js";
export { chatDrawer, chatPanel } from "./chat.js";
export { schemaForm, stringList } from "./forms.js";
export { filesPanel, jsonStore, listFiles, readFile, readJSON, readText, writeJSON, writeText } from "./workspace.js";
export { appShell, chatLayout } from "./shell.js";
export { currentSession, formatCost, formatSeconds, metricsLine } from "./session.js";
