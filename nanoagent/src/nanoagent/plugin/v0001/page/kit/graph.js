// A run's provenance graph (nanoagent.plugin.provenance), drawn top to bottom and kept current
// while its patches stream in: each node in the row of the longest path to it, so every edge
// points down, from what a call used to what it generated. A tool call is drawn with the
// arguments and output only it has; a task's call is a box with the task's own run inside it,
// folded to its totals once it is done. Picking a node shows what it took and holds in the panel
// under the graph.

import { statItems, statusPill } from "./display.js";
import { h, icon } from "./dom.js";
import { formatCost, formatSeconds, runStats, thousands } from "./session.js";

const SVG = "http://www.w3.org/2000/svg";
const RELATIONS = ["used", "generated", "continued", "copied", "chose"];
// The runs drawn with the tool call they alone ran and the result they alone returned, and the
// parts of a model request drawn on its card: what it thought and what it wrote, its response
// for the last.
const FOLDING = new Set(["tool", "task", "reference"]);
const REPLY_PARTS = new Set(["thinking", "assistant", "agent_message"]);
let views = 0;

/**
 * Apply `patch` to `graph`, a graph's JSON, in place (nanoagent.plugin.provenance.apply).
 * @param {{nodes: Array<object>, edges: Array<object>}} graph
 * @param {object} patch
 */
export function applyPatch(graph, patch) {
  const node = () => {
    const found = graph.nodes.find((each) => each.id === patch.id);
    if (!found) throw new Error(`A graph patch names no node: ${patch.id}.`);
    return found;
  };
  if (patch.op === "node") graph.nodes.push(structuredClone(patch.node));
  else if (patch.op === "edge") graph.edges.push({ ...patch.edge });
  else if (patch.op === "update") Object.assign(node(), structuredClone(patch.set));
  else if (patch.op === "append") {
    const target = node();
    target[patch.field] = (target[patch.field] ?? "") + patch.text;
  } else throw new Error(`Unknown graph patch ${JSON.stringify(patch.op)}.`);
}

/**
 * A session's graph, its turns' graphs (one run each) joined: each turn's nodes under
 * `turns[<n>]/`, and the earlier turns a turn read drawn as the turn before it, which its first
 * reply continued, using that turn's response, and whose system prompt, when its own is the
 * same, it read. A turn after one with no graph keeps its node of the earlier turns.
 * `turn(graph)` starts the next turn, with its whole graph when it is done, and null for a turn
 * kept with no graph; `patch(patch)` applies a patch of the turn now and returns the session
 * graph's patches; `redo(graph)` draws the turn now again, from nothing when `graph` is empty.
 * @returns {{graph: () => {nodes: Array<object>, edges: Array<object>}, turn: (graph?: object|null) => void, patch: (patch: object) => object[], redo: (graph: object|null) => void}}
 */
export function sessionGraph() {
  let graph = { nodes: [], edges: [] };
  let turns = 0;
  let before = null; // the turn before the one now: its last reply, its response and its system prompt
  let now = null;
  let start = null; // the session graph before the turn now
  const top = (node) => !node.parent;
  /** The session graph's patches for the turn now's `patch`. */
  const translate = (patch) => {
    const id = (each) => (now.dropped.has(each) ? null : `${now.prefix}${each}`);
    if (patch.op === "node") {
      const node = patch.node;
      if (top(node) && node.type === "earlier_turns" && before?.reply) {
        now.dropped.set(node.id, node.type);
        return [];
      }
      if (top(node) && node.type === "system_prompt") {
        now.system = node.value;
        if (before?.reply && before.system === node.value) {
          now.dropped.set(node.id, node.type);
          return [];
        }
      }
      const moved = { ...node, id: id(node.id), ...(node.parent ? { parent: id(node.parent) } : {}) };
      if (top(node) && node.type === "agent_reply") now.reply = moved.id;
      if (top(node) && node.type === "agent_message") now.response = moved.id;
      return [{ op: "node", node: moved }];
    }
    if (patch.op === "edge") {
      const edge = patch.edge;
      if (now.dropped.get(edge.from) === "earlier_turns") {
        const to = id(edge.to);
        return [{ op: "edge", edge: { from: before.reply, to, relation: "continued" } }, before.response ? { op: "edge", edge: { from: before.response, to, relation: "used" } } : null].filter(Boolean);
      }
      if (now.dropped.has(edge.from)) return [];
      return [{ op: "edge", edge: { ...edge, from: id(edge.from), to: id(edge.to) } }];
    }
    if (patch.op === "update" && patch.set.type === "agent_message" && top(graph.nodes.find((node) => node.id === id(patch.id)))) now.response = id(patch.id);
    return [{ ...patch, id: id(patch.id) }];
  };
  /** The patches that draw a whole turn's graph. */
  const whole = (turn) => [...turn.nodes.map((node) => ({ op: "node", node })), ...turn.edges.map((edge) => ({ op: "edge", edge }))];
  const begin = (turn) => {
    now = turn ? { prefix: `turns[${turns - 1}]/`, dropped: new Map(), reply: null, response: null, system: null } : null;
    if (turn) for (const patch of whole(turn)) session.patch(patch);
  };
  const session = {
    graph: () => graph,
    turn(turn = { nodes: [], edges: [] }) {
      before = now && { reply: now.reply, response: now.response, system: now.system };
      start = structuredClone(graph);
      turns += 1;
      begin(turn);
    },
    patch(patch) {
      const moved = translate(patch);
      for (const each of moved) applyPatch(graph, each);
      return moved;
    },
    redo(turn) {
      graph = structuredClone(start);
      begin(turn);
    },
  };
  return session;
}

