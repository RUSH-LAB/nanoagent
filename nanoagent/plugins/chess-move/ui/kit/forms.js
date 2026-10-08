// Forms generated from a task's input JSON Schema, for generic pages and developer views. A
// designed page builds its own inputs from ./inputs.js instead.

import { h, humanize, nextId } from "./dom.js";

const DATE_PATTERN = "^\\d{4}-\\d{2}-\\d{2}$";
const LONG_TEXT_NAMES = new Set(["text", "content", "body", "message", "prompt", "notes"]);
class FieldError extends Error {}

function kindOf(name, schema) {
  if (Array.isArray(schema.enum)) return "enum";
  switch (schema.type) {
    case "string":
      if (schema.format === "date" || schema.pattern === DATE_PATTERN) return "date";
      return LONG_TEXT_NAMES.has(name) || schema.maxLength > 200 ? "longtext" : "text";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "array":
      if (schema.items && schema.items.type === "string") return Array.isArray(schema.items.enum) ? "checks" : "list";
      return "json";
    default:
      return "json";
  }
}

function checkString(value, schema) {
  if (schema.minLength !== undefined && value.length < schema.minLength) throw new FieldError(`Must be at least ${schema.minLength} characters.`);
  if (schema.maxLength !== undefined && value.length > schema.maxLength) throw new FieldError(`Must be at most ${schema.maxLength} characters.`);
  if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
    throw new FieldError(schema.pattern === DATE_PATTERN ? "Must be a date, YYYY-MM-DD." : `Must match ${schema.pattern}.`);
  }
}

function checkNumber(value, schema) {
  if (schema.type === "integer" && !Number.isInteger(value)) throw new FieldError("Must be a whole number.");
  if (schema.minimum !== undefined && value < schema.minimum) throw new FieldError(`Must be at least ${schema.minimum}.`);
  if (schema.maximum !== undefined && value > schema.maximum) throw new FieldError(`Must be at most ${schema.maximum}.`);
  if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) throw new FieldError(`Must be more than ${schema.exclusiveMinimum}.`);
  if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) throw new FieldError(`Must be less than ${schema.exclusiveMaximum}.`);
}

function checkArray(values, schema) {
  if (schema.minItems !== undefined && values.length < schema.minItems) throw new FieldError(`Needs at least ${schema.minItems} item${schema.minItems === 1 ? "" : "s"}.`);
  if (schema.maxItems !== undefined && values.length > schema.maxItems) throw new FieldError(`Takes at most ${schema.maxItems} items.`);
  if (schema.uniqueItems && new Set(values).size !== values.length) throw new FieldError("Items must be distinct.");
  for (const value of values) {
    try {
      checkString(value, schema.items ?? {});
    } catch (error) {
      throw new FieldError(`${JSON.stringify(value)}: ${error.message}`);
    }
  }
}

/** A JSON value shaped like `schema`, for prefilling a required JSON field. */
function skeleton(schema) {
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum)) return schema.enum[0];
  switch (schema.type) {
    case "object": {
      const value = {};
      for (const key of schema.required ?? []) value[key] = skeleton(schema.properties?.[key] ?? {});
      return value;
    }
    case "array":
      return [];
    case "string":
      return "";
    case "integer":
    case "number":
      return schema.minimum ?? 0;
    case "boolean":
      return false;
    default:
      return null;
  }
}

/**
 * An editable list of strings, one input per item: Enter adds an item, pasting lines adds one per
 * line. (For short words shown as removable chips, use `chipsInput` from ./inputs.js.)
 * @param {{id?: string, values?: string[], placeholder?: string, addLabel?: string, describedBy?: string}} options
 * @returns {{element: HTMLElement, read: () => string[], set: (values: string[]) => void}}
 */
