// Inputs a designed page asks its users with: labelled fields, segmented choices, chips, a
// stepper, a date with quick picks, a file drop that writes to the workspace, and copy buttons.
// Each returns `{element, ...}` with a small API to read, set and disable it.

import { disclosure } from "./display.js";
import { formatSize, h, icon, nextId } from "./dom.js";
import { listFiles, readText, writeText } from "./workspace.js";

/**
 * A label, a control, a hint and an inline error, laid out as one field.
 * @param {{label: string, control: HTMLElement, body?: HTMLElement, hint?: string|Node, optional?: boolean}} options
 *   The control gets an id (if it has none) and `aria-describedby` for the hint and error.
 *   `body`, when given, is shown in the control's place and holds it (e.g. a row of buttons around it).
 * @returns {{element: HTMLElement, setError: (message: string|null) => void, setHint: (hint: string|Node|null) => void}}
 */
export function labeled({ label, control, body = control, hint, optional = false }) {
  control.id ||= nextId("input");
  const hintLine = h("p", { class: "hint", id: `${control.id}-hint`, hidden: !hint }, hint ?? "");
  const error = h("p", { class: "field-error", id: `${control.id}-error`, role: "alert", hidden: true });
  control.setAttribute("aria-describedby", `${hintLine.id} ${error.id}`);
  const element = h("div", { class: "field" }, h("label", { for: control.id }, label, optional ? h("span", { class: "muted", text: " (optional)" }) : null), body, hintLine, error);
  return {
    element,
    setError(message) {
      error.textContent = message ?? "";
      error.hidden = !message;
      element.classList.toggle("invalid", Boolean(message));
      control.setAttribute("aria-invalid", message ? "true" : "false");
    },
    setHint(next) {
      hintLine.replaceChildren(next ?? "");
      hintLine.hidden = !next;
    },
  };
}

/**
 * One choice out of a few, as a row of segments (radio buttons), e.g. "One meal | A whole day",
 * "White | Black", or filter chips with counts ("All 9 | Hallucinated 6 | Real 3").
 * @param {object} options
 * @param {string} options.label The group's accessible name (shown when `showLabel`).
 * @param {Array<{value: string, label: string, count?: number, disabled?: boolean}>} options.options
 * @param {string} [options.value] The initially chosen value (default the first).
 * @param {(value: string) => void} [options.onChange]
 * @param {boolean} [options.showLabel] Show `label` above the segments (default false).
 * @param {"segments"|"chips"} [options.look] Joined segments (default) or separate pills that wrap.
 * @returns {{element: HTMLElement, value: () => string, set: (value: string) => void, setCounts: (counts: Object<string, number>) => void, setDisabled: (disabled: boolean) => void}}
 */
export function segmented({ label, options, value = options[0]?.value, onChange, showLabel = false, look = "segments" }) {
  const name = nextId("choice");
  let current = value;
  const counts = new Map();
  const inputs = options.map((option) => {
    const input = h("input", { type: "radio", name, value: option.value, checked: option.value === value, disabled: option.disabled });
    const count = h("span", { class: "segment-count", hidden: option.count === undefined, text: option.count ?? "" });
    counts.set(option.value, count);
    input.addEventListener("change", () => {
      if (!input.checked) return;
      current = option.value;
      onChange?.(current);
    });
    return { input, element: h("label", { class: "segment" }, input, h("span", { class: "segment-text" }, option.label, count)) };
  });
  const group = h("div", { class: `segmented look-${look}`, role: "radiogroup", "aria-label": label }, inputs.map((one) => one.element));
  const element = showLabel ? h("div", { class: "field" }, h("span", { class: "field-label", text: label }), group) : group;
  return {
    element,
    value: () => current,
    set(next) {
      const match = inputs.find((one) => one.input.value === next);
      if (!match) throw new Error(`${label}: no option ${JSON.stringify(next)}.`);
      match.input.checked = true;
      current = next;
    },
    setCounts(next) {
      for (const [key, count] of Object.entries(next)) {
        const node = counts.get(key);
        if (!node) continue;
        node.textContent = String(count);
        node.hidden = false;
      }
    },
    setDisabled(disabled) {
      inputs.forEach((one, index) => (one.input.disabled = disabled || Boolean(options[index].disabled)));
    },
  };
}

