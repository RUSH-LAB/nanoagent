// A task's result in the chat: its typed output, drawn from its JSON Schema or by the plugin's
// renderer for its output class, under the task's name and its verdict.

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
 * One task call in the chat: the task's name, its verdict, and its output.
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
    renderer ? renderer(output, { task, verdict, send }) : schemaView(output, task.outputSchema),
  );
}
