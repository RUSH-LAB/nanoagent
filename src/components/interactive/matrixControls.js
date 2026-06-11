// Shared controls for the 2x2 matrix interactive demos (EigenDemo, LinearTransformDemo).

export function applyMatrix(matrix, v) {
  return [
    matrix[0][0] * v[0] + matrix[0][1] * v[1],
    matrix[1][0] * v[0] + matrix[1][1] * v[1],
  ];
}

export function Slider({ label, value, onChange, min = -3, max = 3, step = 0.1, width = '120px' }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: '0.5em', fontSize: '0.9rem' }}>
      <span style={{ fontFamily: 'serif', fontStyle: 'italic', minWidth: '1.5em' }}>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))} style={{ width }} />
      <span style={{ fontFamily: 'monospace', minWidth: '3.5em', textAlign: 'right' }}>{value.toFixed(1)}</span>
    </label>
  );
}