/** What a node is: the name of its part (nanoagent.plugin.provenance.PARTS). */
export function kindText(node) {
  if (!node.typeLabel) throw new Error(`The graph node ${JSON.stringify(node.id)} names no part.`);
  return node.typeLabel;
}

const short = (text, length) => (text.length > length ? `${text.slice(0, length - 1)}…` : text);
const shown = (value) => (typeof value === "string" ? value : JSON.stringify(value));
/** A part folded into a node's card, on a line of its own named by its part, as the chat names it (kit/loop.js): "Thinking › …". */
const partLine = (part, text) => h("span", { class: `tn-preview type-${part.type}` }, h("span", { class: "tn-part", text: kindText(part) }), text);
const json = (value) => (typeof value === "string" ? value : JSON.stringify(value, null, 2));
/** What a reply thought or wrote, for its card: the end of it while it streams, else its start (the card cuts it short). */
const preview = (text, running) => {
  const line = (text ?? "").trim().replace(/\s+/g, " ");
  return running && line.length > 110 ? `…${line.slice(-109)}` : line;
};
const plural = (count, one) => `${count.toLocaleString()} ${one}${count === 1 ? "" : "s"}`;
const tokensText = (total) => `${thousands(total.tokensIn)} input, ${thousands(total.tokensOut)} output tokens`;

/** What `nodes` cost: their model requests, with the tokens, dollars and seconds those took, and their tool calls. */
function totals(nodes) {
  const calls = nodes.flatMap((node) => node.modelCalls ?? []);
  const sum = (pick) => calls.reduce((total, call) => total + (pick(call) ?? 0), 0);
  return {
    requests: calls.length,
    tools: nodes.filter((node) => node.type === "tool_call").length,
    tokensIn: sum((call) => call.usage?.prompt_tokens),
    tokensOut: sum((call) => call.usage?.completion_tokens),
    cost: sum((call) => call.cost),
    seconds: sum((call) => call.duration_s),
  };
}
/** `totals` as the facts a task's box shows on one line, in the order of the run's stats: time, requests, tool calls, tokens and cost. */
function totalsText(total, seconds) {
  return [
    seconds ? formatSeconds(seconds) : null,
    total.requests ? plural(total.requests, "model request") : null,
    total.tools ? plural(total.tools, "tool call") : null,
    total.requests ? tokensText(total) : null,
    total.cost ? formatCost(total.cost) : null,
  ].filter(Boolean);
}

/**
 * `totals` as the run's stats over its graph (display.js statItems): End-to-End Latency, Model
 * Time and Tool Time (`modelS` and `toolsS`, the seconds its loop spent on each), Input Tokens,
 * Output Tokens and Cost, as the dashboard's usage (kit/session.js) shows them.
 */
function totalsStats(total, modelS, toolsS) {
  const seconds = modelS + toolsS;
  const figures = [
    seconds ? ["End-to-End Latency", formatSeconds(seconds)] : null,
    seconds ? ["Model Time", formatSeconds(modelS)] : null,
    seconds ? ["Tool Time", formatSeconds(toolsS)] : null,
    total.requests ? ["Input Tokens", thousands(total.tokensIn), total.tokensIn.toLocaleString()] : null,
    total.requests ? ["Output Tokens", thousands(total.tokensOut), total.tokensOut.toLocaleString()] : null,
    total.cost ? ["Cost", formatCost(total.cost)] : null,
  ].filter(Boolean);
  return statItems(figures);
}

