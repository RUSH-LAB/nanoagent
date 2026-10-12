import React, {useCallback, useMemo, useRef} from 'react';
import CodeMirror from '@uiw/react-codemirror';
import {EditorView} from '@codemirror/view';
import {useColorMode} from '@docusaurus/theme-common';
import API_BASE, {apiFetch} from '@site/src/utils/api';
import {toast} from '@site/src/components/Toast/toast';
import {readEvents, SSE_CONTENT_TYPE} from '@site/src/utils/eventStream';
import {contextFromText} from '../components/CommandBar/selectionContext';
import {hideContextSelection, showContextSelection} from '../components/CommandBar/contextSelectionEvent';
import {languageExtensions, markdownLanguage} from '../components/Workbench/languages';
import {inlineCompletion} from './inlineCompletion';

function editorSelection({file, title}) {
  let timer;
  const inspect = view => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      const selection = view.state.selection.main;
      if (selection.empty) {
        hideContextSelection();
        return;
      }
      const context = contextFromText(view.state.sliceDoc(selection.from, selection.to), {
        file,
        title,
        path: window.location.pathname,
        url: window.location.href,
        startLine: view.state.doc.lineAt(selection.from).number,
        endLine: view.state.doc.lineAt(Math.max(selection.from, selection.to - 1)).number,
      });
      const coordinates = view.coordsAtPos(selection.head);
      if (!context || !coordinates) {
        hideContextSelection();
        return;
      }
      const below = coordinates.top < 54;
      showContextSelection({
        context,
        left: Math.min(Math.max(coordinates.left, 76), window.innerWidth - 76),
        top: below ? coordinates.bottom + 8 : coordinates.top - 8,
        below,
      });
    });
  };

  return EditorView.domEventHandlers({
    mouseup: (_event, view) => {
      inspect(view);
      return false;
    },
    keyup: (event, view) => {
      if (event.shiftKey || event.key === 'Shift' || event.key.startsWith('Arrow')) inspect(view);
      return false;
    },
    blur: () => {
      hideContextSelection();
      return false;
    },
  });
}

const noop = () => {};

export default function MarkdownSourceEditor({
  value, onChange, documentPath, documentTitle, onCompletionMetrics = noop,
}) {
  const {colorMode} = useColorMode();
  const reportedFailure = useRef(false);
  const requestCompletion = useCallback(async ({before, after, lineNumber, signal, onUpdate}) => {
    const payload = {
      profileId: 'pi-deepseek',
      prompt: [
        `Markdown file: ${documentPath || 'untitled.md'}`,
        `Cursor line: ${lineNumber}`,
        'Complete the text at <CURSOR>. Return only the exact text to insert.',
        '',
        before,
        '<CURSOR>',
        after,
      ].join('\n'),
    };
    const response = await apiFetch(`${API_BASE}/api/ai/inline-stream`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(payload),
      signal,
    });
    const contentType = response.headers?.get?.('content-type') ?? '';
    const streamed = response.ok
      && contentType.includes(SSE_CONTENT_TYPE)
      && typeof response.body?.getReader === 'function';
    let answer = '';
    let failure = null;
    let closed = false;
    let telemetry = null;
    if (streamed) {
      await readEvents(response, ({event, data}) => {
        if (event === 'delta' && typeof data?.text === 'string') {
          answer += data.text;
          onUpdate(answer);
        } else if (event === 'done') {
          closed = true;
          if (typeof data?.text === 'string' && data.text) {
            answer = data.text;
            onUpdate(answer);
          }
          telemetry = {
            usage: data?.usage ?? null,
            cost: data?.cost ?? null,
            metrics: data?.metrics ?? null,
            model: data?.model ?? null,
            harness: data?.harness ?? null,
            profile: data?.profile ?? null,
          };
        } else if (event === 'error') {
          closed = true;
          failure = data?.error || `Completion failed (${data?.status ?? 502})`;
        }
      });
      if (!closed && !failure) failure = 'The completion stream closed before finishing.';
    } else {
      const data = await response.json().catch(() => ({}));
      if (response.ok) {
        answer = data.text || '';
        telemetry = {
          usage: data?.usage ?? null,
          cost: data?.cost ?? null,
          metrics: data?.metrics ?? null,
          model: data?.model ?? null,
          harness: data?.harness ?? null,
          profile: data?.profile ?? null,
        };
      }
      else failure = data.error || `Completion failed (${response.status})`;
    }
    if (failure) {
      const message = failure;
      if (!reportedFailure.current) {
        reportedFailure.current = true;
        toast.error(`Inline suggestions unavailable: ${message}`);
      }
      throw new Error(message);
    }
    reportedFailure.current = false;
    if (telemetry) onCompletionMetrics(telemetry);
    return answer;
  }, [documentPath, onCompletionMetrics]);

  const extensions = useMemo(() => [
    ...languageExtensions(markdownLanguage),
    inlineCompletion({request: requestCompletion}),
    editorSelection({file: documentPath, title: documentTitle}),
  ], [documentPath, documentTitle, requestCompletion]);

  return (
    <CodeMirror
      value={value}
      height="100%"
      minHeight="28rem"
      theme={colorMode}
      extensions={extensions}
      basicSetup={{
        autocompletion: false,
        bracketMatching: true,
        closeBrackets: true,
        foldGutter: true,
        highlightActiveLine: true,
        highlightActiveLineGutter: true,
        lineNumbers: true,
      }}
      onChange={onChange}
      autoFocus
    />
  );
}
