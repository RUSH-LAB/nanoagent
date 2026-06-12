import { useState } from 'react';
import { Mafs, Coordinates, Vector, Polygon, Line, Text, Theme } from 'mafs';
import 'mafs/core.css';
import { applyMatrix, MatrixControls } from './matrixControls';

export default function LinearTransformDemo() {
  const [a, setA] = useState(1);
  const [b, setB] = useState(0.5);
  const [c, setC] = useState(0);
  const [d, setD] = useState(1);

  const matrix = [[a, b], [c, d]];
  const det = a * d - b * c;
  const e1 = [1, 0], e2 = [0, 1];
  const te1 = applyMatrix(matrix, e1);
  const te2 = applyMatrix(matrix, e2);
  const unitSquare = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const transformedSquare = unitSquare.map((v) => applyMatrix(matrix, v));

  const gridLines = [];
  for (let i = -4; i <= 4; i++) {
    gridLines.push({ p1: applyMatrix(matrix, [i, -5]), p2: applyMatrix(matrix, [i, 5]) });
    gridLines.push({ p1: applyMatrix(matrix, [-5, i]), p2: applyMatrix(matrix, [5, i]) });
  }

  return (
    <div style={{ margin: '1.5em 0' }}>
      <Mafs viewBox={{ x: [-5, 5], y: [-5, 5] }} preserveAspectRatio={false}>
        <Coordinates.Cartesian />
        {gridLines.map((line, i) => (
          <Line.Segment key={i} point1={line.p1} point2={line.p2}
            color="rgba(100, 149, 237, 0.15)" weight={1} />
        ))}
        <Polygon points={unitSquare} color="rgba(100, 149, 237, 0.1)" strokeStyle="dashed" weight={1} />
        <Polygon points={transformedSquare} color="rgba(59, 130, 246, 0.2)" weight={2} />
        <Vector tip={e1} color="#aaa" weight={1} />
        <Vector tip={e2} color="#aaa" weight={1} />
        <Vector tip={te1} color={Theme.blue} weight={3} />
        <Vector tip={te2} color={Theme.red} weight={3} />
        <Text x={te1[0] + 0.3} y={te1[1] + 0.3} color={Theme.blue} size={16}>Ae₁</Text>
        <Text x={te2[0] + 0.3} y={te2[1] + 0.3} color={Theme.red} size={16}>Ae₂</Text>
      </Mafs>
      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: '1em 2em',
        justifyContent: 'center', alignItems: 'center',
        marginTop: '0.75em', padding: '0.75em 1em',
        background: '#f5f7f9', borderRadius: '8px',
      }}>
        <MatrixControls
          a={a} b={b} c={c} d={d}
          setA={setA} setB={setB} setC={setC} setD={setD}
        />
        <span style={{ fontSize: '0.95rem', color: '#555' }}><b>det(A)</b> = {det.toFixed(2)}</span>
      </div>
    </div>
  );
}