/**
 * Several on/off choices as toggle chips (`aria-pressed`), e.g. "Breakfast · Lunch · Dinner" or
 * "Meatless · Vegan · No desserts".
 * @param {{label: string, options: Array<{value: string, label: string, hint?: string}>, values?: string[], onChange?: (values: string[]) => void}} options
 *   `hint` becomes the chip's tooltip.
 * @returns {{element: HTMLElement, values: () => string[], set: (values: string[]) => void, setDisabled: (disabled: boolean) => void}}
 */
export function chipToggles({ label, options, values = [], onChange }) {
  const chosen = new Set(values);
  const buttons = options.map((option) => {
    const button = h("button", { type: "button", class: "chip toggle", "aria-pressed": String(chosen.has(option.value)), title: option.hint }, h("span", { class: "chip-check" }, icon("check", { size: 14 })), option.label);
    button.addEventListener("click", () => {
      if (chosen.has(option.value)) chosen.delete(option.value);
      else chosen.add(option.value);
      button.setAttribute("aria-pressed", String(chosen.has(option.value)));
      onChange?.(read());
    });
    return button;
  });
  const read = () => options.map((option) => option.value).filter((key) => chosen.has(key));
  return {
    element: h("div", { class: "chips", role: "group", "aria-label": label }, buttons),
    values: read,
    set(next) {
      chosen.clear();
      for (const key of next) chosen.add(key);
      buttons.forEach((button, index) => button.setAttribute("aria-pressed", String(chosen.has(options[index].value))));
    },
    setDisabled(disabled) {
      for (const button of buttons) button.disabled = disabled;
    },
  };
}

/**
 * A row of clickable chips that do one thing each: presets ("Win the queen"), quick picks
 * ("Last full week"), examples ("Attention Is All You Need"), saved runs ("Oct 2 · 7 fell ✓").
 * Scrolls sideways on narrow screens instead of wrapping when `scroll` is set.
 * @param {{label: string, items: Array<{label: string|Node, value?: unknown, title?: string, tone?: string, selected?: boolean}>, onPick: (item: object) => void, scroll?: boolean}} options
 * @returns {{element: HTMLElement, setItems: (items: object[]) => void, select: (value: unknown) => void, setDisabled: (disabled: boolean) => void}}
 */
export function chipRow({ label, items, onPick, scroll = false }) {
  const element = h("div", { class: `chips${scroll ? " scroll" : ""}`, role: "group", "aria-label": label });
  let current = items;
  let disabled = false;
  const render = () => {
    element.replaceChildren(
      ...current.map((item) =>
        h(
          "button",
          { type: "button", class: `chip${item.tone ? ` tone-${item.tone}` : ""}`, title: item.title, "aria-pressed": item.selected === undefined ? null : String(item.selected), disabled, onclick: () => onPick(item) },
          item.label,
        ),
      ),
    );
  };
  render();
  return {
    element,
    setItems(next) {
      current = next;
      render();
    },
    select(value) {
      current = current.map((item) => ({ ...item, selected: item.value === value }));
      render();
    },
    setDisabled(next) {
      disabled = next;
      render();
    },
  };
}

/**
 * A list of short strings as removable chips with an "add" box: Enter or a comma adds, Backspace
 * in the empty box removes the last; e.g. people to follow, foods you love.
 * @param {object} options
 * @param {string} options.label
 * @param {string[]} [options.values]
 * @param {string} [options.placeholder]
 * @param {string} [options.hint]
 * @param {(value: string, values: string[]) => string|null} [options.validate] A plain-words
 *   reason to refuse `value`, or null to accept it. Blank values and exact duplicates are always refused.
 * @param {(values: string[]) => void} [options.onChange]
 * @returns {{element: HTMLElement, values: () => string[], set: (values: string[]) => void, setDisabled: (disabled: boolean) => void, focus: () => void}}
 */
