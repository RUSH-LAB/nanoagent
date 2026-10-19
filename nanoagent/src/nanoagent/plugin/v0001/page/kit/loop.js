// A turn's agent loop as the chat shows it (kit/chat.js): each part of its provenance graph
// (nanoagent.plugin.provenance), in the order the run made it, one row named by its part,
// "Thinking › …", "Tool call › …", "Response › …", each shown as its part says (kit/parts.js,
// its `chat`, `hue` and `font`). A task's own run is indented under its call.

import { h, icon } from "./dom.js";
import { applyPatch, nameOf, partOf } from "./graph.js";
import { markdown } from "./markdown.js";
import { TYPES } from "./parts.js";
import { formatSeconds, runStats } from "./session.js";

const STEPS = "steps"; // the key of whether the turn's Steps row is open, beside each task's id
/** A tool's output, which is JSON text, as the value it holds; other text as it is. */
const parsed = (value) => {
  if (typeof value !== "string" || !/^\s*[[{]/.test(value)) return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};
/** A value on one line: text as it is, and an object's fields as `name value`. */
const inline = (value) => {
  value = parsed(value);
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.entries(value)
      .map(([key, field]) => `${key} ${JSON.stringify(field)}`)
      .join(", ");
  }
  return JSON.stringify(value);
};

/**
 * One row of the part `part` (kit/parts.js): its name, `›`, and what it holds on one line,
 * opening to all of it; or, for a part shown whole, all of it as Markdown; in its hue and font.
 * @param {{label: string, hue: string, font: string}} part
 * @param {{text?: string|Node[], whole?: string, full?: Node, meta?: Node|string|null, classes?: string}} content
 */
export function partRow(part, { text = "", whole = null, full = null, meta = null, classes = "" }) {
  const head = [h("span", { class: "part-label", text: part.label })];
  const li = (kind, ...children) => h("li", { class: `part ${kind} ${classes}`, "data-hue": part.hue, "data-font": part.font }, ...children);
  if (whole !== null) return li("whole", ...head, h("div", { class: "part-whole" }, markdown(whole)));
  const body = full ? h("div", { class: "part-full", hidden: true }, full) : null;
  const line = h("span", { class: "part-text" }, text);
  const after = meta ? h("span", { class: "part-meta", text: typeof meta === "string" ? meta : null }, typeof meta === "string" ? null : meta) : null;
  if (!body) return li("", ...head, line, after);
  const toggle = h("button", { type: "button", class: "part-open", "aria-expanded": "false" }, ...head, line);
  toggle.addEventListener("click", () => {
    body.hidden = !body.hidden;
    toggle.setAttribute("aria-expanded", String(!body.hidden));
  });
  return li("", toggle, after, body);
}

/** All of a value, for its row's opened part. */
const fullValue = (value) => {
  value = parsed(value);
  return h("pre", { class: typeof value === "string" ? "part-stream" : "", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) });
};

/**
 * A turn's loop, kept current while its graph's patches stream in. `apply(patch)`,
 * `replace(graph)` and `settle()` are as kit/graph.js's graphView's.
 * @returns {{element: HTMLElement, apply: (patch: object) => void, replace: (graph: object) => void, settle: () => void}}
 * @param {object} options
 * @param {boolean} options.first Whether the turn is its session's first, which shows the system prompt.
 * @param {(task: string) => string} options.names A task's name by its id.
 * @param {(name: string, output: string) => ((focus: boolean) => void)|null} options.result What draws a task's
 *   result (its tool result's `output`) beside the chat, made once per result, or null when it has none to draw.
 * @param {(draw: (focus: boolean) => void) => void} [options.onResult] Called with what draws each result as it is made.
 */
