import React, {useEffect, useState} from 'react';
import BrowserOnly from '@docusaurus/BrowserOnly';
import Layout from '@theme/Layout';
import {pluginFetch} from '../../client-api';
import {LeanCode} from './LeanProof';

const field = {
  width: '100%', boxSizing: 'border-box', border: '1px solid var(--ifm-color-emphasis-300)',
  borderRadius: 8, background: 'var(--ifm-background-color)', color: 'var(--ifm-font-color-base)',
  font: 'inherit', padding: 12,
};
const button = {
  border: 0, borderRadius: 7, background: 'var(--ifm-color-primary)', color: '#fff',
  cursor: 'pointer', font: 'inherit', fontWeight: 650, padding: '9px 14px',
};
const DRAFT_KEY = 'mochi:lean-proofs:draft';

async function post(path, body) {
  const response = await pluginFetch(path, {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}

function Editor() {
  const [statement, setStatement] = useState('For all natural numbers n and m, n + m = m + n.');
  const [proof, setProof] = useState('Proceed by induction on n. The zero case follows by simplification. In the successor case, simplify and apply the induction hypothesis.');
  const [source, setSource] = useState('import Mathlib\n\ntheorem draft (n m : Nat) : n + m = m + n := by\n  exact Nat.add_comm n m');
  const [working, setWorking] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(DRAFT_KEY));
      if (saved?.statement) setStatement(saved.statement);
      if (saved?.proof) setProof(saved.proof);
      if (saved?.source) setSource(saved.source);
    } catch { /* a broken local draft is disposable */ }
  }, []);

  useEffect(() => {
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify({statement, proof, source})); }
    catch { /* private browsing or a full quota should not break the editor */ }
  }, [statement, proof, source]);

  const formalize = async () => {
    setWorking('formalize'); setError(''); setResult(null);
    try {
      const data = await post('/api/lean-proofs/formalize', {statement, proof});
      setSource(data.source);
    } catch (err) { setError(err.message); } finally { setWorking(''); }
  };

  const check = async () => {
    setWorking('check'); setError(''); setResult(null);
    try { setResult(await post('/api/lean-proofs/check', {source})); }
    catch (err) { setError(err.message); } finally { setWorking(''); }
  };

  return (
    <main className="container margin-vert--lg">
      <h1>Lean Proof Workbench</h1>
      <p>Write the human argument, formalize it into Lean, then accept it only after the pinned local toolchain verifies it.</p>
      <label><strong>Theorem statement</strong><textarea rows={4} value={statement} onChange={e => setStatement(e.target.value)} style={{...field, margin: '6px 0 16px'}} /></label>
      <label><strong>Informal proof</strong><textarea rows={8} value={proof} onChange={e => setProof(e.target.value)} style={{...field, margin: '6px 0 16px'}} /></label>
      <div style={{display: 'flex', gap: 9, marginBottom: 14}}>
        <button type="button" style={button} disabled={Boolean(working) || !statement.trim()} onClick={formalize}>
          {working === 'formalize' ? 'Formalizing…' : 'Formalize with AI'}
        </button>
        <button type="button" style={{...button, background: '#238636'}} disabled={Boolean(working) || !source.trim()} onClick={check}>
          {working === 'check' ? 'Checking…' : 'Check with Lean'}
        </button>
      </div>
      <label><strong>Lean source</strong><textarea spellCheck={false} rows={16} value={source} onChange={e => setSource(e.target.value)} style={{...field, margin: '6px 0 16px', fontFamily: 'var(--ifm-font-family-monospace)'}} /></label>
      {error ? <div className="alert alert--danger" role="alert">{error}</div> : null}
      {result ? (
        <div className={`alert alert--${result.verified ? 'success' : 'danger'}`} role="status">
          <strong>{result.verified ? 'Lean verified this proof.' : 'Lean rejected this proof.'}</strong>
          {(result.stderr || result.stdout) ? <pre style={{whiteSpace: 'pre-wrap', marginTop: 10}}>{result.stderr || result.stdout}</pre> : null}
        </div>
      ) : null}
      <h2>Preview</h2>
      <LeanCode source={source} />
    </main>
  );
}

export default function Workbench() {
  return <Layout title="Lean Proof Workbench"><BrowserOnly fallback={<p className="container margin-vert--lg">Loading…</p>}>{() => <Editor />}</BrowserOnly></Layout>;
}
