import {useState} from 'react';
import {usePluginData} from '@docusaurus/useGlobalData';
import CodeBlock from '@theme/CodeBlock';

function leanWebUrl(code, project) {
  const theme = typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark'
    ? 'dark'
    : 'light';
  const args = [`code=${encodeURIComponent(code)}`];
  if (project) args.push(`project=${encodeURIComponent(project)}`);
  return `https://live.lean-lang.org/?theme=${theme}#${args.join('&')}`;
}

function useProofSource(name) {
  const data = usePluginData('lean-proofs');
  if (!name) return null;
  const proof = data?.proofs?.[name];
  if (!proof) {
    throw new Error(
      `<LeanProof name="${name}"> found no such declaration. Available: `
      + `${Object.keys(data?.proofs ?? {}).join(', ') || 'none'}.`,
    );
  }
  return proof.source;
}

const buttonStyle = {
  border: '1px solid var(--ifm-color-emphasis-300)',
  borderRadius: 6,
  background: 'var(--ifm-background-color)',
  color: 'var(--ifm-color-primary)',
  cursor: 'pointer',
  font: 'inherit',
  fontSize: 13,
  fontWeight: 600,
  padding: '5px 9px',
};

export function LeanCode({source = '', language = 'lean4', runnable = true, project = 'mathlib'}) {
  const [runUrl, setRunUrl] = useState(null);
  const canRun = runnable !== false && runnable !== 'false';
  return (
    <div style={{position: 'relative'}}>
      <CodeBlock language={language}>{source}</CodeBlock>
      {canRun ? (
        <button
          type="button"
          onClick={() => setRunUrl(current => current ? null : leanWebUrl(source, project))}
          style={{...buttonStyle, position: 'absolute', right: 48, top: 8, zIndex: 1}}
        >
          {runUrl ? '✕ Close' : '▶ Run'}
        </button>
      ) : null}
      {runUrl ? (
        <div style={{margin: '0.5em 0 1em'}}>
          <p style={{fontSize: 13, color: 'var(--ifm-color-emphasis-700)'}}>
            Running on <a href={runUrl} target="_blank" rel="noreferrer">live.lean-lang.org</a>.
          </p>
          <iframe
            src={runUrl}
            title="Lean 4 Web editor"
            loading="lazy"
            style={{width: '100%', height: 460, border: '1px solid var(--ifm-color-emphasis-300)', borderRadius: 6}}
          />
        </div>
      ) : null}
    </div>
  );
}

export function LeanProof({children, name, title, runnable = true, project = 'mathlib'}) {
  const source = useProofSource(name);
  const [open, setOpen] = useState(false);
  const label = title || 'Formal Proof (Lean 4)';

  return (
    <div className="math-block math-block--lean-proof" style={{margin: '0.5em 0 1em', borderLeft: '3px solid #4a9eff'}}>
      <button
        type="button"
        onClick={() => setOpen(value => !value)}
        aria-expanded={open}
        style={{...buttonStyle, border: 'none', background: 'transparent'}}
      >
        <span aria-hidden="true" style={{display: 'inline-block', marginRight: 7, transform: open ? 'rotate(90deg)' : 'none'}}>▶</span>
        {label}
      </button>
      <div style={{display: open ? 'block' : 'none', padding: '0 0.75em 0.5em'}}>
        {source
          ? <LeanCode source={source} language="lean" runnable={runnable} project={project} />
          : children}
      </div>
    </div>
  );
}
