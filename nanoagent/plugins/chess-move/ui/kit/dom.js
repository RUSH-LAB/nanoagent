// DOM and formatting helpers every kit component and plugin page builds on.

const SVG = "http://www.w3.org/2000/svg";

/**
 * Create an element.
 * @param {string} tag The tag name, e.g. "div".
 * @param {object} [attrs] Attributes: `text` sets textContent, `on<event>` functions become
 *   listeners, a non-string value whose key is a property (e.g. `disabled`, `value`) is set as the
 *   property, any other value as an attribute. `undefined`, `null` and `false` are skipped.
 * @param {...(Node|string|number|Array|null|false|undefined)} children Nodes or text; arrays are
 *   flattened and empty values skipped.
 * @returns {HTMLElement}
 */
export function h(tag, attrs = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "text") element.textContent = value;
    else if (key.startsWith("on") && typeof value === "function") element.addEventListener(key.slice(2), value);
    else if (key in element && typeof value !== "string") element[key] = value;
    else element.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    element.append(child instanceof Node ? child : String(child));
  }
  return element;
}

// 24x24 stroke icons, drawn with currentColor.
const ICONS = {
  check: ["M5 12.5l4.5 4.5L19 7.5"],
  alert: ["M12 4l9 16H3z", "M12 10v4.5", "M12 17.5v.01"],
  error: ["M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z", "M9 9l6 6", "M15 9l-6 6"],
  info: ["M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z", "M12 11v5", "M12 7.5v.01"],
  stop: ["M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z", "M9.5 9.5h5v5h-5z"],
  chat: ["M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H10l-4 3.5V17H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z"],
  close: ["M6 6l12 12", "M18 6L6 18"],
  copy: ["M9 9h10v11H9z", "M5 15V4h10"],
  upload: ["M12 16V4", "M7 9l5-5 5 5", "M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"],
  file: ["M6 3h8l5 5v13H6z", "M14 3v5h5"],
  folder: ["M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"],
  plus: ["M12 5v14", "M5 12h14"],
  minus: ["M5 12h14"],
  chevron: ["M9 6l6 6-6 6"],
  sort: ["M8 10l4-4 4 4", "M8 14l4 4 4-4"],
  search: ["M10.5 4a6.5 6.5 0 1 0 0 13a6.5 6.5 0 1 0 0-13z", "M15.5 15.5L20 20"],
  calendar: ["M4 6h16v14H4z", "M4 10h16", "M8 3v4", "M16 3v4"],
  play: ["M8 5l11 7-11 7z"],
  refresh: ["M20 11a8 8 0 1 0-2.3 5.7", "M20 5v6h-6"],
  spark: ["M12 3v4", "M12 17v4", "M3 12h4", "M17 12h4", "M6 6l2.5 2.5", "M15.5 15.5L18 18", "M6 18l2.5-2.5", "M15.5 8.5L18 6"],
};

/** The names {@link icon} draws. */
export const ICON_NAMES = Object.freeze(Object.keys(ICONS));

/**
 * A small stroke icon as an inline SVG that takes the text colour.
 * @param {string} name One of {@link ICON_NAMES}.
 * @param {{label?: string, size?: number}} [options] `label` makes it an image with that
 *   accessible name; without one it is decorative (`aria-hidden`). `size` in px, default 18.
 * @returns {SVGSVGElement}
 */
export function icon(name, { label, size = 18 } = {}) {
  const paths = ICONS[name];
  if (!paths) throw new Error(`Unknown icon ${JSON.stringify(name)}: expected one of ${ICON_NAMES.join(", ")}.`);
  const svg = document.createElementNS(SVG, "svg");
  for (const [key, value] of Object.entries({ viewBox: "0 0 24 24", width: size, height: size, class: "icon", fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round" })) {
    svg.setAttribute(key, String(value));
  }
  if (label) {
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", label);
  } else {
    svg.setAttribute("aria-hidden", "true");
  }
  for (const d of paths) {
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

/**
 * Turn an identifier into words for people.
 * @example humanize("max_results") // "Max results"; humanize("search-papers") // "Search papers"
 * @param {string} name
 * @returns {string}
 */
export function humanize(name) {
  const words = String(name)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-\s]+/g, " ")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Indented JSON for a value; a string that holds JSON is shown parsed, any other string as is.
 * @param {unknown} value
 * @returns {string}
 */
export function pretty(value) {
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  return JSON.stringify(value, null, 2);
}

/**
 * A byte count in words: "812 B", "4.2 KB", "1.3 MB".
 * @param {number} bytes
 * @returns {string}
 */
export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * A duration in words: "8 s", "3 min 12 s", "1 h 4 min".
 * @param {number} seconds
 * @returns {string}
 */
export function formatDuration(seconds) {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total} s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} min ${total % 60} s`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/**
 * "1 entry", "3 entries": a count with its noun.
 * @param {number} count
 * @param {string} one The singular noun.
 * @param {string} [many] The plural, default `one + "s"`.
 * @returns {string}
 */
export function plural(count, one, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

let uid = 0;
/**
 * A page-unique id for `for`/`aria-*` links.
 * @param {string} [prefix]
 * @returns {string}
 */
export function nextId(prefix = "kit") {
  uid += 1;
  return `${prefix}-${uid}`;
}

/**
 * Show the page in the host's theme (sets `html[data-theme]`, which every kit colour follows).
 * @param {"light"|"dark"} theme
 */
export function applyTheme(theme) {
  if (theme !== "light" && theme !== "dark") throw new Error(`Unknown theme ${JSON.stringify(theme)}: expected "light" or "dark".`);
  document.documentElement.dataset.theme = theme;
}

/**
 * A plain-text message for screen readers only, announced politely. Pages call it for changes
 * that matter (a step finished, a result arrived), not for every tick.
 * @param {string} text
 */
export function announce(text) {
  let region = document.getElementById("kit-announcer");
  if (!region) {
    region = h("div", { id: "kit-announcer", class: "visually-hidden", role: "status", "aria-live": "polite" });
    document.body.append(region);
  }
  region.textContent = "";
  setTimeout(() => {
    region.textContent = text;
  }, 30);
}
