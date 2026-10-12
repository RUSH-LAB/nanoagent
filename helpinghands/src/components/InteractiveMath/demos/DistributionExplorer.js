import { useState, useMemo } from 'react';
import { Mafs, Coordinates, Plot, Polygon, Theme, useMovablePoint } from 'mafs';
import 'mafs/core.css';
import { CONTROL_PANEL_STYLE } from './controlPanelStyle';

function normalPDF(x, mu, sigma) {
  return (1 / (sigma * Math.sqrt(2 * Math.PI))) *
    Math.exp(-0.5 * ((x - mu) / sigma) ** 2);
}

function normalCDF(x, mu, sigma) {
  const z = (x - mu) / (sigma * Math.SQRT2);
  const t = 1 / (1 + 0.3275911 * Math.abs(z));
  const poly = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  const erf = 1 - poly * Math.exp(-z * z);
  return 0.5 * (1 + (z >= 0 ? erf : -erf));
}

function expPDF(x, lambda) {
  return x >= 0 ? lambda * Math.exp(-lambda * x) : 0;
}

function expCDF(x, lambda) {
  return x >= 0 ? 1 - Math.exp(-lambda * x) : 0;
}

const DISTRIBUTIONS = {
  normal: {
    label: 'Normal',
    pdf: (x, p) => normalPDF(x, p.mu, p.sigma),
    cdf: (x, p) => normalCDF(x, p.mu, p.sigma),
    defaultParams: { mu: 0, sigma: 1 },
    paramDefs: [
      { key: 'mu', label: 'μ', min: -3, max: 3, step: 0.1 },
      { key: 'sigma', label: 'σ', min: 0.3, max: 3, step: 0.1 },
    ],
    viewX: [-6, 6],
    stats: (p) => ({ mean: p.mu, variance: p.sigma ** 2 }),
    defaultBounds: [-1, 1],
  },
  exponential: {
    label: 'Exponential',
    pdf: (x, p) => expPDF(x, p.lambda),
    cdf: (x, p) => expCDF(x, p.lambda),
    defaultParams: { lambda: 1 },
    paramDefs: [
      { key: 'lambda', label: 'λ', min: 0.2, max: 3, step: 0.1 },
    ],
    viewX: [-1, 8],
    stats: (p) => ({ mean: 1 / p.lambda, variance: 1 / p.lambda ** 2 }),
    defaultBounds: [0.5, 2],
  },
  uniform: {
    label: 'Uniform',
    pdf: (x, p) => (p.b > p.a && x >= p.a && x <= p.b) ? 1 / (p.b - p.a) : 0,
    cdf: (x, p) => p.b <= p.a ? 0 : x < p.a ? 0 : x > p.b ? 1 : (x - p.a) / (p.b - p.a),
    defaultParams: { a: -1, b: 1 },
    paramDefs: [
      { key: 'a', label: 'a', min: -4, max: 2, step: 0.1 },
      { key: 'b', label: 'b', min: -2, max: 4, step: 0.1 },
    ],
    viewX: [-5, 5],
    stats: (p) => ({ mean: (p.a + p.b) / 2, variance: (p.b - p.a) ** 2 / 12 }),
    defaultBounds: [-0.5, 0.5],
  },
};

function DistributionView({ distKey, onDistChange }) {
  const dist = DISTRIBUTIONS[distKey];
  const [params, setParams] = useState(dist.defaultParams);

  const pdf = (x) => dist.pdf(x, params);

  const left = useMovablePoint([dist.defaultBounds[0], 0], {
    constrain: ([x]) => [x, 0],
    color: Theme.red,
  });
  const right = useMovablePoint([dist.defaultBounds[1], 0], {
    constrain: ([x]) => [x, 0],
    color: Theme.red,
  });

  const x1 = Math.min(left.point[0], right.point[0]);
  const x2 = Math.max(left.point[0], right.point[0]);

  const maxPdf = useMemo(() => {
    const [xMin, xMax] = dist.viewX;
    let max = 0;
    for (let x = xMin; x <= xMax; x += 0.05) {
      const y = pdf(x);
      if (isFinite(y)) max = Math.max(max, y);
    }
    return Math.max(max, 0.1);
  }, [params, distKey]);

  const areaPolygon = useMemo(() => {
    if (x2 - x1 < 0.01) return [];
    const steps = 200;
    const dx = (x2 - x1) / steps;
    const pts = [[x1, 0]];
    for (let i = 0; i <= steps; i++) {
      const x = x1 + i * dx;
      pts.push([x, pdf(x)]);
    }
    pts.push([x2, 0]);
    return pts;
  }, [x1, x2, params, distKey]);

  const prob = dist.cdf(x2, params) - dist.cdf(x1, params);
  const stats = dist.stats(params);

  return (
    <>
      <Mafs
        viewBox={{ x: dist.viewX, y: [-maxPdf * 0.08, maxPdf * 1.2] }}
        preserveAspectRatio={false}
      >
        <Coordinates.Cartesian />
        <Plot.OfX y={pdf} color={Theme.blue} weight={2} />
        {areaPolygon.length > 0 && (
          <Polygon points={areaPolygon} color="rgba(239, 68, 68, 0.25)" weight={0} />
        )}
        {left.element}
        {right.element}
      </Mafs>
      <div style={{ ...CONTROL_PANEL_STYLE, gap: '0.8em 1.5em' }}>
        <select value={distKey} onChange={(e) => onDistChange(e.target.value)}
          style={{
            padding: '0.3em 0.5em', borderRadius: '4px',
            border: '1px solid #d1d5db', fontSize: '0.85rem',
          }}>
          {Object.entries(DISTRIBUTIONS).map(([key, d]) => (
            <option key={key} value={key}>{d.label}</option>
          ))}
        </select>
        {dist.paramDefs.map((p) => (
          <label key={p.key} style={{ display: 'flex', alignItems: 'center', gap: '0.5em' }}>
            <b style={{ fontFamily: 'serif', fontStyle: 'italic' }}>{p.label}</b>
            <input type="range" min={p.min} max={p.max} step={p.step}
              value={params[p.key]}
              onChange={(e) => setParams({ ...params, [p.key]: parseFloat(e.target.value) })}
              style={{ width: '100px' }} />
            <span style={{ fontFamily: 'monospace', minWidth: '2.5em' }}>
              {params[p.key].toFixed(1)}
            </span>
          </label>
        ))}
        <span style={{ color: '#555', fontFamily: '"Inter", system-ui, sans-serif' }}>
          <b>μ</b> = {stats.mean.toFixed(2)}{' · '}
          <b>σ²</b> = {stats.variance.toFixed(2)}{' · '}
          <span style={{ color: '#dc2626' }}><b>P</b> = {prob.toFixed(4)}</span>
        </span>
      </div>
    </>
  );
}

export default function DistributionExplorer() {
  const [distKey, setDistKey] = useState('normal');

  return (
    <div style={{ margin: '1.5em 0' }}>
      <DistributionView key={distKey} distKey={distKey} onDistChange={setDistKey} />
    </div>
  );
}