export function stringList({ id, values = [], placeholder = "", addLabel = "Add", describedBy }) {
  const rows = h("ul", { class: "list-rows" });
  const addRow = (value = "", focus = false) => {
    const input = h("input", { type: "text", value, placeholder, "aria-describedby": describedBy });
    const row = h(
      "li",
      {},
      input,
      h("button", {
        type: "button",
        class: "button ghost icon-only small",
        "aria-label": "Remove",
        title: "Remove",
        text: "×",
        onclick: () => {
          row.remove();
          if (!rows.children.length) addRow();
        },
      }),
    );
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        addRow("", true);
      }
    });
    input.addEventListener("paste", (event) => {
      const text = event.clipboardData.getData("text");
      if (!text.includes("\n")) return;
      event.preventDefault();
      const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      if (!lines.length) return;
      input.value = lines[0];
      let after = row;
      for (const line of lines.slice(1)) {
        addRow(line);
        const added = rows.lastElementChild;
        after.after(added);
        after = added;
      }
    });
    rows.append(row);
    if (focus) input.focus();
  };
  for (const value of values) addRow(value);
  if (!values.length) addRow();
  const element = h(
    "div",
    { class: "list-editor", id },
    rows,
    h("button", { type: "button", class: "button small", text: addLabel, onclick: () => addRow("", true) }),
  );
  return {
    element,
    read: () => [...rows.querySelectorAll("input")].map((input) => input.value.trim()).filter(Boolean),
    set(next) {
      rows.replaceChildren();
      for (const value of next) addRow(value);
      if (!next.length) addRow();
    },
  };
}

function field(name, schema, required) {
  const id = nextId(`field-${name}`);
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const kind = kindOf(name, schema);
  const label = schema.title ?? humanize(name);
  const marker = required ? h("span", { class: "required", "aria-hidden": "true", text: "*" }) : null;
  const hint = schema.description ? h("p", { class: "hint", id: hintId, text: schema.description }) : null;
  const error = h("p", { class: "field-error", id: errorId, role: "alert", hidden: true });
  const describedBy = [hint ? hintId : null, errorId].filter(Boolean).join(" ");
  const common = { id, "aria-describedby": describedBy, "aria-required": required ? "true" : null };
  let control;
  let read;
  let set;
  let grouped = false;

  const missing = () => {
    if (required) throw new FieldError("Required.");
    return undefined;
  };

  switch (kind) {
    case "text":
    case "longtext":
    case "date": {
      control =
        kind === "longtext"
          ? h("textarea", { ...common, rows: 4 })
          : h("input", { ...common, type: kind === "date" ? "date" : "text", spellcheck: kind === "text" ? "false" : null });
      if (schema.default !== undefined) control.value = schema.default;
      read = () => {
        if (control.value === "") return missing();
        checkString(control.value, schema);
        return control.value;
      };
      set = (value) => {
        control.value = value ?? "";
      };
      break;
    }
    case "number": {
      control = h("input", {
        ...common,
        type: "number",
        inputmode: schema.type === "integer" ? "numeric" : "decimal",
        step: schema.type === "integer" ? "1" : "any",
        min: schema.minimum !== undefined ? String(schema.minimum) : null,
        max: schema.maximum !== undefined ? String(schema.maximum) : null,
      });
      if (schema.default !== undefined) control.value = String(schema.default);
      read = () => {
        if (control.value.trim() === "") return missing();
        const value = Number(control.value);
        if (!Number.isFinite(value)) throw new FieldError("Must be a number.");
        checkNumber(value, schema);
        return value;
      };
      set = (value) => {
        control.value = value === undefined ? "" : String(value);
      };
      break;
    }
    case "boolean": {
      if (required) {
        control = h("input", { ...common, type: "checkbox", checked: schema.default === true });
        read = () => control.checked;
        set = (value) => {
          control.checked = value === true;
        };
      } else {
        control = h(
          "select",
          common,
          h("option", { value: "", text: "Not set" }),
          h("option", { value: "true", text: "Yes" }),
          h("option", { value: "false", text: "No" }),
        );
        if (schema.default !== undefined) control.value = String(schema.default);
        read = () => (control.value === "" ? undefined : control.value === "true");
        set = (value) => {
          control.value = value === undefined ? "" : String(value);
        };
      }
      break;
    }
    case "enum": {
      control = h(
        "select",
        common,
        h("option", { value: "", text: required ? "Choose…" : "Not set", disabled: required }),
        schema.enum.map((value, index) => h("option", { value: String(index), text: String(value) })),
      );
      const indexOf = (value) => schema.enum.findIndex((option) => JSON.stringify(option) === JSON.stringify(value));
      control.value = schema.default !== undefined && indexOf(schema.default) >= 0 ? String(indexOf(schema.default)) : "";
      read = () => (control.value === "" ? missing() : schema.enum[Number(control.value)]);
      set = (value) => {
        control.value = value === undefined || indexOf(value) < 0 ? "" : String(indexOf(value));
      };
      break;
    }
    case "list": {
      grouped = true;
      const list = stringList({ id, values: schema.default ?? [], describedBy, addLabel: `Add ${humanize(name).toLowerCase()}` });
      control = list.element;
      read = () => {
        const values = list.read();
        if (!values.length && !required) return undefined;
        checkArray(values, schema);
        return values;
      };
      set = (value) => list.set(value ?? []);
      break;
    }
    case "checks": {
      grouped = true;
      const boxes = schema.items.enum.map((value) => ({ value, input: h("input", { type: "checkbox", checked: (schema.default ?? []).includes(value) }) }));
      control = h("div", { class: "checks", id }, boxes.map(({ value, input }) => h("label", { class: "check" }, input, String(value))));
      read = () => {
        const values = boxes.filter(({ input }) => input.checked).map(({ value }) => value);
        if (!values.length && !required) return undefined;
        checkArray(values, schema);
        return values;
      };
      set = (value) => {
        for (const box of boxes) box.input.checked = (value ?? []).includes(box.value);
      };
      break;
    }
    default: {
      control = h("textarea", { ...common, class: "code", rows: 5, spellcheck: "false" });
      if (schema.default !== undefined || required) control.value = JSON.stringify(skeleton(schema), null, 2);
      read = () => {
        if (control.value.trim() === "") return missing();
        let value;
        try {
          value = JSON.parse(control.value);
        } catch (parseError) {
          throw new FieldError(`Not valid JSON: ${parseError.message}`);
        }
        const actual = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
        if (schema.type === "object" && actual !== "object") throw new FieldError(`Must be a JSON object, not ${actual}.`);
        if (schema.type === "array" && actual !== "array") throw new FieldError(`Must be a JSON array, not ${actual}.`);
        return value;
      };
      set = (value) => {
        control.value = value === undefined ? "" : JSON.stringify(value, null, 2);
      };
    }
  }

  let element;
  if (grouped) {
    element = h("fieldset", { class: "field" }, h("legend", {}, label, marker), hint, control, error);
  } else if (kind === "boolean" && required) {
    element = h("div", { class: "field" }, h("label", { class: "check", for: id }, control, label, marker), hint, error);
  } else {
    element = h("div", { class: "field" }, h("label", { for: id }, label, marker), control, hint, error);
  }
  if (kind === "json") element.classList.add("wide");
  return {
    name,
    element,
    set,
    read() {
      error.hidden = true;
      element.classList.remove("invalid");
      try {
        return read();
      } catch (problem) {
        if (!(problem instanceof FieldError)) throw problem;
        error.textContent = problem.message;
        error.hidden = false;
        element.classList.add("invalid");
        throw problem;
      }
    },
    focus: () => (element.querySelector("input, select, textarea") ?? element).focus(),
  };
}