export function chipsInput({ label, values = [], placeholder = "Add…", hint, validate, onChange }) {
  let items = [...values];
  const list = h("ul", { class: "chip-list" });
  const input = h("input", { type: "text", class: "chip-input", placeholder, "aria-label": `Add to ${label}` });
  const box = h("div", { class: "chips-input" }, list, input);
  const field = labeled({ label, control: input, body: box, hint });
  box.addEventListener("click", (event) => {
    if (event.target === box) input.focus();
  });

  const render = () => {
    list.replaceChildren(
      ...items.map((item, index) =>
        h(
          "li",
          { class: "chip static" },
          h("span", { text: item }),
          h("button", {
            type: "button",
            class: "chip-remove",
            "aria-label": `Remove ${item}`,
            disabled: input.disabled,
            onclick: () => {
              items.splice(index, 1);
              render();
              onChange?.([...items]);
              input.focus();
            },
          }, icon("close", { size: 14 })),
        ),
      ),
    );
  };
  const add = () => {
    const value = input.value.replace(/,$/, "").trim();
    if (!value) return;
    const reason = items.includes(value) ? `${value} is already in the list.` : validate?.(value, [...items]) ?? null;
    field.setError(reason);
    if (reason) return;
    items.push(value);
    input.value = "";
    render();
    onChange?.([...items]);
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      add();
    } else if (event.key === "Backspace" && !input.value && items.length) {
      items.pop();
      render();
      onChange?.([...items]);
    }
  });
  input.addEventListener("input", () => field.setError(null));
  input.addEventListener("blur", add);
  render();
  return {
    element: field.element,
    values: () => [...items],
    set(next) {
      items = [...next];
      render();
    },
    setDisabled(disabled) {
      input.disabled = disabled;
      box.classList.toggle("disabled", disabled);
      render();
    },
    focus: () => input.focus(),
  };
}

/**
 * A whole number with − and + buttons, kept between `min` and `max`; e.g. "Up to [−] 2 [+] servings".
 * @param {{label: string, value?: number, min?: number, max?: number, step?: number, unit?: string, hint?: string, onChange?: (value: number) => void}} options
 *   `unit` is a word after the number ("servings").
 * @returns {{element: HTMLElement, value: () => number, set: (value: number) => void, setDisabled: (disabled: boolean) => void}}
 */
export function numberStepper({ label, value = 1, min = 0, max = 100, step = 1, unit, hint, onChange }) {
  let current = value;
  const input = h("input", { type: "number", class: "stepper-input", inputmode: "numeric", min: String(min), max: String(max), step: String(step), value: String(value) });
  const down = h("button", { type: "button", class: "button icon-only", "aria-label": `Fewer ${unit ?? ""}`.trim() }, icon("minus", { size: 16 }));
  const up = h("button", { type: "button", class: "button icon-only", "aria-label": `More ${unit ?? ""}`.trim() }, icon("plus", { size: 16 }));
  const box = h("div", { class: "stepper" }, down, input, up, unit ? h("span", { class: "muted", text: unit }) : null);
  const field = labeled({ label, control: input, body: box, hint });
  const set = (next, notify) => {
    current = Math.min(max, Math.max(min, Math.round(next / step) * step));
    input.value = String(current);
    down.disabled = input.disabled || current <= min;
    up.disabled = input.disabled || current >= max;
    if (notify) onChange?.(current);
  };
  down.addEventListener("click", () => set(current - step, true));
  up.addEventListener("click", () => set(current + step, true));
  input.addEventListener("change", () => set(Number.isFinite(Number(input.value)) && input.value !== "" ? Number(input.value) : current, true));
  set(value, false);
  return {
    element: field.element,
    value: () => current,
    set: (next) => set(next, false),
    setDisabled(disabled) {
      input.disabled = disabled;
      set(current, false);
    },
  };
}

/**
 * A date (YYYY-MM-DD) with quick-pick chips, a caption, and inline checks that offer a one-click fix.
 * @param {object} options
 * @param {string} options.label
 * @param {string} [options.value] YYYY-MM-DD.
 * @param {string} [options.min] YYYY-MM-DD.
 * @param {string} [options.max] YYYY-MM-DD.
 * @param {Array<{label: string, value: string}>} [options.chips] e.g. "Yesterday", "Last full week".
 * @param {string} [options.caption] A muted line under the input (e.g. "arXiv time (UTC)").
 * @param {(value: string) => (null|{message: string, fix?: {label: string, value: string}})} [options.check]
 *   A plain-words problem with the date (and a better date to offer), or null when it is fine.
 * @param {(value: string) => void} [options.onChange]
 * @returns {{element: HTMLElement, value: () => string, set: (value: string) => void, valid: () => boolean, setCaption: (text: string) => void, setDisabled: (disabled: boolean) => void}}
 */
