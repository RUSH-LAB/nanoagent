import React, { useState, useEffect, useRef, useCallback } from 'react';
import Layout from '@theme/Layout';
import BrowserOnly from '@docusaurus/BrowserOnly';
import ErrorBoundary from '@site/src/components/ErrorBoundary';
import API_BASE from '@site/src/utils/api';

const DEPTH_COLORS = ['#6366f1', '#3b82f6', '#22c55e', '#f59e0b', '#ef4444'];
const NODE_RX = 80;
const NODE_RY = 24;

function depthColor(d) {
  return DEPTH_COLORS[Math.min(d, DEPTH_COLORS.length - 1)];
}

// Assign (x,y) to every node using a radial layout
function layoutTree(root, width, height) {
  const cx = width / 2;
  const cy = height / 2;
  const nodes = [];
  const edges = [];

  function walk(node, depth, angleStart, angleEnd, parent) {
    let x, y;
    if (depth === 0) {
      x = cx;
      y = cy;
    } else {
      const angleMid = (angleStart + angleEnd) / 2;
      const radius = depth * 180;
      x = cx + radius * Math.cos(angleMid);
      y = cy + radius * Math.sin(angleMid);
    }
    const id = nodes.length;
    nodes.push({ id, text: node.text, x, y, depth });
    if (parent !== null) {
      edges.push({ from: parent, to: id });
    }
    const children = node.children || [];
    if (children.length === 0) return;
    const span = angleEnd - angleStart;
    const childSpan = span / children.length;
    children.forEach((child, i) => {
      walk(child, depth + 1, angleStart + i * childSpan, angleStart + (i + 1) * childSpan, id);
    });
  }

  walk(root, 0, 0, 2 * Math.PI, null);
  return { nodes, edges };
}