/**
 * A form for an object JSON Schema (string, number, integer, boolean, enum, arrays of strings,
 * anything else as JSON). For developer views: a designed page asks in its users' words instead.
 * @param {object} schema A task's `inputSchema`.
 * @returns {{element: HTMLElement, hasRequired: boolean, read: () => object, set: (values: object) => void}}
 *   `read()` returns the arguments, or focuses the first invalid field and throws.
 */
export function schemaForm(schema) {
  if (!schema || schema.type !== "object") throw new Error("A task's inputSchema must be an object schema.");
  const required = new Set(schema.required ?? []);
  const fields = Object.entries(schema.properties ?? {}).map(([name, property]) => field(name, property, required.has(name)));
  const element = h(
    "div",
    { class: "fields" },
    fields.length ? fields.map((one) => one.element) : h("p", { class: "muted", text: "This task takes no input." }),
  );
  return {
    element,
    hasRequired: required.size > 0,
    read() {
      const value = {};
      let first = null;
      for (const one of fields) {
        try {
          const item = one.read();
          if (item !== undefined) value[one.name] = item;
        } catch (problem) {
          if (!(problem instanceof FieldError)) throw problem;
          first ??= one;
        }
      }
      if (first) {
        first.focus();
        throw new Error("Fix the highlighted fields.");
      }
      return value;
    },
    set(values) {
      for (const one of fields) one.set(values[one.name]);
    },
  };
}
