import { useState, useCallback } from 'react';
import { Mafs, Coordinates, Plot, Point, Line, Theme, useMovablePoint } from 'mafs';
import 'mafs/core.css';

const f = (x) => 0.15 * (x + 2) * (x - 1) * (x - 3) + 2;
const df = (x) => 0.15 * ((x - 1) * (x - 3) + (x + 2) * (x - 3) + (x + 2) * (x - 1));

export default function GradientDescentDemo() {
  const [lr, setLr] = useState(0.1);
  const [path, setPath] = useState([]);
  const start = useMovablePoint([-2, f(-2)], {
    constrain: ([x]) => [x, f(x)],
    color: Theme.blue,
  });

  const startX = start.point[0];

  const runGD = useCallback(() => {
    const steps = [];
    let x = startX;
    for (let i = 0; i < 50; i++) {
      const grad = df(x);
      const nextX = x - lr * grad;
      if (Math.abs(grad) < 1e-6 || Math.abs(nextX) > 10) break;
      steps.push({ from: [x, f(x)], to: [nextX, f(nextX)] });
      x = nextX;
    }
    setPath(steps);
  }, [startX, lr]);

  const reset = useCallback(() => setPath([]), []);

  const tangentLen = 1.5;
  const grad = df(startX);
  const tangent1 = [startX - tangentLen, f(startX) - grad * tangentLen];
  const tangent2 = [startX + tangentLen, f(startX) + grad * tangentLen];
  const finalPoint = path.length > 0 ? path[path.length - 1].to : null;

  return (
    <div style={{ margin: '1.5em 0' }}>
      <Mafs viewBox={{ x: [-4, 5], y: [-1, 5] }} preserveAspectRatio={false}>
        <Coordinates.Cartesian />
        <Plot.OfX y={f} color={Theme.foreground} weight={2} />
        <Line.Segment point1={tangent1} point2={tangent2}
          color={Theme.orange} weight={1.5} style="dashed" />
        {path.map((step, i) => (
          <Line.Segment key={i} point1={step.from} point2={step.to}
            color="rgba(59, 130, 246, 0.4)" weight={1} />
        ))}
        {path.map((step, i) => (
          <Point key={`p-${i}`} x={step.to[0]} y={step.to[1]}
            color={Theme.blue} opacity={0.3 + 0.7 * (i / Math.max(path.length - 1, 1))} />
        ))}
        {finalPoint && <Point x={finalPoint[0]} y={finalPoint[1]} color={Theme.green} />}
        {start.element}
      </Mafs>
      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: '1em 2em',
        justifyContent: 'center', alignItems: 'center',
        marginTop: '0.75em', padding: '0.75em 1em',
        background: '#f5f7f9', borderRadius: '8px', fontSize: '0.9rem',
      }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5em' }}>
          <span><b>Learning rate η</b></span>
          <input type="range" min={0.01} max={0.5} step={0.01} value={lr}
            onChange={(e) => setLr(parseFloat(e.target.value))} style={{ width: '140px' }} />
          <span style={{ fontFamily: 'monospace', minWidth: '3em' }}>{lr.toFixed(2)}</span>
        </label>
        <button onClick={runGD} style={{
          padding: '0.4em 1.2em', borderRadius: '6px',
          border: '1px solid #3b82f6', background: '#3b82f6', color: 'white',
          cursor: 'pointer', fontSize: '0.85rem', fontWeight: 500,
        }}>Run GD</button>
        <button onClick={reset} style={{
          padding: '0.4em 1.2em', borderRadius: '6px',
          border: '1px solid #d1d5db', background: 'white', color: '#555',
          cursor: 'pointer', fontSize: '0.85rem',
        }}>Reset</button>
        <span style={{ color: '#555' }}><b>∇f(x₀)</b> = {grad.toFixed(3)}</span>
        {finalPoint && <span style={{ color: '#16a34a' }}><b>x*</b> ≈ {finalPoint[0].toFixed(3)}</span>}
      </div>
    </div>
  );
}
