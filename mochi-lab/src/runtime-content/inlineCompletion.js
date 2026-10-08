import {Prec, StateEffect, StateField} from '@codemirror/state';
import {Decoration, EditorView, ViewPlugin, WidgetType, keymap} from '@codemirror/view';

const setCompletion = StateEffect.define();

class InlineCompletionWidget extends WidgetType {
  constructor(text) {
    super();
    this.text = text;
  }

  eq(other) {
    return other.text === this.text;
  }

  toDOM() {
    const span = document.createElement('span');
    span.className = 'cm-inline-completion';
    span.textContent = this.text;
    span.setAttribute('aria-hidden', 'true');
    return span;
  }

  ignoreEvent() {
    return true;
  }
}

const completionState = StateField.define({
  create: () => null,
  update(value, transaction) {
    let next = transaction.docChanged || transaction.selection ? null : value;
    for (const effect of transaction.effects) {
      if (effect.is(setCompletion)) next = effect.value;
    }
    return next;
  },
  provide: field => EditorView.decorations.from(field, value => (
    value
      ? Decoration.set([
        Decoration.widget({widget: new InlineCompletionWidget(value.text), side: 1}).range(value.from),
      ])
      : Decoration.none
  )),
});

function currentCompletion(view) {
  return view.state.field(completionState, false);
}

function acceptCompletion(view) {
  const completion = currentCompletion(view);
  if (!completion) return false;
  view.dispatch({
    changes: {from: completion.from, insert: completion.text},
    selection: {anchor: completion.from + completion.text.length},
    effects: setCompletion.of(null),
  });
  return true;
}

function dismissCompletion(view) {
  if (!currentCompletion(view)) return false;
  view.dispatch({effects: setCompletion.of(null)});
  return true;
}

function requestPosition(view) {
  const selection = view.state.selection.main;
  if (!selection.empty || view.composing) return null;
  const position = selection.head;
  const line = view.state.doc.lineAt(position);
  const before = view.state.sliceDoc(Math.max(0, position - 12000), position);
  if (before.trim().length < 8) return null;
  return {
    position,
    lineNumber: line.number,
    before,
    after: view.state.sliceDoc(position, Math.min(view.state.doc.length, position + 3000)),
  };
}

export function normalizeInlineCompletion(value, precedingCharacter = '') {
  let text = String(value ?? '')
    .replace(/^\s*```(?:markdown|md)?[ \t]*\n?/i, '')
    .replace(/\n?```\s*$/, '')
    .replace(/[ \t]+$/g, '')
    .slice(0, 1200);
  if (!text.trim()) return '';
  if (/\w/.test(precedingCharacter) && /^\w/.test(text)) text = ` ${text}`;
  return text;
}

/** Cursor-like ghost text: wait for a pause, accept with Tab, dismiss with Escape. */
export function inlineCompletion({request, delay = 700}) {
  const plugin = ViewPlugin.fromClass(class {
    constructor(view) {
      this.view = view;
      this.timer = null;
      this.controller = null;
    }

    update(update) {
      if (update.selectionSet && !update.docChanged) {
        this.cancel();
        this.schedule(update.view);
        return;
      }
      if (!update.docChanged) return;
      this.cancel();
      this.schedule(update.view);
    }

    schedule(view) {
      const candidate = requestPosition(view);
      if (!candidate) return;
      this.timer = window.setTimeout(() => this.load(candidate), delay);
    }

    async load(candidate) {
      this.timer = null;
      const snapshot = this.view.state.doc.toString();
      const controller = new AbortController();
      this.controller = controller;
      const show = value => {
        if (controller.signal.aborted) return;
        const selection = this.view.state.selection.main;
        if (!selection.empty || selection.head !== candidate.position || this.view.state.doc.toString() !== snapshot) return;
        const text = normalizeInlineCompletion(value, candidate.before.at(-1));
        if (text) this.view.dispatch({effects: setCompletion.of({from: candidate.position, text})});
      };
      try {
        const response = await request({...candidate, signal: controller.signal, onUpdate: show});
        if (controller.signal.aborted) return;
        const selection = this.view.state.selection.main;
        if (!selection.empty || selection.head !== candidate.position || this.view.state.doc.toString() !== snapshot) return;
        const text = normalizeInlineCompletion(response, candidate.before.at(-1));
        if (text) this.view.dispatch({effects: setCompletion.of({from: candidate.position, text})});
        else dismissCompletion(this.view);
      } catch (error) {
        if (error?.name !== 'AbortError') dismissCompletion(this.view);
      } finally {
        if (this.controller === controller) this.controller = null;
      }
    }

    cancel() {
      if (this.timer) window.clearTimeout(this.timer);
      this.timer = null;
      this.controller?.abort();
      this.controller = null;
    }

    destroy() {
      this.cancel();
    }
  });

  return [
    completionState,
    plugin,
    Prec.high(keymap.of([
      {key: 'Tab', run: acceptCompletion},
      {key: 'Escape', run: dismissCompletion},
    ])),
    EditorView.baseTheme({
      '.cm-inline-completion': {
        color: 'var(--ifm-color-emphasis-500)',
        opacity: '0.68',
        whiteSpace: 'pre-wrap',
        pointerEvents: 'none',
      },
    }),
  ];
}
