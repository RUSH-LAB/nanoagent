import { useRef, useEffect, useState, useCallback } from 'react';
import { CONTROL_PANEL_STYLE } from './controlPanelStyle';

const PRESETS = [
  {
    label: 'Paraboloid: z = x² + y²',
    fn: (x, y) => x * x + y * y,
    range: 2, zScale: 0.25,
  },
  {
    label: 'Saddle: z = x² − y²',
    fn: (x, y) => x * x - y * y,
    range: 2, zScale: 0.35,
  },
  {
    label: 'Gaussian: z = 2·e^(−x²−y²)',
    fn: (x, y) => 2 * Math.exp(-(x * x + y * y)),
    range: 3, zScale: 1,
  },
  {
    label: 'Wave: z = sin(x)·cos(y)',
    fn: (x, y) => Math.sin(x) * Math.cos(y),
    range: 5, zScale: 1,
  },
  {
    label: 'Ripple: z = sin(√(x²+y²))',
    fn: (x, y) => Math.sin(Math.sqrt(x * x + y * y + 0.01)),
    range: 6, zScale: 1,
  },
];

function heightColor(t) {
  const r = Math.round(Math.min(255, Math.max(0, (1.5 * t - 0.25) * 255)));
  const g = Math.round(Math.min(255, Math.max(0, (t < 0.5 ? 2 * t : 2 - 2 * t) * 255)));
  const b = Math.round(Math.min(255, Math.max(0, (1.25 - 1.5 * t) * 255)));
  return `rgb(${r},${g},${b})`;
}

function project(x, y, z, rotX, rotY) {
  const cy = Math.cos(rotY), sy = Math.sin(rotY);
  const cx = Math.cos(rotX), sx = Math.sin(rotX);
  const x1 = x * cy - z * sy;
  const z1 = x * sy + z * cy;
  const y1 = y * cx - z1 * sx;
  const z2 = y * sx + z1 * cx;
  return { px: x1, py: -y1, depth: z2 };
}

function drawSurface(ctx, w, h, fn, range, zScale, rotX, rotY, wireframe) {
  const res = 50;
  const step = (2 * range) / res;
  const scale = Math.min(w, h) * 0.3 / range;

  ctx.clearRect(0, 0, w, h);
  ctx.save();
  ctx.translate(w / 2, h / 2);

  let zMin = Infinity, zMax = -Infinity;
  const grid = [];
  for (let i = 0; i <= res; i++) {
    grid[i] = [];
    for (let j = 0; j <= res; j++) {
      const x = -range + i * step;
      const y = -range + j * step;
      const z = fn(x, y);
      const zs = isFinite(z) ? z * zScale : 0;
      grid[i][j] = { x, y, z: isFinite(z) ? z : 0, zs };
      if (isFinite(z)) {
        zMin = Math.min(zMin, z);
        zMax = Math.max(zMax, z);
      }
    }
  }

  const zRange = zMax - zMin || 1;
  const quads = [];

  for (let i = 0; i < res; i++) {
    for (let j = 0; j < res; j++) {
      const corners = [grid[i][j], grid[i + 1][j], grid[i + 1][j + 1], grid[i][j + 1]];
      const projected = corners.map(c => project(c.x, c.zs, c.y, rotX, rotY));
      const avgZ = (corners[0].z + corners[1].z + corners[2].z + corners[3].z) / 4;
      const depth = (projected[0].depth + projected[1].depth + projected[2].depth + projected[3].depth) / 4;
      quads.push({ projected, t: (avgZ - zMin) / zRange, depth });
    }
  }

  quads.sort((a, b) => b.depth - a.depth);

  for (const quad of quads) {
    ctx.beginPath();
    ctx.moveTo(quad.projected[0].px * scale, quad.projected[0].py * scale);
    for (let k = 1; k < 4; k++) {
      ctx.lineTo(quad.projected[k].px * scale, quad.projected[k].py * scale);
    }
    ctx.closePath();

    if (!wireframe) {
      ctx.fillStyle = heightColor(quad.t);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.08)';
      ctx.lineWidth = 0.5;
    } else {
      ctx.strokeStyle = heightColor(quad.t);
      ctx.lineWidth = 0.8;
    }
    ctx.stroke();
  }

  const axisLen = range * 1.3;
  const axes = [
    { from: [0, 0, 0], to: [axisLen, 0, 0], color: '#e74c3c', label: 'x' },
    { from: [0, 0, 0], to: [0, axisLen * zScale, 0], color: '#2ecc71', label: 'z' },
    { from: [0, 0, 0], to: [0, 0, axisLen], color: '#3498db', label: 'y' },
  ];

  for (const axis of axes) {
    const p1 = project(axis.from[0], axis.from[1], axis.from[2], rotX, rotY);
    const p2 = project(axis.to[0], axis.to[1], axis.to[2], rotX, rotY);
    ctx.beginPath();
    ctx.moveTo(p1.px * scale, p1.py * scale);
    ctx.lineTo(p2.px * scale, p2.py * scale);
    ctx.strokeStyle = axis.color;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = axis.color;
    ctx.font = 'bold 14px Inter, system-ui, sans-serif';
    ctx.fillText(axis.label, p2.px * scale + 8, p2.py * scale - 4);
  }

  ctx.restore();
}

