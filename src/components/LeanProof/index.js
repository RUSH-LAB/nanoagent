import {useState, useRef, createContext} from 'react';
import {usePluginData} from '@docusaurus/useGlobalData';
import CodeBlock from '@theme/CodeBlock';

export const LeanProofContext = createContext(false);

// Read the raw source out of a Docusaurus/Prism code block. Each line is a
// `.token-line` span with no newline text node, so join them with '\n'.
function extractCode(root) {
  const codeEl = root?.querySelector('pre code');
  if (!codeEl) return '';
  const lines = Array.from(codeEl.querySelectorAll('.token-line'));
  if (lines.length) return lines.map((l) => l.textContent).join('\n');
  return codeEl.textContent || '';
}

// Build a live.lean-lang.org URL that preloads the given code.
// Docs: https://github.com/leanprover-community/lean4web/blob/main/doc/Usage.md
function leanWebUrl(code, project) {
  const theme =
    typeof document !== 'undefined' &&
    document.documentElement.dataset.theme === 'dark'
      ? 'dark'
      : 'light';
  const args = [`code=${encodeURIComponent(code)}`];
  if (project) args.push(`project=${encodeURIComponent(project)}`);
  return `https://live.lean-lang.org/?theme=${theme}#${args.join('&')}`;
}

/**
 * Pull a declaration out of the lean-proofs plugin's global data. Returns null
 * when the plugin is absent so the component degrades to its `children`.
 */
function useProofSource(name) {
  const data = usePluginData('lean-proofs');
  if (!name) return null;
  const proof = data?.proofs?.[name];
  if (!proof) {
    throw new Error(
      `<LeanProof name="${name}"> found no such declaration in the Lake project. ` +
      `Available: ${Object.keys(data?.proofs ?? {}).join(', ') || 'none'}.`,
    );
  }
  return proof.source;
}

export function LeanProof({children, name, title, runnable = true, project}) {
  const source = useProofSource(name);
  const [open, setOpen] = useState(false);
  const [runUrl, setRunUrl] = useState(null);
  const codeRef = useRef(null);
  const label = title || 'Formal Proof (Lean 4)';

  function handleRun() {
    const code = extractCode(codeRef.current);
    if (!code) return;
    setOpen(true);
    setRunUrl(leanWebUrl(code, project));
  }

  const btnStyle = {
    display: 'flex',
    alignItems: 'center',
    gap: '0.4em',
    padding: '0.5em 0.75em',
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    fontSize: '0.9rem',
    color: '#4a9eff',
    fontWeight: 500,
    fontFamily: 'inherit',
  };

  return (
    <div
      className="math-block math-block--lean-proof"
      style={{
        margin: '0.5em 0 1em 0',
        borderLeft: '3px solid #4a9eff',
        fontFamily:
          'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
      }}
    >
      <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between'}}>
        <button
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          style={btnStyle}
        >
          <span
            style={{
              display: 'inline-block',
              transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
              transition: 'transform 0.2s ease',
              fontSize: '0.7rem',
            }}
          >
            ▶
          </span>
          {label}
        </button>
        {runnable && (
          <button
            onClick={handleRun}
            title="Compile this proof in the browser via live.lean-lang.org"
            style={{...btnStyle, fontWeight: 600}}
          >
            ▶ Run in browser
          </button>
        )}
      </div>

      <LeanProofContext.Provider value={true}>
        <div ref={codeRef} style={{display: open ? 'block' : 'none', padding: '0 0.75em 0.5em'}}>
          {source ? <CodeBlock language="lean">{source}</CodeBlock> : children}
        </div>
      </LeanProofContext.Provider>

      {runUrl && (
        <div style={{padding: '0 0.75em 0.75em'}}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: '0.4em',
              fontSize: '0.8rem',
              color: '#888',
            }}
          >
            <span>
              Running on{' '}
              <a href={runUrl} target="_blank" rel="noreferrer">
                live.lean-lang.org
              </a>{' '}
              (code is sent to the public Lean playground)
            </span>
            <button
              onClick={() => setRunUrl(null)}
              style={{...btnStyle, padding: '0.2em 0.4em', color: '#888'}}
            >
              ✕ Close
            </button>
          </div>
          <iframe
            src={runUrl}
            title="Lean 4 Web editor"
            loading="lazy"
            style={{
              width: '100%',
              height: '460px',
              border: '1px solid #d0d7de',
              borderRadius: '6px',
            }}
          />
        </div>
      )}
    </div>
  );
}