/**
 * All of `node` (a drawn node: a call with the `parts` folded into it), named `name`, for the
 * panel under the graph: what it took, its model requests' figures as every page writes them,
 * and what it holds, each part under its part's name.
 */
function nodeDetail(node, name, running, close) {
  const section = (title, ...body) => h("section", { class: "trace-detail-part" }, h("h4", { text: title }), ...body);
  const content = (value) => (value.incomplete ? h("p", { class: "muted", text: "Not finished." }) : h("pre", { class: typeof value.value === "string" ? "trace-stream" : null, text: json(value.value) }));
  const parts = [];
  if (node.modelCalls?.length) for (const call of node.modelCalls) parts.push(runStats(call));
  if (node.duration_s != null) parts.push(h("dl", { class: "stats run-stats" }, statItems([["Total Time", formatSeconds(node.duration_s)]])));
  if (node.type === "agent_reply" && running && !Object.keys(node.parts ?? {}).length) parts.push(h("p", { class: "muted", text: "Waiting for the first token." }));
  if (node.kind === "value") parts.push(section(kindText(node), content(node)));
  for (const value of Object.values(node.parts ?? {})) parts.push(section(kindText(value), content(value)));
  const status = node.isError ? statusPill("Failed", "bad") : running ? statusPill("Running", "info") : node.incomplete ? statusPill("Not finished", "warn") : name === kindText(node) ? null : statusPill(kindText(node), "neutral");
  return h(
    "div",
    { class: "trace-detail-body" },
    h("header", { class: "trace-detail-head" }, h("h3", { text: name }), status, close ? h("button", { type: "button", class: "button ghost small", "aria-label": "Close", onclick: close }, icon("close", { size: 16 })) : null),
    parts,
  );
}

/**
 * One level with each tool, task and reference call drawn with the values it alone has: the
 * arguments it used that nothing else used, and the output it generated, in its `parts`. Edges
 * to and from those values are drawn to and from the call.
 */
function folded(nodes, edges) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const out = (id) => edges.filter((edge) => edge.from === id);
  const into = (id) => edges.filter((edge) => edge.to === id);
  const owner = new Map();
  const drawn = new Map();
  for (const node of nodes) {
    if (node.type === "agent_reply") {
      const parts = {};
      for (const edge of out(node.id)) {
        const part = byId.get(edge.to);
        if (edge.relation === "generated" && REPLY_PARTS.has(part.type)) parts[part.type] = part;
      }
      for (const part of Object.values(parts)) owner.set(part.id, node.id);
      drawn.set(node.id, { ...node, parts });
      continue;
    }
    if (!FOLDING.has(node.type)) continue;
    const parts = {};
    const used = into(node.id).filter((edge) => edge.relation === "used" && byId.get(edge.from).kind === "value" && out(edge.from).length === 1);
    const made = out(node.id).filter((edge) => edge.relation === "generated" && into(edge.to).length === 1);
    if (used.length === 1) parts.arguments = byId.get(used[0].from);
    if (made.length === 1) parts.output = byId.get(made[0].to);
    for (const part of Object.values(parts)) owner.set(part.id, node.id);
    if (Object.keys(parts).length) drawn.set(node.id, { ...node, parts });
  }
  const seen = new Set();
  const kept = [];
  for (const edge of edges) {
    const moved = { ...edge, from: owner.get(edge.from) ?? edge.from, to: owner.get(edge.to) ?? edge.to };
    const key = `${moved.from}\n${moved.to}\n${moved.relation}`;
    if (moved.from === moved.to || seen.has(key)) continue;
    seen.add(key);
    kept.push(moved);
  }
  return { nodes: nodes.filter((node) => !owner.has(node.id)).map((node) => drawn.get(node.id) ?? node), edges: kept };
}

/**
 * One level as drawn: the decisions nothing points to that have the same label and point to the
 * same nodes, such as one per item of a list, are one node whose `members` they are.
 */