export function dateInput({ label, value = "", min, max, chips = [], caption, check, onChange }) {
  const input = h("input", { type: "date", class: "input date", value, min, max });
  const problem = h("div", { class: "inline-problem", role: "alert", hidden: true });
  const quick = chips.length
    ? chipRow({ label: `${label}: quick picks`, items: chips.map((chip) => ({ ...chip, selected: chip.value === value })), onPick: (chip) => update(chip.value, true) })
    : null;
  const row = h("div", { class: "date-row" }, input, quick?.element);
  const field = labeled({ label, control: input, body: row, hint: caption });
  field.element.insertBefore(problem, field.element.querySelector(".field-error"));
  let ok = true;
  const validate = () => {
    const found = !input.value ? { message: "Pick a date." } : check?.(input.value) ?? null;
    ok = !found;
    field.element.classList.toggle("invalid", !ok);
    problem.hidden = ok;
    if (found) {
      problem.replaceChildren(
        icon("alert", { size: 16 }),
        h("span", { text: found.message }),
        found.fix ? h("button", { type: "button", class: "button small", text: found.fix.label, onclick: () => update(found.fix.value, true) }) : null,
      );
    }
  };
  const update = (next, notify) => {
    input.value = next;
    quick?.select(next);
    validate();
    if (notify) onChange?.(next);
  };
  input.addEventListener("change", () => update(input.value, true));
  validate();
  return {
    element: field.element,
    value: () => input.value,
    set: (next) => update(next, false),
    valid: () => ok,
    setCaption: (text) => field.setHint(text),
    setDisabled(disabled) {
      input.disabled = disabled;
      quick?.setDisabled(disabled);
      for (const button of problem.querySelectorAll("button")) button.disabled = disabled;
    },
  };
}

/**
 * Today's date as YYYY-MM-DD in a time zone (default the viewer's), plus `days` (may be negative).
 * @example isoDate({timeZone: "America/New_York", days: -1}) // yesterday in New York
 * @param {{timeZone?: string, days?: number}} [options]
 * @returns {string}
 */
