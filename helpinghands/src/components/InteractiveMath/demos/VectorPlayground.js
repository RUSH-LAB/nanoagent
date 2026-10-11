import { Mafs, Coordinates, Vector, Line, Text, useMovablePoint, Theme } from 'mafs';
import 'mafs/core.css';

export default function VectorPlayground() {
  const a = useMovablePoint([3, 1], { color: Theme.blue });
  const b = useMovablePoint([1, 3], { color: Theme.red });

  const [ax, ay] = a.point;
  const [bx, by] = b.point;

  const dot = ax * bx + ay * by;
  const magA = Math.sqrt(ax * ax + ay * ay);
  const magB = Math.sqrt(bx * bx + by * by);
  const cosTheta = magA > 0.01 && magB > 0.01 ? dot / (magA * magB) : 0;
  const angle = Math.acos(Math.max(-1, Math.min(1, cosTheta)));
  const angleDeg = (angle * 180 / Math.PI).toFixed(1);

  const projScale = magA > 0.01 ? dot / (magA * magA) : 0;
  const projX = projScale * ax;
  const projY = projScale * ay;

  return (
    <div style={{ margin: '1.5em 0' }}>
      <Mafs viewBox={{ x: [-5, 5], y: [-5, 5] }} preserveAspectRatio={false}>
        <Coordinates.Cartesian />
        <Vector tip={a.point} color={Theme.blue} />
        <Vector tip={b.point} color={Theme.red} />
        <Vector tip={[projX, projY]} color={Theme.green} opacity={0.6} weight={3} />
        <Line.Segment point1={b.point} point2={[projX, projY]} color="#aaa" style="dashed" weight={1} />
        <Text x={ax * 0.55 - 0.4} y={ay * 0.55 + 0.3} color={Theme.blue} size={18}>a</Text>
        <Text x={bx * 0.55 + 0.3} y={by * 0.55 + 0.3} color={Theme.red} size={18}>b</Text>
        {a.element}
        {b.element}
      </Mafs>
      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: '1.5em', justifyContent: 'center',
        marginTop: '0.75em', fontSize: '0.95rem', color: '#555',
        fontFamily: '"Inter", system-ui, sans-serif',
      }}>
        <span><b>a · b</b> = {dot.toFixed(2)}</span>
        <span><b>|a|</b> = {magA.toFixed(2)}</span>
        <span><b>|b|</b> = {magB.toFixed(2)}</span>
        <span><b>θ</b> = {angleDeg}°</span>
        <span><b>cos θ</b> = {cosTheta.toFixed(3)}</span>
      </div>
    </div>
  );
}