function merged({ nodes, edges }) {
  const pointed = new Set(edges.map((edge) => edge.to));
  const pointsTo = (id) => [...new Set(edges.filter((edge) => edge.from === id).map((edge) => edge.to))].sort().join("\n");
  const groups = new Map();
  const drawn = [];
  const into = new Map();
  for (const node of nodes) {
    if (node.type !== "decision" || pointed.has(node.id)) {
      drawn.push(node);
      continue;
    }
    const key = `${node.label}\n${pointsTo(node.id)}`;
    if (!groups.has(key)) {
      groups.set(key, { ...node, members: [] });
      drawn.push(groups.get(key));
    }
    groups.get(key).members.push(node);
    into.set(node.id, groups.get(key).id);
  }
  for (const group of groups.values()) if (group.members.length === 1) drawn[drawn.indexOf(group)] = group.members[0];
  return { nodes: drawn, edges: edges.map((edge) => ({ ...edge, from: into.get(edge.from) ?? edge.from })) };
}

/**
 * The nodes in rows: each in the row of the longest path to it, but a node no edge points to (a
 * decision, the turns before) in the row just above the first node it points to; each row in
 * the mean position of what points into it, so a chain stays in one column.
 */
function rows({ nodes, edges }) {
  const into = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of edges) into.get(edge.to).push(edge.from);
  const depth = new Map();
  const of = (id) => {
    if (!depth.has(id)) depth.set(id, Math.max(0, ...into.get(id).map((from) => of(from) + 1)));
    return depth.get(id);
  };
  for (const node of nodes) of(node.id);
  for (const node of nodes) {
    const targets = edges.filter((edge) => edge.from === node.id).map((edge) => depth.get(edge.to));
    if (!into.get(node.id).length && targets.length) depth.set(node.id, Math.min(...targets) - 1);
  }
  const placed = [];
  for (const node of nodes) (placed[depth.get(node.id)] ??= []).push(node);
  const column = new Map();
  for (const row of placed.filter(Boolean)) {
    const mean = (node) => {
      const from = into.get(node.id).filter((id) => column.has(id));
      return from.length ? from.reduce((total, id) => total + column.get(id), 0) / from.length : row.indexOf(node);
    };
    row.sort((a, b) => mean(a) - mean(b)).forEach((node, index) => column.set(node.id, index));
  }
  return placed.filter(Boolean);
}

/**
 * A live provenance graph view, under a line with the run's totals. `apply(patch)` draws a patch
 * as it streams in, `replace(graph)` draws a whole graph, `settle()` says the run ended, so
 * nothing is drawn running any more, and `resume()` that another run goes on in it, as the next
 * turn of a session (sessionGraph) does. While the newest rows are in sight it keeps them there.
 * @param {{names?: (task: string) => string}} [options] `names` gives a task's name by its id.
 * @returns {{element: HTMLElement, apply: (patch: object) => void, replace: (graph: object) => void, settle: () => void, resume: () => void}}
 */
