import { useState, useMemo } from 'react';
import { Mafs, Coordinates, Plot, Polygon, Theme, useMovablePoint } from 'mafs';
import 'mafs/core.css';

const f = (x) => Math.sin(x) + 1;
const F = (a, b) => -Math.cos(b) + b - (-Math.cos(a) + a);

export default function RiemannSumDemo() {
  const [n, setN] = useState(8);
  const [method, setMethod] = useState('midpoint');

  const leftBound = useMovablePoint([0.5, 0], {
    constrain: ([x]) => [x, 0],
    color: Theme.blue,
  });
  const rightBound = useMovablePoint([5.5, 0], {
    constrain: ([x]) => [x, 0],
    color: Theme.blue,
  });

  const a = Math.min(leftBound.point[0], rightBound.point[0]);
  const b = Math.max(leftBound.point[0], rightBound.point[0]);

  const { rects, sum } = useMemo(() => {
    if (b - a < 0.05) return { rects: [], sum: 0 };
    const dx = (b - a) / n;
    const rects = [];
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const x0 = a + i * dx;
      const x1 = x0 + dx;
      const sx = method === 'left' ? x0 : method === 'right' ? x1 : (x0 + x1) / 2;
      const h = f(sx);
      rects.push([[x0, 0], [x1, 0], [x1, h], [x0, h]]);
      sum += h * dx;
    }
    return { rects, sum };
  }, [a, b, n, method]);

  const exact = F(a, b);
  const error = Math.abs(exact) > 1e-10 ? Math.abs((sum - exact) / exact) * 100 : 0;

  return (
    <div style={{ margin: '1.5em 0' }}>
      <Mafs viewBox={{ x: [-0.5, 7.5], y: [-0.5, 3] }} preserveAspectRatio={false}>
        <Coordinates.Cartesian />
        <Plot.OfX y={f} color={Theme.foreground} weight={2} />
        {rects.map((rect, i) => (
          <Polygon key={i} points={rect} color="rgba(59, 130, 246, 0.3)" weight={1} />
        ))}
        {leftBound.element}
        {rightBound.element}
      </Mafs>
      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: '0.8em 1.5em',
        justifyContent: 'center', alignItems: 'center',
        marginTop: '0.75em', padding: '0.75em 1em',
        background: '#f5f7f9', borderRadius: '8px', fontSize: '0.9rem',
      }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5em' }}>
          <b>n</b>
          <input type="range" min={1} max={100} value={n}
            onChange={(e) => setN(Number(e.target.value))} style={{ width: '120px' }} />
          <span style={{ fontFamily: 'monospace', minWidth: '2.5em' }}>{n}</span>
        </label>
        <div style={{ display: 'flex', gap: '0.4em' }}>
          {['left', 'midpoint', 'right'].map((m) => (
            <button key={m} onClick={() => setMethod(m)} style={{
              padding: '0.25em 0.7em', borderRadius: '5px', fontSize: '0.8rem',
              border: method === m ? '1px solid #3b82f6' : '1px solid #d1d5db',
              background: method === m ? '#3b82f6' : 'white',
              color: method === m ? 'white' : '#555',
              cursor: 'pointer', textTransform: 'capitalize',
            }}>{m}</button>
          ))}
        </div>
        <span style={{ color: '#555', fontFamily: '"Inter", system-ui, sans-serif' }}>
          <b>Σ</b> ≈ {sum.toFixed(4)}{' · '}
          <b>∫</b> = {exact.toFixed(4)}{' · '}
          <b>err</b> = {error.toFixed(2)}%
        </span>
      </div>
    </div>
  );
}