export default function Surface3DDemo() {
  const canvasRef = useRef(null);
  const [presetIdx, setPresetIdx] = useState(0);
  const [wireframe, setWireframe] = useState(false);
  const [rotation, setRotation] = useState({ x: -0.6, y: 0.8 });
  const [dragging, setDragging] = useState(false);
  const lastPos = useRef(null);
  const [autoRotate, setAutoRotate] = useState(true);

  const preset = PRESETS[presetIdx];

  useEffect(() => {
    if (!autoRotate) return;
    let frame;
    const tick = () => {
      setRotation(r => ({ ...r, y: r.y + 0.008 }));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [autoRotate]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    drawSurface(ctx, rect.width, rect.height, preset.fn, preset.range, preset.zScale, rotation.x, rotation.y, wireframe);
  }, [rotation, presetIdx, wireframe, preset]);

  const handlePointerDown = useCallback((e) => {
    setDragging(true);
    setAutoRotate(false);
    lastPos.current = { x: e.clientX, y: e.clientY };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, []);

  const handlePointerMove = useCallback((e) => {
    if (!dragging || !lastPos.current) return;
    const dx = e.clientX - lastPos.current.x;
    const dy = e.clientY - lastPos.current.y;
    setRotation(r => ({
      x: Math.max(-Math.PI / 2, Math.min(Math.PI / 2, r.x + dy * 0.006)),
      y: r.y + dx * 0.006,
    }));
    lastPos.current = { x: e.clientX, y: e.clientY };
  }, [dragging]);

  const handlePointerUp = useCallback(() => {
    setDragging(false);
    lastPos.current = null;
  }, []);

  return (
    <div style={{ margin: '1.5em 0' }}>
      <canvas
        ref={canvasRef}
        style={{
          width: '100%', height: 420, borderRadius: '8px', display: 'block',
          background: 'linear-gradient(180deg, #0d1117 0%, #161b22 100%)',
          cursor: dragging ? 'grabbing' : 'grab',
          touchAction: 'none',
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
      />
      <div style={{ ...CONTROL_PANEL_STYLE, gap: '0.8em 1.5em' }}>
        <select value={presetIdx} onChange={(e) => setPresetIdx(Number(e.target.value))}
          style={{
            padding: '0.3em 0.5em', borderRadius: '4px',
            border: '1px solid #d1d5db', fontSize: '0.85rem',
          }}>
          {PRESETS.map((p, i) => (
            <option key={i} value={i}>{p.label}</option>
          ))}
        </select>
        <label style={{
          display: 'flex', alignItems: 'center', gap: '0.4em', cursor: 'pointer',
        }}>
          <input type="checkbox" checked={wireframe}
            onChange={(e) => setWireframe(e.target.checked)} />
          <span>Wireframe</span>
        </label>
        <label style={{
          display: 'flex', alignItems: 'center', gap: '0.4em', cursor: 'pointer',
        }}>
          <input type="checkbox" checked={autoRotate}
            onChange={(e) => setAutoRotate(e.target.checked)} />
          <span>Auto-rotate</span>
        </label>
      </div>
    </div>
  );
}
