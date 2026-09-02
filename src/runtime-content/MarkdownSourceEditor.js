import React, {useMemo} from 'react';
import CodeMirror from '@uiw/react-codemirror';
import {markdown} from '@codemirror/lang-markdown';
import {EditorView} from '@codemirror/view';
import {useColorMode} from '@docusaurus/theme-common';

export default function MarkdownSourceEditor({value, onChange}) {
  const {colorMode} = useColorMode();
  const extensions = useMemo(() => [markdown(), EditorView.lineWrapping], []);

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
