import React, { useState, useMemo } from 'react';
import { Mafs, Coordinates, Vector, Plot, Line, Text, Theme } from 'mafs';
import 'mafs/core.css';

function applyMatrix(m, v) {
  return [m[0][0] * v[0] + m[0][1] * v[1], m[1][0] * v[0] + m[1][1] * v[1]];
}

function computeEigen2x2(a, b, c, d) {
  const trace = a + d;
  const det = a * d - b * c;
  const disc = trace * trace - 4 * det;
  if (disc < 0) return { real: false, eigenvalues: [], eigenvectors: [] };
  const sqrtDisc = Math.sqrt(disc);
  const l1 = (trace + sqrtDisc) / 2;
  const l2 = (trace - sqrtDisc) / 2;
  const eigenvectors = [];
  for (const lambda of [l1, l2]) {
    let vx, vy;
    if (Math.abs(b) > 1e-10) { vx = b; vy = lambda - a; }
    else if (Math.abs(c) > 1e-10) { vx = lambda - d; vy = c; }
    else if (Math.abs(lambda - a) < 1e-10) { vx = 1; vy = 0; }
    else { vx = 0; vy = 1; }
    const mag = Math.sqrt(vx * vx + vy * vy);
    if (mag > 1e-10) eigenvectors.push([vx / mag, vy / mag]);
  }
  return { real: true, eigenvalues: [l1, l2], eigenvectors };
}

function Slider({ label, value, onChange, min = -3, max = 3, step = 0.1 }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: '0.5em', fontSize: '0.9rem' }}>
      <span style={{ fontFamily: 'serif', fontStyle: 'italic', minWidth: '1.5em' }}>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))} style={{ width: '100px' }} />
      <span style={{ fontFamily: 'monospace', minWidth: '3.5em', textAlign: 'right' }}>{value.toFixed(1)}</span>
    </label>
  );
}

export default function EigenDemo() {
  const [a, setA] = useState(2);
  const [b, setB] = useState(1);
  const [c, setC] = useState(0);
  const [d, setD] = useState(1);

  const matrix = [[a, b], [c, d]];
  const eigen = useMemo(() => computeEigen2x2(a, b, c, d), [a, b, c, d]);
  const eigenScale = 3;

  return (
    <div style={{ margin: '1.5em 0' }}>
      <Mafs viewBox={{ x: [-5, 5], y: [-5, 5] }} preserveAspectRatio={false}>
        <Coordinates.Cartesian />
        <Plot.Parametric xy={(t) => [Math.cos(t), Math.sin(t)]}
          domain={[0, 2 * Math.PI]} color="#ccc" weight={1} style="dashed" />
        <Plot.Parametric xy={(t) => applyMatrix(matrix, [Math.cos(t), Math.sin(t)])}
          domain={[0, 2 * Math.PI]} color={Theme.blue} weight={2} />
        {eigen.real && eigen.eigenvectors.map((ev, i) => {
          const color = i === 0 ? Theme.red : Theme.green;
          const lambda = eigen.eigenvalues[i];
          const scaledTip = [ev[0] * eigenScale, ev[1] * eigenScale];
          const scaledNeg = [-ev[0] * eigenScale, -ev[1] * eigenScale];
          return (
            <React.Fragment key={`eigen-${i}`}>
              <Line.Segment point1={scaledNeg} point2={scaledTip}
                color={color} weight={2} style="dashed" opacity={0.5} />
              <Vector tip={[ev[0] * lambda, ev[1] * lambda]} color={color} weight={3} />
              <Text x={ev[0] * lambda + 0.3} y={ev[1] * lambda + 0.3}
                color={color} size={14}>
                λ{i + 1}v{i + 1}
              </Text>
            </React.Fragment>
          );
        })}
      </Mafs>
      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: '1em 2em',
        justifyContent: 'center', alignItems: 'center',
        marginTop: '0.75em', padding: '0.75em 1em',
        background: '#f5f7f9', borderRadius: '8px',
      }}>
        <div style={{ display: 'flex', gap: '0.5em', alignItems: 'center' }}>
          <span style={{ fontFamily: 'serif', fontSize: '1.1rem' }}>A = </span>
          <div style={{
            display: 'inline-grid', gridTemplateColumns: '1fr 1fr',
            gap: '0.25em 1em', padding: '0.25em 0.5em',
            borderLeft: '2px solid #333', borderRight: '2px solid #333',
          }}>
            <Slider label="a" value={a} onChange={setA} />
            <Slider label="b" value={b} onChange={setB} />
            <Slider label="c" value={c} onChange={setC} />
            <Slider label="d" value={d} onChange={setD} />
          </div>
        </div>
        <div style={{ fontSize: '0.95rem', color: '#555' }}>
          {eigen.real ? (<>
            <span style={{ color: '#e11d48' }}><b>λ₁</b> = {eigen.eigenvalues[0].toFixed(2)}</span>
            {' · '}
            <span style={{ color: '#16a34a' }}><b>λ₂</b> = {eigen.eigenvalues[1].toFixed(2)}</span>
          </>) : (
            <span style={{ color: '#ea580c' }}>Complex eigenvalues (rotation)</span>
          )}
        </div>
      </div>
    </div>
  );
}