export function isoDate({ timeZone, days = 0 } = {}) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  if (!days) return today;
  const date = new Date(`${today}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * Pick a file already in the workspace, from a menu filtered by extension.
 * @param {{label?: string, extensions?: string[], exclude?: string[], onPick: (file: {path: string, size: number}) => void}} options
 *   `exclude` hides paths (e.g. the destination itself).
 * @returns {{element: HTMLElement, refresh: () => Promise<void>, setDisabled: (disabled: boolean) => void}}
 */
export function workspacePicker({ label = "Use a file from your workspace", extensions, exclude = [], onPick }) {
  const select = h("select", { class: "input", "aria-label": label }, h("option", { value: "", text: label }));
  let files = [];
  select.addEventListener("change", () => {
    const file = files.find((one) => one.path === select.value);
    select.value = "";
    if (file) onPick(file);
  });
  const element = h("div", { class: "workspace-picker", hidden: true }, select);
  return {
    element,
    async refresh() {
      files = (await listFiles({ extensions })).filter((file) => !exclude.includes(file.path));
      select.replaceChildren(h("option", { value: "", text: label }), ...files.map((file) => h("option", { value: file.path, text: `${file.path} · ${formatSize(file.size)}` })));
      element.hidden = files.length === 0;
    },
    setDisabled(disabled) {
      select.disabled = disabled;
    },
  };
}

/**
 * A card-sized drop zone for one input file the task reads from a fixed workspace path. The user
 * drops or chooses a file, pastes its text, or picks a file already in the workspace; the zone
 * checks it with `inspect` and writes it to `path` with `workspace.write` right away, so a problem
 * shows on this card. Only UTF-8 text files are taken.
 *
 * @param {object} options
 * @param {string} options.title The card's title, e.g. "Bibliography to check".
 * @param {string} options.path Where the file goes, e.g. "inputs/raw.bib".
 * @param {string[]} [options.extensions] Accepted endings, e.g. [".bib"]; also filters the workspace menu.
 * @param {string} [options.description] One line on what to drop.
 * @param {number} [options.maxBytes] Default 5 MB.
 * @param {(text: string, name: string) => string} [options.inspect] Throws an Error with a plain
 *   message when the text is unusable; returns a short summary such as "about 9 entries".
 * @param {boolean} [options.paste] Offer "Paste text" (default true).
 * @param {boolean} [options.pickExisting] Offer workspace files (default true).
 * @param {(state: null|{path: string, name: string, size: number, summary: string, origin: string, text: string}) => void} [options.onChange]
 * @returns {{element: HTMLElement, value: () => null|object, useText: (text: string, name: string, origin?: string) => Promise<boolean>, restore: () => Promise<boolean>, clear: () => void, setSummary: (summary: string) => void, setError: (message: string|null) => void, setDisabled: (disabled: boolean) => void}}
 */
export function fileDrop({ title, path, extensions = [], description, maxBytes = 5 * 1024 * 1024, inspect = () => "", paste = true, pickExisting = true, onChange }) {
  let state = null;
  let disabled = false;
  const fileInput = h("input", { type: "file", class: "visually-hidden", tabindex: "-1", accept: extensions.join(",") || null });
  const error = h("p", { class: "field-error", role: "alert", hidden: true });
  const status = h("div", { class: "drop-status", hidden: true });
  const zone = h(
    "button",
    { type: "button", class: "drop-zone", onclick: () => fileInput.click() },
    h("span", { class: "drop-icon" }, icon("upload", { size: 22 })),
    h("span", { class: "drop-main" }, h("strong", { text: "Drop a file here" }), " or choose one"),
    description ? h("span", { class: "muted small-text", text: description }) : null,
  );
  const pasteBox = h("textarea", { class: "input code", rows: 6, placeholder: "Paste the file's text here", "aria-label": `${title}: paste text` });
  const pasteArea = paste
    ? disclosure({ summary: "Paste text instead" }, pasteBox, h("button", { type: "button", class: "button small", text: "Use this text", onclick: () => useText(pasteBox.value, "Pasted text", "pasted") }))
    : null;
  const picker = pickExisting
    ? workspacePicker({
        extensions: extensions.length ? extensions : undefined,
        exclude: [path],
        onPick: async (file) => {
          try {
            await useText(await readText(file.path), file.path.split("/").pop(), "workspace");
          } catch (problem) {
            setError(`Couldn't read ${file.path}: ${problem.message}`);
          }
        },
      })
    : null;
  const choose = h("div", { class: "drop-choose" }, zone, pasteArea, picker?.element);

  const setError = (message) => {
    error.textContent = message ?? "";
    error.hidden = !message;
    element.classList.toggle("invalid", Boolean(message));
  };
  const renderStatus = () => {
    choose.hidden = Boolean(state);
    status.hidden = !state;
    if (!state) return;
    status.replaceChildren(
      h("span", { class: "drop-icon ok" }, icon("file", { size: 20 })),
      h(
        "div",
        { class: "drop-file" },
        h("strong", { class: "drop-name", text: state.name }),
        h("span", { class: "muted small-text", text: [formatSize(state.size), state.summary, state.origin === "workspace" ? "from your workspace" : ""].filter(Boolean).join(" · ") }),
      ),
      h("button", { type: "button", class: "button ghost small", text: "Replace", disabled, onclick: () => clear(true) }),
    );
  };
  const clear = (focus = false) => {
    state = null;
    renderStatus();
    onChange?.(null);
    if (focus) zone.focus();
  };

  async function useText(text, name, origin = "file") {
    setError(null);
    const size = new TextEncoder().encode(text).length;
    const refuse = (message) => {
      setError(message);
      return false;
    };
    if (!text.trim()) return refuse("That's empty: there's nothing to use.");
    if (size > maxBytes) return refuse(`This file is too large to use here (over ${formatSize(maxBytes)}).`);
    let summary;
    try {
      summary = inspect(text, name);
    } catch (problem) {
      return refuse(problem.message);
    }
    try {
      await writeText(path, text);
    } catch (problem) {
      return refuse(`Couldn't save this file to your workspace: ${problem.message}`);
    }
    state = { path, name, size, summary, origin, text };
    renderStatus();
    onChange?.({ ...state });
    return true;
  }

  async function takeFile(file) {
    if (extensions.length && !extensions.some((ending) => file.name.toLowerCase().endsWith(ending))) {
      setError(`Choose a ${extensions.join(" or ")} file.`);
      return;
    }
    if (file.size > maxBytes) {
      setError(`This file is too large to use here (over ${formatSize(maxBytes)}).`);
      return;
    }
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
    } catch {
      setError("This doesn't look like a UTF-8 text file. Save it as UTF-8 and try again.");
      return;
    }
    await useText(text, file.name, "file");
  }

  fileInput.addEventListener("change", () => {
    if (fileInput.files[0]) takeFile(fileInput.files[0]);
    fileInput.value = "";
  });
  for (const name of ["dragenter", "dragover"]) {
    zone.addEventListener(name, (event) => {
      event.preventDefault();
      if (!disabled) zone.classList.add("over");
    });
  }
  for (const name of ["dragleave", "drop"]) zone.addEventListener(name, () => zone.classList.remove("over"));
  zone.addEventListener("drop", (event) => {
    event.preventDefault();
    if (!disabled && event.dataTransfer.files[0]) takeFile(event.dataTransfer.files[0]);
  });

  const element = h("section", { class: "card drop-card", "aria-label": title }, h("h2", { class: "drop-title", text: title }), choose, status, error, fileInput);
  picker?.refresh().catch(() => {});
  return {
    element,
    value: () => (state ? { ...state } : null),
    useText,
    /** Show the file already at `path` (from an earlier visit) as chosen; false when there is none. */
    async restore() {
      const files = await listFiles({ prefix: path });
      const file = files.find((one) => one.path === path);
      if (!file) return false;
      const text = await readText(path);
      let summary = "";
      try {
        summary = inspect(text, path.split("/").pop());
      } catch (problem) {
        setError(problem.message);
        return false;
      }
      state = { path, name: path.split("/").pop(), size: file.size, summary, origin: "workspace", text };
      renderStatus();
      onChange?.({ ...state });
      return true;
    },
    clear: () => clear(false),
    setSummary(summary) {
      if (!state) return;
      state.summary = summary;
      renderStatus();
    },
    setError,
    setDisabled(next) {
      disabled = next;
      zone.disabled = next;
      pasteBox.disabled = next;
      for (const button of pasteArea?.querySelectorAll("button") ?? []) button.disabled = next;
      picker?.setDisabled(next);
      renderStatus();
    },
  };
}

