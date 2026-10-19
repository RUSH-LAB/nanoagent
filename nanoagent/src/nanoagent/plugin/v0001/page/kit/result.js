// A task's result, beside the chat: its typed output, drawn from its JSON Schema or by the
// plugin's renderer for its output class, under the task's name and its verdict.

import { dataTable, statusPill } from "./display.js";
import { h, humanize } from "./dom.js";

// Text longer than this is a paragraph; a list of objects wider than this many columns shows the
// rest under each row.
const SHORT_TEXT = 140;
const TABLE_COLUMNS = 5;

const kindOf = (schema = {}) => {
  const types = [schema.type ?? (schema.anyOf ?? []).map((one) => one.type)].flat().filter((type) => type && type !== "null");
  return types[0] ?? (schema.properties ? "object" : "string");
};
const fieldSchema = (schema, key) => schema.properties?.[key] ?? (typeof schema.additionalProperties === "object" ? schema.additionalProperties : {});
const isScalar = (schema) => !["object", "array"].includes(kindOf(schema));

function text(value) {
  if (/^https?:\/\/\S+$/.test(value)) return h("a", { href: value, target: "_blank", rel: "noopener noreferrer", text: value });
  if (value.length > SHORT_TEXT || value.includes("\n")) return h("p", { class: "result-text", text: value });
  return h("span", { text: value });
}

/**
 * `value` drawn from its JSON Schema: an object as labelled fields, a list of objects as a table,
 * a list of anything else as a list, text (a link when it is one), numbers, and yes or no.
 * @param {unknown} value
 * @param {object} schema The value's JSON Schema, from the catalog's `outputSchema`.
 * @returns {Node}
 */
export function schemaView(value, schema = {}) {
  if (value === null || value === undefined) return h("span", { class: "muted", text: "—" });
  switch (kindOf(schema)) {
    case "boolean":
      return h("span", { text: value ? "Yes" : "No" });
    case "integer":
    case "number":
      return h("span", { class: "numeric", text: Number(value).toLocaleString() });
    case "array":
      return listView(value, schema.items ?? {});
    case "object":
      return objectView(value, schema);
    default:
      return text(String(value));
  }
}

function objectView(value, schema) {
  const keys = schema.properties ? Object.keys(schema.properties) : Object.keys(value);
  return h(
    "dl",
    { class: "result-fields" },
    keys.map((key) => {
      const field = fieldSchema(schema, key);
      return h("div", { class: isScalar(field) ? "result-field" : "result-field wide" }, h("dt", { text: humanize(key), title: field.description ?? null }), h("dd", {}, schemaView(value[key], field)));
    }),
  );
}

function listView(items, schema) {
  if (!items.length) return h("span", { class: "muted", text: "None" });
  if (kindOf(schema) !== "object" || !schema.properties) {
    return isScalar(schema) && items.every((item) => String(item).length <= SHORT_TEXT)
      ? h("ul", { class: "result-list" }, items.map((item) => h("li", {}, schemaView(item, schema))))
      : h("ol", { class: "result-list blocks" }, items.map((item) => h("li", {}, schemaView(item, schema))));
  }
  // The scalar fields are the columns; the rest, and the columns past the first few, show under each row.
  const keys = Object.keys(schema.properties);
  const columns = keys.filter((key) => isScalar(schema.properties[key])).slice(0, TABLE_COLUMNS);
  const rest = keys.filter((key) => !columns.includes(key));
  const restSchema = { type: "object", properties: Object.fromEntries(rest.map((key) => [key, schema.properties[key]])) };
  return dataTable({
    caption: "Results",
    limit: 20,
    rows: items,
    columns: [
      ...columns.map((key, index) => ({
        key,
        label: humanize(key),
        primary: index === 0,
        numeric: ["integer", "number"].includes(kindOf(schema.properties[key])),
        render: (row) => schemaView(row[key], schema.properties[key]),
      })),
      ...(rest.length ? [{ key: "_more", label: "", sortable: false, render: (row) => objectView(row, restSchema) }] : []),
    ],
  }).element;
}

/**
 * One task call's result: the task's name, its verdict, and its output.
 * @param {object} task The catalog's task: `description`, `output` (the class name), `outputSchema`.
 * @param {{output: unknown, verdict: {valid: boolean, message: string}}} result What the task call returned.
 * @param {((value: unknown, context: object) => Node) | undefined} renderer The plugin's renderer for `task.output`.
 * @param {(text: string) => void} send Sends a message as if the person typed it.
 * @returns {HTMLElement}
 */
export function resultCard(task, { output, verdict }, renderer, send) {
  const badge = verdict.valid ? statusPill("Checked", "ok", { icon: true }) : statusPill("Check failed", "bad", { icon: true });
  badge.title = verdict.message;
  return h(
    "section",
    { class: "card result-card" },
    h("header", { class: "result-head" }, h("h3", { text: task.description }), badge),
    verdict.valid ? null : h("p", { class: "error-text", text: verdict.message }),
    renderer ? scoped(renderer(output, { task, verdict, send })) : schemaView(output, task.outputSchema),
  );
}

/**
 * `node`, a renderer's output, in a closed shadow root of its own with the kit's styles and the plugin's
 * renderers.css: the plugin's styles reach only its renderers' output, never the page around it.
 * @param {Node} node
 * @returns {HTMLElement}
 */
function scoped(node) {
  const host = h("div", { class: "renderer" });
  host.attachShadow({ mode: "closed" }).append(h("link", { rel: "stylesheet", href: "kit/kit.css" }), h("link", { rel: "stylesheet", href: "renderers.css" }), node);
  return host;
}

/**
 * The column beside the chat, in two tabs: Graph, a turn's provenance graph (kit/graph.js), and
 * Result, the result of one task the agent ran. `show(node)` puts a result in Result and
 * `trace(node)` a graph in Graph, each opening its tab unless `focus` is false.
 * @returns {{element: HTMLElement, show: (node: Node, options?: {focus?: boolean}) => void, trace: (node: Node, options?: {focus?: boolean}) => void}}
 */
export function resultsPane() {
  const empty = (title, text) => h("div", { class: "results-empty" }, h("p", { text: title }), h("p", { class: "muted", text }));
  const panels = {
    graph: h("div", { class: "results-panel trace-panel", role: "tabpanel", "aria-label": "Graph" }, empty("The agent's work shows here", "Each turn draws what the agent did as it works: every model request, tool call and value.")),
    result: h("div", { class: "results-panel", role: "tabpanel", "aria-label": "Result", hidden: true }, empty("Results show here", "Each task the agent runs shows its result here.")),
  };
  const tabs = Object.fromEntries(
    Object.keys(panels).map((name) => [name, h("button", { type: "button", class: "kit-tab", role: "tab", "aria-selected": String(name === "graph"), text: name === "graph" ? "Graph" : "Result" })]),
  );
  const open = (name) => {
    for (const [each, panel] of Object.entries(panels)) {
      panel.hidden = each !== name;
      tabs[each].setAttribute("aria-selected", String(each === name));
    }
  };
  for (const [name, tab] of Object.entries(tabs)) tab.addEventListener("click", () => open(name));
  const element = h("section", { class: "results-pane", "aria-label": "Graph and result" }, h("div", { class: "results-tabs", role: "tablist" }, Object.values(tabs)), Object.values(panels));
  const put = (name) => (node, { focus = true } = {}) => {
    panels[name].replaceChildren(node);
    panels[name].scrollTop = 0;
    element.classList.add("filled");
    if (focus) open(name);
  };
  return { element, show: put("result"), trace: put("graph") };
}