export function loopView({ first, names, result, onResult = () => {} }) {
  let graph = { nodes: [], edges: [] };
  let settled = false;
  const element = h("ol", { class: "loop" });
  // A task's run is open while it runs or when it failed, else where the person chose.
  const opened = new Map();
  // What draws each task's result, made once.
  const results = new Map();
  // Each row opened, by its node's id, so redrawing keeps it open.
  const open = new Set();
  // The open Steps row's box, kept across redraws with its scroll and the height it was dragged
  // to; while its end is in sight it keeps the newest part there.
  const box = h("ol", { class: "loop steps-box" });
  let follow = true;
  box.addEventListener("scroll", () => {
    follow = box.scrollTop + box.clientHeight >= box.scrollHeight - 24;
    box.classList.toggle("scrolled", box.scrollTop > 0);
  });

  function draw() {
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    const out = (id, relation) => graph.edges.filter((edge) => edge.from === id && edge.relation === relation).map((edge) => byId.get(edge.to));
    const into = (id, relation) => graph.edges.filter((edge) => edge.to === id && edge.relation === relation).map((edge) => byId.get(edge.from));
    const children = new Map();
    for (const node of graph.nodes) {
      const parent = node.parent ?? null;
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(node);
    }
    const running = (node) => Boolean(node?.running) && !settled;
    /** The verdict on the run inside `call`, if it has one. */
    const verdictOf = (call) => (children.get(call.id) ?? []).find((each) => partOf(each).verdict)?.value;
    /** The task `call` by its name, and that its result failed its check when it did. */
    const taskMark = (call) => {
      const verdict = verdictOf(call);
      return verdict?.valid === false ? `${names(call.label)}: Check failed` : names(call.label);
    };

    /** The row of the value `node`. */
    const valueRow = (node) => {
      const live = running(into(node.id, "generated")[0]) || (node.incomplete && !settled);
      const keep = (row) => {
        row.dataset.id = node.id;
        if (live) row.classList.add("live");
        const toggle = row.querySelector(":scope > .part-open");
        if (toggle && open.has(node.id)) {
          toggle.setAttribute("aria-expanded", "true");
          row.querySelector(":scope > .part-full").hidden = false;
        }
        toggle?.addEventListener("click", () => (open.has(node.id) ? open.delete(node.id) : open.add(node.id)));
        return row;
      };
      const part = partOf(node);
      const [maker] = into(node.id, "generated");
      if (part.chat === "whole") return keep(partRow(part, { whole: node.value ?? "" }));
      if (part.verdict) {
        const valid = node.value.valid;
        const text = h("span", {}, icon(valid ? "check" : "error", { size: 13, label: valid ? "Valid" : "Not valid" }), ` ${node.value.message}`);
        return keep(partRow(part, { text, full: fullValue(node.value), classes: `verdict${valid ? "" : " bad"}` }));
      }
      // What the call that made it took, and whether it failed.
      const meta = maker?.duration_s != null ? formatSeconds(maker.duration_s) : null;
      const bad = maker?.isError ? "bad" : "";
      if (maker && !maker.isError && partOf(maker).chat === "run") {
        // A task's result: how its run ended, and its result drawn beside the chat.
        if (!results.has(node.id)) {
          const draw = result(maker.label, node.value);
          results.set(node.id, draw);
          if (draw) onResult(draw);
        }
        return keep(partRow(part, { text: taskMark(maker), meta, classes: verdictOf(maker)?.valid === false ? "bad" : "" }));
      }
      // A value one call used goes on that call's name; one model requests made opens to what they took too.
      const [user] = part.fold === "user" ? out(node.id, "used") : [];
      const name = user ? h("span", { class: "part-name", text: nameOf(user, names) }) : null;
      const text = [name, node.incomplete ? null : `${name ? " " : ""}${inline(node.value ?? "")}`];
      const full = node.incomplete ? null : h("div", {}, fullValue(node.value ?? ""), ...(maker?.modelCalls ?? []).map(runStats));
      return keep(partRow(part, { text, full, meta, classes: bad }));
    };

    /** The rows of the nodes inside `parent` (null for the turn itself). */
    const rows = (parent) => {
      const made = [];
      let repeated = null; // the last row of a part that repeats, its label, and how many there are in a row
      for (const node of children.get(parent) ?? []) {
        const part = partOf(node);
        if (part.repeats && repeated?.type === node.type && repeated.label === node.label) {
          repeated.count += 1;
          repeated.row.querySelector(".part-meta").textContent = `×${repeated.count}`;
          continue;
        }
        repeated = null;
        if (part.chat === "hidden") continue;
        if (part.chat === "run") {
          made.push(taskRun(node));
          continue;
        }
        if (part.call) {
          // A call shown on a line of its own, by its name.
          const row = partRow(part, { text: nameOf(node, names), meta: part.repeats ? "×1" : null });
          if (part.repeats) repeated = { type: node.type, label: node.label, count: 1, row };
          made.push(row);
          continue;
        }
        // The turn's own message is the chat's; a part shown once a session shows in its first turn.
        if (parent === null && (node.type === TYPES.USER_MESSAGE || (part.once && !first))) continue;
        made.push(valueRow(node));
      }
      return made;
    };

    /** A task's own run, indented, folded to how many parts it has once it passed. */
    const taskRun = (task) => {
      const inside = rows(task.id);
      const isOpen = opened.get(task.id) ?? (running(task) || task.isError || verdictOf(task)?.valid === false);
      const toggle = h(
        "button",
        { type: "button", class: "loop-task-toggle", "aria-expanded": String(isOpen) },
        icon("chevron", { size: 13 }),
        h("span", { text: `${names(task.label)}: ${inside.length} part${inside.length === 1 ? "" : "s"}` }),
      );
      toggle.addEventListener("click", () => {
        opened.set(task.id, !isOpen);
        draw();
      });
      return h("li", { class: "loop-task" }, toggle, isOpen ? h("ol", { class: "loop" }, inside) : null);
    };

    /**
     * The turn: every part on the way to its response folded into one Steps row, which says what
     * tasks it ran, open while it runs or when it ended with no response, and the response under it.
     */
    const turn = () => {
      const top = children.get(null) ?? [];
      const made = rows(null);
      const responses = new Set(top.filter((node) => node.type === TYPES.RESPONSE).map((node) => node.id));
      const inside = made.filter((row) => !responses.has(row.dataset.id));
      if (!inside.length) return made;
      const tasks = top.filter((node) => partOf(node).chat === "run");
      const isOpen = opened.get(STEPS) ?? (!settled || !responses.size);
      const toggle = h(
        "button",
        { type: "button", class: "part-open", "aria-expanded": String(isOpen) },
        h("span", { class: "part-label", text: "Steps" }),
        h("span", { class: "part-text" }, icon("chevron", { size: 13 }), ` ${tasks.length ? tasks.map(taskMark).join("; ") : `${inside.length} part${inside.length === 1 ? "" : "s"}`}`),
      );
      toggle.addEventListener("click", () => {
        opened.set(STEPS, !isOpen);
        draw();
      });
      const steps = h("li", { class: "part steps" }, toggle, isOpen ? box : null);
      box.replaceChildren(...inside);
      return [steps, ...made.filter((row) => responses.has(row.dataset.id))];
    };

    const scrolled = box.scrollTop;
    element.replaceChildren(...turn());
    box.scrollTop = follow ? box.scrollHeight : scrolled;
  }

  let frame = 0;
  const redraw = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      draw();
    });
  };

  return {
    element,
    apply(patch) {
      applyPatch(graph, patch);
      redraw();
    },
    // A whole graph, and the run's end, are drawn at once: a kept turn's results are there to draw.
    replace(whole) {
      graph = structuredClone(whole);
      draw();
    },
    settle() {
      settled = true;
      draw();
    },
  };
}