function MindmapContent() {
  const [files, setFiles] = useState([]);
  const [filesLoading, setFilesLoading] = useState(true);
  const [filesError, setFilesError] = useState(null);
  const [selected, setSelected] = useState('');
  const [tree, setTree] = useState(null);
  const [treeLoading, setTreeLoading] = useState(false);
  const [error, setError] = useState(null);
  const svgRef = useRef(null);
  const [dims, setDims] = useState({ w: 960, h: 700 });

  useEffect(() => {
    setFilesLoading(true);
    setFilesError(null);
    fetch(`${API_BASE}/api/files`)
      .then(r => {
        if (!r.ok) throw new Error(`Failed to load file list (${r.status})`);
        return r.json();
      })
      .then(d => {
        const flat = [];
        const flatten = (list) => {
          for (const f of list) {
            if (f.children) flatten(f.children);
            else flat.push(f);
          }
        };
        flatten(d.files || []);
        setFiles(flat.filter(f => /\.(md|mdx)$/.test(f.name)));
        setFilesLoading(false);
      })
      .catch(err => {
        setFilesError(err.message);
        setFiles([]);
        setFilesLoading(false);
      });
  }, []);

  useEffect(() => {
    const onResize = () => {
      setDims({ w: Math.max(600, window.innerWidth - 80), h: Math.max(500, window.innerHeight - 220) });
    };
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const fetchMindmap = useCallback((filePath) => {
    setError(null);
    setTree(null);
    if (!filePath) { setTreeLoading(false); return; }
    setTreeLoading(true);
    fetch(`${API_BASE}/api/file/mindmap?path=${encodeURIComponent(filePath)}`)
      .then(r => {
        if (!r.ok) throw new Error(`Failed to generate mindmap (${r.status})`);
        return r.json();
      })
      .then(d => {
        if (d.error) { setError(d.error); setTreeLoading(false); return; }
        setTree(d.root);
        setTreeLoading(false);
      })
      .catch(e => { setError(e.message); setTreeLoading(false); });
  }, []);

  const handleSelect = (e) => {
    const val = e.target.value;
    setSelected(val);
    fetchMindmap(val);
  };

  const handleNodeClick = useCallback((text) => {
    const slug = text.toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
    if (selected) {
      const page = selected.replace(/^content\//, '').replace(/\.(md|mdx)$/, '');
      window.location.href = `/docs/${page}#${slug}`;
    }
  }, [selected]);

  const { nodes, edges } = tree ? layoutTree(tree, dims.w, dims.h) : { nodes: [], edges: [] };

  return (
    <div style={{ padding: '20px 40px' }}>
      <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
        <label htmlFor="mindmap-doc-select" style={{ fontWeight: 600, fontSize: 14 }}>Document:</label>
        {filesLoading ? (
          <span style={{ color: 'var(--ifm-color-emphasis-500)', fontSize: 14 }}>Loading file list...</span>
        ) : filesError ? (
          <span style={{ color: '#ef4444', fontSize: 14 }}>Failed to load files: {filesError}</span>
        ) : (
        <select
          id="mindmap-doc-select"
          value={selected}
          onChange={handleSelect}
          aria-label="Select document for mindmap"
          style={{
            padding: '6px 12px',
            borderRadius: 6,
            border: '1px solid #d1d5db',
            fontSize: 14,
            minWidth: 300,
            background: 'var(--ifm-background-color)',
            color: 'var(--ifm-font-color-base)',
          }}
        >
          <option value="">-- Select a file --</option>
          {files.map(f => (
            <option key={f.path} value={f.path}>{f.path}</option>
          ))}
        </select>
        )}
      </div>

      {!filesLoading && !filesError && files.length === 0 && (
        <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>
          No markdown files found. Add some .md or .mdx files to generate mindmaps.
        </div>
      )}

      {error && (
        <div role="alert" style={{ color: '#ef4444', padding: 12, background: '#fef2f2', borderRadius: 8, marginBottom: 12 }}>
          {error}
        </div>
      )}

      {tree && nodes.length > 0 && (
        <svg
          ref={svgRef}
          width={dims.w}
          height={dims.h}
          role="img"
          aria-label={`Mindmap for ${selected || 'document'} with ${nodes.length} nodes`}
          style={{ border: '1px solid #e5e7eb', borderRadius: 12, background: '#fafafa' }}
        >
          <title>Mindmap: {selected}</title>
          {/* Edges */}
          {edges.map((e, i) => {
            const from = nodes[e.from];
            const to = nodes[e.to];
            return (
              <line
                key={`e${i}`}
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
                stroke="#cbd5e1"
                strokeWidth={1.5}
              />
            );
          })}
          {/* Nodes */}
          {nodes.map((n) => {
            const fill = depthColor(n.depth);
            const label = n.text.length > 28 ? n.text.slice(0, 26) + '...' : n.text;
            return (
              <g
                key={n.id}
                style={{ cursor: n.depth > 0 ? 'pointer' : 'default' }}
                onClick={() => n.depth > 0 && handleNodeClick(n.text)}
              >
                <ellipse
                  cx={n.x}
                  cy={n.y}
                  rx={NODE_RX}
                  ry={NODE_RY}
                  fill={fill}
                  fillOpacity={0.15}
                  stroke={fill}
                  strokeWidth={2}
                />
                <text
                  x={n.x}
                  y={n.y}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize={n.depth === 0 ? 13 : 11}
                  fontWeight={n.depth === 0 ? 700 : 500}
                  fill={fill}
                >
                  {label}
                </text>
              </g>
            );
          })}
        </svg>
      )}

      {treeLoading && selected && (
        <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>
          <div style={{
            width: 32, height: 32, margin: '0 auto 12px',
            border: '3px solid var(--ifm-color-emphasis-200)',
            borderTopColor: 'var(--ifm-color-primary)',
            borderRadius: '50%',
            animation: 'mindmap-spin 0.8s linear infinite',
          }} />
          <style>{`@keyframes mindmap-spin { to { transform: rotate(360deg); } }`}</style>
          Generating mindmap...
        </div>
      )}
      {!selected && (
        <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>
          Select a document to generate its mindmap.
        </div>
      )}
    </div>
  );
}

export default function MindmapPage() {
  return (
    <Layout title="Mind Map" description="Visual mindmap from document headings">
      <BrowserOnly>{() => <ErrorBoundary><MindmapContent /></ErrorBoundary>}</BrowserOnly>
    </Layout>
  );
}
