import React, {useState, useContext} from 'react';
import CodeBlock from '@theme-original/CodeBlock';
import {LeanProofContext} from '@site/src/components/LeanProof';

function isLean(props) {
  const lang = (props.className || '').match(/language-(\w+)/)?.[1] || '';
  return lang === 'lean4' || lang === 'lean';
}

function LeanRunner({code, children}) {
  const [runUrl, setRunUrl] = useState(null);

  function handleToggle() {
    if (runUrl) {
      setRunUrl(null);
    } else {
      const theme =
        document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
      setRunUrl(
        `https://live.lean-lang.org/?theme=${theme}#code=${encodeURIComponent(code)}`,
      );
    }
  }

  return (
    <div className="lean-runner">
      {children}
      <button
        className={`lean-run-btn${runUrl ? ' lean-run-btn--active' : ''}`}
        onClick={handleToggle}
        title="Run this Lean 4 code in the browser"
      >
        {runUrl ? '✕ Close' : '▶ Run'}
      </button>
      {runUrl && (
        <div className="lean-playground">
          <div className="lean-playground-info">
            Running on{' '}
            <a href={runUrl} target="_blank" rel="noreferrer">
              live.lean-lang.org
            </a>
          </div>
          <iframe
            src={runUrl}
            title="Lean 4 Web editor"
            loading="lazy"
            className="lean-playground-frame"
          />
        </div>
      )}
    </div>
  );
}

export default function CodeBlockWrapper(props) {
  const insideLeanProof = useContext(LeanProofContext);

  if (!isLean(props) || insideLeanProof || props.metastring?.includes('noRun')) {
    return <CodeBlock {...props} />;
  }

  const code = typeof props.children === 'string' ? props.children.trim() : '';

  return (
    <LeanRunner code={code}>
      <CodeBlock {...props} />
    </LeanRunner>
  );
}