export function graphView({ names = (task) => task } = {}) {
  const id = (views += 1);
  let graph = { nodes: [], edges: [] };
  let byId = new Map();
  let children = new Map();
  let picked = null; // the id of the drawn node the panel shows
  let settled = false;
  let follow = true;
  // Whether each task's box is open, where the person chose; otherwise open while it runs or when it failed.
  const opened = new Map();
  // Each drawn node as drawn (with its parts or members), its element, and a reply's lines, which streamed text changes in place.
  let drawnNodes = new Map();
  // Each reply part's line on its card, and the drawn node it is on.
  let streamLines = new Map();
  let draws = [];
  const summary = h("dl", { class: "stats trace-summary", hidden: true });
  const canvas = h("div", { class: "trace-canvas" });
  const detail = h("div", { class: "trace-detail", hidden: true });
  const empty = h("div", { class: "results-empty" }, h("p", { text: "Nothing yet" }), h("p", { class: "muted", text: "What the agent does shows here as it works." }));
  const element = h("div", { class: "trace" }, summary, canvas, detail);
  canvas.addEventListener("scroll", () => {
    follow = canvas.scrollTop + canvas.clientHeight >= canvas.scrollHeight - 24;
  });

  /** Every node inside `parent`, at any depth. */
  const within = (parent) => (children.get(parent) ?? []).flatMap((node) => [node, ...within(node.id)]);
  const close = () => {
    picked = null;
    drawnNodes.forEach(({ element: button }) => button.setAttribute("aria-pressed", "false"));
    detail.hidden = true;
  };
  const showDetail = () => {
    const drawn = picked !== null && drawnNodes.get(picked);
    if (!drawn) return;
    const members = drawn.node.members ?? [drawn.node];
    detail.replaceChildren(...members.map((member, index) => nodeDetail(member, member.type === "task" ? names(member.label) : member.label, Boolean(member.running) && !settled, index === 0 ? close : null)));
    detail.hidden = false;
  };
  const pick = (node) => {
    // A node picked stays where it is while the run goes on.
    follow = false;
    picked = node.id;
    drawnNodes.forEach(({ element: button }, key) => button.setAttribute("aria-pressed", String(key === picked)));
    showDetail();
  };

  /**
   * A node's element: a box for a task, a card for a model request (its thinking and its message
   * on lines of their own), else a tile, each under its type unless its name says it already.
   */
  const nodeElement = (node) => {
    const running = Boolean(node.running) && !settled;
    const output = node.parts?.output;
    const failed = node.isError || (node.type === "verdict" && node.value?.valid === false);
    const withOutput = node.type !== "task" && output && !output.incomplete;
    const classes = ["tn", node.kind, `type-${node.type}`, withOutput && "with-output", node.incomplete && !running && "incomplete", failed && "failed", running && "live"];
    const type = node.label.startsWith(kindText(node)) ? null : h("span", { class: "tn-type", text: kindText(node) });
    const name = node.type === "task" ? names(node.label) : node.label;
    const label = h("span", { class: "tn-label", text: name }, node.members ? h("span", { class: "tn-count", text: ` ×${node.members.length}` }) : null);
    const lines = {};
    let body = [type, label];
    if (node.type === "agent_reply" || node.type === "decision") {
      const total = totals([node]);
      const meta = total.requests ? h("span", { class: "tn-meta" }, h("span", { text: formatSeconds(total.seconds) }), h("span", { text: tokensText(total) })) : null;
      // A reply's thinking and what it wrote, each a line its streamed tokens change in place.
      const line = (part) => {
        if (!part) return null;
        lines[part.id] = h("span", { class: "tn-part-text", text: preview(part.value, running) });
        return partLine(part, lines[part.id]);
      };
      body = [type, h("span", { class: "tn-row" }, label, meta), line(node.parts?.thinking), line(node.parts?.assistant), line(node.parts?.agent_message)];
    } else if (node.kind === "value" && !node.incomplete && node.value !== null) {
      body = [type, label, h("span", { class: "tn-preview", text: short(shown(node.value), 48) })];
    } else if (withOutput) {
      const { arguments: given } = node.parts;
      const shortLine = (part) => (part && !part.incomplete ? partLine(part, h("span", { class: "tn-part-text", text: short(shown(part.value), 48) })) : null);
      body = [type, h("span", { class: "tn-row" }, label, node.duration_s != null ? h("span", { class: "tn-meta", text: formatSeconds(node.duration_s) }) : null), shortLine(given), shortLine(output)];
    }
    const button = h("button", { type: "button", class: classes.filter(Boolean).join(" "), "aria-pressed": String(node.id === picked), title: kindText(node) }, body);
    button.addEventListener("click", () => pick(node));
    drawnNodes.set(node.id, { node, element: button });
    for (const [part, element] of Object.entries(lines)) streamLines.set(part, { line: element, owner: node.id });
    if (node.type !== "task") return button;
    // The task's own run, inside its box, folded to its totals once it is done.
    const verdict = (children.get(node.id) ?? []).find((each) => each.type === "verdict");
    const bad = node.isError || verdict?.value.valid === false;
    const open = opened.get(node.id) ?? (running || bad);
    const status = running ? "Running" : node.isError ? "Failed" : verdict ? (verdict.value.valid ? "Checked" : "Check failed") : null;
    const facts = [...totalsText(totals(within(node.id)), node.duration_s), status].filter(Boolean);
    const toggle = h(
      "button",
      { type: "button", class: "button ghost small tn-task-toggle", "aria-expanded": String(open), "aria-label": open ? `Fold ${name}` : `Open ${name}` },
      icon("chevron", { size: 14 }),
    );
    toggle.addEventListener("click", () => {
      opened.set(node.id, !open);
      redraw();
    });
    return h(
      "div",
      { class: `tn-task${bad ? " failed" : ""}${open ? " open" : ""}` },
      h("div", { class: "tn-task-head" }, toggle, button),
      h("p", { class: "tn-facts" }, facts.map((fact) => h("span", { text: fact }))),
      open ? level(node.id) : null,
    );
  };

  /** The nodes inside `parent` (null for the top), in rows, with their edges drawn behind them. */
  function level(parent) {
    const inside = children.get(parent) ?? [];
    const ids = new Set(inside.map((node) => node.id));
    const layout = merged(folded(inside, graph.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to))));
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("class", "trace-edges");
    svg.setAttribute("aria-hidden", "true");
    const box = h("div", { class: "trace-level" }, svg, rows(layout).map((row) => h("div", { class: "trace-row" }, row.map(nodeElement))));
    draws.push(() => {
      const origin = box.getBoundingClientRect();
      svg.setAttribute("width", box.scrollWidth);
      svg.setAttribute("height", box.scrollHeight);
      const defs = document.createElementNS(SVG, "defs");
      for (const relation of RELATIONS) {
        const marker = document.createElementNS(SVG, "marker");
        for (const [key, value] of Object.entries({ id: `trace-${id}-${relation}`, viewBox: "0 0 8 8", refX: 7, refY: 4, markerWidth: 6, markerHeight: 6, orient: "auto", class: `trace-arrow ${relation}` })) {
          marker.setAttribute(key, value);
        }
        const tip = document.createElementNS(SVG, "path");
        tip.setAttribute("d", "M0 0L8 4L0 8z");
        marker.append(tip);
        defs.append(marker);
      }
      svg.replaceChildren(defs);
      for (const edge of layout.edges) {
        const from = drawnNodes.get(edge.from).element.getBoundingClientRect();
        const to = drawnNodes.get(edge.to).element.getBoundingClientRect();
        const path = document.createElementNS(SVG, "path");
        if (edge.relation === "continued") {
          // The conversation runs down a rail left of the model requests, clear of what lies between them.
          const x1 = from.left - origin.left;
          const y1 = from.top + from.height / 2 - origin.top;
          const x2 = to.left - origin.left - 1;
          const y2 = to.top + to.height / 2 - origin.top;
          const bow = Math.min(x1, x2) - 22;
          path.setAttribute("d", `M ${x1} ${y1} C ${bow} ${y1}, ${bow} ${y2}, ${x2} ${y2}`);
        } else {
          const x1 = from.left + from.width / 2 - origin.left;
          const y1 = from.bottom - origin.top;
          const x2 = to.left + to.width / 2 - origin.left;
          const y2 = to.top - origin.top - 1;
          const bend = Math.max(10, (y2 - y1) / 2);
          path.setAttribute("d", `M ${x1} ${y1} C ${x1} ${y1 + bend}, ${x2} ${y2 - bend}, ${x2} ${y2}`);
        }
        path.setAttribute("class", `trace-edge ${edge.relation}`);
        path.setAttribute("marker-end", `url(#trace-${id}-${edge.relation})`);
        svg.append(path);
      }
    });
    return box;
  }

  /** The run's totals: every model request and tool call in it, and the time its own loop took. */
  const drawSummary = () => {
    const top = children.get(null) ?? [];
    // Its loop's own time: on its replies' model requests, and on running their tool calls.
    const modelS = totals(top.filter((node) => node.type === "agent_reply")).seconds;
    const toolsS = top.reduce((total, node) => total + (node.type === "agent_reply" ? 0 : (node.duration_s ?? 0)), 0);
    summary.replaceChildren(...totalsStats(totals(graph.nodes), modelS, toolsS));
    summary.hidden = !graph.nodes.length;
  };

  const drawEdges = () => draws.forEach((draw) => draw());
  new ResizeObserver(drawEdges).observe(canvas);
  let frame = 0;
  /** Draw the graph again on the next frame, once for all the patches before it. */
  function redraw() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      byId = new Map(graph.nodes.map((node) => [node.id, node]));
      children = new Map();
      for (const node of graph.nodes) {
        const parent = node.parent ?? null;
        if (!children.has(parent)) children.set(parent, []);
        children.get(parent).push(node);
      }
      drawnNodes = new Map();
      streamLines = new Map();
      draws = [];
      canvas.replaceChildren(graph.nodes.length ? level(null) : empty);
      drawEdges();
      drawSummary();
      showDetail();
      if (follow) canvas.scrollTop = canvas.scrollHeight;
    });
  }
  redraw();

  return {
    element,
    apply(patch) {
      applyPatch(graph, patch);
      // Streamed text changes one line of a reply's card in place, not the layout.
      const streamed = patch.op === "append" ? streamLines.get(patch.id) : null;
      if (!streamed) return redraw();
      streamed.line.textContent = preview(byId.get(patch.id)[patch.field], !settled);
      if (picked === streamed.owner) showDetail();
    },
    replace(whole) {
      graph = structuredClone(whole);
      redraw();
    },
    settle() {
      settled = true;
      redraw();
    },
    // The next turn of the session it draws runs.
    resume() {
      settled = false;
    },
  };
}