/**
 * Copy text to the clipboard. The sandboxed frame may refuse the clipboard; then this throws, and
 * callers say so (see {@link copyButton}) rather than pretend it worked.
 * @param {string} text
 * @returns {Promise<void>}
 */
export async function copyText(text) {
  if (!navigator.clipboard?.writeText) throw new Error("The clipboard isn't available in this frame.");
  await navigator.clipboard.writeText(text);
}

/**
 * A "Copy" button. When the frame refuses the clipboard it shows the text selected in a read-only
 * box with "Press Ctrl+C (⌘C on a Mac) to copy", since links can't be opened from the sandbox.
 * @param {{text: string|(() => string), label?: string, iconOnly?: boolean}} options
 * @returns {HTMLElement}
 */
export function copyButton({ text, label = "Copy", iconOnly = false }) {
  const fallback = h("div", { class: "copy-fallback", hidden: true });
  const button = h("button", { type: "button", class: `button ghost small${iconOnly ? " icon-only" : ""}`, "aria-label": iconOnly ? label : null, title: iconOnly ? label : null }, icon("copy", { size: 15 }), iconOnly ? null : h("span", { text: label }));
  button.addEventListener("click", async () => {
    const value = typeof text === "function" ? text() : text;
    try {
      await copyText(value);
      const before = button.lastChild.textContent;
      if (!iconOnly) button.lastChild.textContent = "Copied";
      button.classList.add("done");
      setTimeout(() => {
        if (!iconOnly) button.lastChild.textContent = before;
        button.classList.remove("done");
      }, 1600);
    } catch {
      const box = h("input", { type: "text", class: "input", readonly: true, value, "aria-label": "Text to copy" });
      fallback.replaceChildren(box, h("span", { class: "muted small-text", text: "Copying isn't allowed here. Press Ctrl+C (⌘C on a Mac) to copy." }));
      fallback.hidden = false;
      box.focus();
      box.select();
    }
  });
  return h("span", { class: "copy" }, button, fallback);
}

/**
 * A value people may want to take elsewhere (a link, an id, a FEN) as selectable text with a Copy
 * button. The sandbox has no popups, so links are shown this way rather than opened.
 * @param {{label: string, value: string}} options
 * @returns {HTMLElement}
 */
export function copyField({ label, value }) {
  return h("div", { class: "copy-field" }, h("span", { class: "muted small-text", text: label }), h("code", { class: "copy-value", text: value }), copyButton({ text: value, iconOnly: true, label: `Copy ${label.toLowerCase()}` }));
}
