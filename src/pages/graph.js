import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import Layout from '@theme/Layout';
import BrowserOnly from '@docusaurus/BrowserOnly';
import API_BASE from '@site/src/utils/api';
import ErrorBoundary from '@site/src/components/ErrorBoundary';

// Category color palette
const CATEGORY_COLORS = {
  math: '#3b82f6',
  programming: '#22c55e',
  survey: '#a855f7',
  builder: '#f59e0b',
  blog: '#ec4899',
  research: '#ef4444',
};
const DEFAULT_COLOR = '#6b7280';

function getCategoryColor(category) {
  return CATEGORY_COLORS[category] || DEFAULT_COLOR;
}

function truncate(str, len) {
  if (!str) return '';
  return str.length > len ? str.slice(0, len) + '...' : str;
}

/**
 * Simple force-directed layout computed iteratively.
 * Runs a fixed number of iterations, then returns positioned nodes.
 */
function computeLayout(nodes, edges, width, height) {
  const n = nodes.length;
  if (n === 0) return [];

  // Initialize positions randomly within bounds
  const positions = nodes.map(() => ({
    x: width * 0.15 + Math.random() * width * 0.7,
    y: height * 0.15 + Math.random() * height * 0.7,
    vx: 0,
    vy: 0,
  }));

  // Build adjacency index
  const idIndex = {};
  nodes.forEach((node, i) => { idIndex[node.id] = i; });

  const edgeIndices = [];
  for (const edge of edges) {
    const si = idIndex[edge.source];
    const ti = idIndex[edge.target];
    if (si !== undefined && ti !== undefined && si !== ti) {
      edgeIndices.push([si, ti]);
    }
  }

  // Build adjacency set for each node
  const adjacency = nodes.map(() => new Set());
  for (const [si, ti] of edgeIndices) {
    adjacency[si].add(ti);
    adjacency[ti].add(si);
  }

  const iterations = 300;
  const repulsionStrength = 5000;
  const attractionStrength = 0.005;
  const idealEdgeLength = 120;
  const damping = 0.85;
  const maxSpeed = 15;
  const centerGravity = 0.01;
  const cx = width / 2;
  const cy = height / 2;

  for (let iter = 0; iter < iterations; iter++) {
    const cooling = 1 - iter / iterations;

    // Repulsion (all pairs, using simplified O(n^2) approach)
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = positions[i].x - positions[j].x;
        let dy = positions[i].y - positions[j].y;
        let dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 1) { dist = 1; dx = Math.random() - 0.5; dy = Math.random() - 0.5; }
        const force = repulsionStrength / (dist * dist);
        const fx = (dx / dist) * force * cooling;
        const fy = (dy / dist) * force * cooling;
        positions[i].vx += fx;
        positions[i].vy += fy;
        positions[j].vx -= fx;
        positions[j].vy -= fy;
      }
    }

    // Attraction (edges)
    for (const [si, ti] of edgeIndices) {
      let dx = positions[ti].x - positions[si].x;
      let dy = positions[ti].y - positions[si].y;
      let dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 1) dist = 1;
      const displacement = dist - idealEdgeLength;
      const force = attractionStrength * displacement * cooling;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      positions[si].vx += fx;
      positions[si].vy += fy;
      positions[ti].vx -= fx;
      positions[ti].vy -= fy;
    }

    // Center gravity
    for (let i = 0; i < n; i++) {
      positions[i].vx += (cx - positions[i].x) * centerGravity * cooling;
      positions[i].vy += (cy - positions[i].y) * centerGravity * cooling;
    }

    // Apply velocities
    for (let i = 0; i < n; i++) {
      positions[i].vx *= damping;
      positions[i].vy *= damping;
      const speed = Math.sqrt(positions[i].vx * positions[i].vx + positions[i].vy * positions[i].vy);
      if (speed > maxSpeed) {
        positions[i].vx = (positions[i].vx / speed) * maxSpeed;
        positions[i].vy = (positions[i].vy / speed) * maxSpeed;
      }
      positions[i].x += positions[i].vx;
      positions[i].y += positions[i].vy;
    }
  }

  return positions;
}

function GraphVisualization() {
  const [graphData, setGraphData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [hoveredNode, setHoveredNode] = useState(null);
  const [viewBox, setViewBox] = useState(null);
  const [dimensions, setDimensions] = useState({ width: 1200, height: 800 });
  const svgRef = useRef(null);
  const containerRef = useRef(null);
  const isPanning = useRef(false);
  const panStart = useRef({ x: 0, y: 0 });
  const viewBoxStart = useRef(null);

  // Responsive sizing
  useEffect(() => {
    function updateSize() {
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        setDimensions({ width: rect.width || 1200, height: Math.max(rect.height, 600) });
      }
    }
    updateSize();
    window.addEventListener('resize', updateSize);
    return () => window.removeEventListener('resize', updateSize);
  }, []);

  // Fetch graph data
  useEffect(() => {
    async function fetchGraph() {
      setLoading(true);
      setError(null);
      try {
        const resp = await fetch(`${API_BASE}/api/graph`);
        if (!resp.ok) {
          const data = await resp.json().catch(() => ({}));
          throw new Error(data.error || `HTTP ${resp.status}`);
        }
        const data = await resp.json();
        setGraphData(data);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }
    fetchGraph();
  }, []);

  // Compute layout once data is available
  const [positions, setPositions] = useState(null);
  useEffect(() => {
    if (!graphData || !graphData.nodes.length) return;
    const { width, height } = dimensions;
    const pos = computeLayout(graphData.nodes, graphData.edges, width, height);
    setPositions(pos);
    setViewBox({ x: 0, y: 0, w: width, h: height });
  }, [graphData, dimensions]);

  // Build adjacency map for hover highlighting
  const adjacencyMap = useRef({});
  useEffect(() => {
    if (!graphData) return;
    const map = {};
    for (const node of graphData.nodes) {
      map[node.id] = new Set();
    }
    for (const edge of graphData.edges) {
      if (map[edge.source]) map[edge.source].add(edge.target);
      if (map[edge.target]) map[edge.target].add(edge.source);
    }
    adjacencyMap.current = map;
  }, [graphData]);

  // Zoom handler
  const handleWheel = useCallback((e) => {
    e.preventDefault();
    if (!viewBox) return;
    const scaleFactor = e.deltaY > 0 ? 1.1 : 0.9;
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    // Mouse position in SVG coordinates
    const mx = viewBox.x + (e.clientX - rect.left) / rect.width * viewBox.w;
    const my = viewBox.y + (e.clientY - rect.top) / rect.height * viewBox.h;
    const newW = viewBox.w * scaleFactor;
    const newH = viewBox.h * scaleFactor;
    setViewBox({
      x: mx - (mx - viewBox.x) * scaleFactor,
      y: my - (my - viewBox.y) * scaleFactor,
      w: newW,
      h: newH,
    });
  }, [viewBox]);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    svg.addEventListener('wheel', handleWheel, { passive: false });
    return () => svg.removeEventListener('wheel', handleWheel);
  }, [handleWheel]);

  // Pan handlers
  const handleMouseDown = useCallback((e) => {
    if (e.target.closest('.graph-node')) return;
    isPanning.current = true;
    panStart.current = { x: e.clientX, y: e.clientY };
    viewBoxStart.current = viewBox ? { ...viewBox } : null;
  }, [viewBox]);

  const handleMouseMove = useCallback((e) => {
    if (!isPanning.current || !viewBoxStart.current) return;
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const dx = (e.clientX - panStart.current.x) / rect.width * viewBoxStart.current.w;
    const dy = (e.clientY - panStart.current.y) / rect.height * viewBoxStart.current.h;
    setViewBox({
      x: viewBoxStart.current.x - dx,
      y: viewBoxStart.current.y - dy,
      w: viewBoxStart.current.w,
      h: viewBoxStart.current.h,
    });
  }, []);

  const handleMouseUp = useCallback(() => {
    isPanning.current = false;
  }, []);

  // Node click handler
  const handleNodeClick = useCallback((node) => {
    // Determine URL from node path and category
    const parts = node.path.split('/');
    let url;
    if (parts[0] === 'books') {
      // books/math/foo.md -> /math/foo
      url = '/' + parts.slice(1).join('/').replace(/\.(mdx?|md)$/, '');
    } else if (parts[0] === 'posts') {
      // posts/blog/foo.md -> /blog/foo
      url = '/' + parts.slice(1).join('/').replace(/\.(mdx?|md)$/, '');
    } else {
      url = '/' + node.path.replace(/\.(mdx?|md)$/, '');
    }
    // Strip trailing /index
    if (url.endsWith('/index')) url = url.slice(0, -6);
    window.location.href = url;
  }, []);

  // Determine if a node/edge is highlighted
  const isConnected = useCallback((nodeId) => {
    if (!hoveredNode) return true;
    if (nodeId === hoveredNode) return true;
    return adjacencyMap.current[hoveredNode]?.has(nodeId) || false;
  }, [hoveredNode]);

  if (loading) {
    return (
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', padding: '4rem', gap: '1rem',
      }}>
        <div style={{
          width: 40, height: 40,
          border: '3px solid var(--ifm-color-emphasis-200)',
          borderTopColor: 'var(--ifm-color-primary)',
          borderRadius: '50%',
          animation: 'spin 0.8s linear infinite',
        }} />
        <p style={{ color: 'var(--ifm-color-emphasis-600)', fontSize: '0.9em' }}>
          Building knowledge graph...
        </p>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{
        color: 'var(--ifm-color-danger-dark)',
        background: 'var(--ifm-color-danger-contrast-background)',
        border: '1px solid var(--ifm-color-danger-dark)',
        borderRadius: 6, padding: '1rem', margin: '2rem auto', maxWidth: 600,
        fontSize: '0.9em',
      }}>
        Failed to load graph: {error}
      </div>
    );
  }

  if (!graphData || !graphData.nodes.length) {
    return (
      <div style={{ textAlign: 'center', padding: '4rem', color: 'var(--ifm-color-emphasis-500)' }}>
        <p style={{ fontSize: '1.1em', fontWeight: 500 }}>No pages found</p>
        <p style={{ fontSize: '0.9em' }}>Add some markdown files with [[wiki links]] to see the graph.</p>
      </div>
    );
  }

  // Memoize derived data so it doesn't recompute on every hover/pan re-render
  const { edgeCounts, idToIdx, categories } = useMemo(() => {
    if (!graphData) return { edgeCounts: {}, idToIdx: {}, categories: [] };
    const ec = {};
    for (const node of graphData.nodes) ec[node.id] = 0;
    for (const edge of graphData.edges) {
      ec[edge.source] = (ec[edge.source] || 0) + 1;
      ec[edge.target] = (ec[edge.target] || 0) + 1;
    }
    const idx = {};
    graphData.nodes.forEach((n, i) => { idx[n.id] = i; });
    const cats = [...new Set(graphData.nodes.map(n => n.category).filter(Boolean))].sort();
    return { edgeCounts: ec, idToIdx: idx, categories: cats };
  }, [graphData]);

  if (!positions || !viewBox) return null;

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: 'calc(100vh - 60px)',
        position: 'relative',
        overflow: 'hidden',
        background: 'var(--ifm-background-color)',
      }}
    >
      {/* Legend */}
      <div style={{
        position: 'absolute', top: 12, left: 12, zIndex: 10,
        background: 'var(--ifm-card-background-color, var(--ifm-background-color))',
        border: '1px solid var(--ifm-color-emphasis-200)',
        borderRadius: 8, padding: '10px 14px',
        fontSize: '0.78em', lineHeight: 1.8,
        maxWidth: 200,
        boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
      }}>
        <div style={{ fontWeight: 600, marginBottom: 4, fontSize: '0.9em', color: 'var(--ifm-color-emphasis-700)' }}>
          Categories
        </div>
        {categories.map(cat => (
          <div key={cat} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{
              display: 'inline-block', width: 10, height: 10, borderRadius: '50%',
              background: getCategoryColor(cat), flexShrink: 0,
            }} />
            <span style={{ color: 'var(--ifm-color-emphasis-700)' }}>{cat}</span>
          </div>
        ))}
        <div style={{ marginTop: 8, fontSize: '0.85em', color: 'var(--ifm-color-emphasis-500)' }}>
          {graphData.nodes.length} pages, {graphData.edges.length} links
        </div>
      </div>

      {/* Controls */}
      <div style={{
        position: 'absolute', top: 12, right: 12, zIndex: 10,
        display: 'flex', flexDirection: 'column', gap: 4,
      }}>
        <button
          onClick={() => setViewBox({ x: 0, y: 0, w: dimensions.width, h: dimensions.height })}
          style={{
            padding: '6px 12px', fontSize: '0.8em', fontWeight: 600, fontFamily: 'inherit',
            border: '1px solid var(--ifm-color-emphasis-300)', borderRadius: 6,
            background: 'var(--ifm-card-background-color, var(--ifm-background-color))',
            color: 'var(--ifm-color-emphasis-700)', cursor: 'pointer',
            boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
          }}
          title="Reset zoom"
        >
          Reset View
        </button>
      </div>

      {/* Tooltip */}
      {hoveredNode && (() => {
        const idx = idToIdx[hoveredNode];
        if (idx === undefined) return null;
        const node = graphData.nodes[idx];
        const pos = positions[idx];
        const svg = svgRef.current;
        if (!svg || !viewBox) return null;
        const rect = svg.getBoundingClientRect();
        const screenX = rect.left + ((pos.x - viewBox.x) / viewBox.w) * rect.width;
        const screenY = rect.top + ((pos.y - viewBox.y) / viewBox.h) * rect.height;
        return (
          <div style={{
            position: 'fixed', left: screenX + 12, top: screenY - 30,
            background: 'var(--ifm-card-background-color, #fff)',
            border: '1px solid var(--ifm-color-emphasis-300)',
            borderRadius: 6, padding: '6px 10px', fontSize: '0.82em',
            zIndex: 20, pointerEvents: 'none',
            boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
            maxWidth: 280,
          }}>
            <div style={{ fontWeight: 600, marginBottom: 2 }}>{node.title}</div>
            <div style={{ color: 'var(--ifm-color-emphasis-500)', fontSize: '0.9em' }}>
              {node.category && <span>{node.category} / </span>}
              {edgeCounts[node.id] || 0} connections
            </div>
          </div>
        );
      })()}

      <svg
        ref={svgRef}
        width="100%"
        height="100%"
        viewBox={viewBox ? `${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}` : `0 0 ${dimensions.width} ${dimensions.height}`}
        style={{ cursor: isPanning.current ? 'grabbing' : 'grab' }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        {/* Edges */}
        {graphData.edges.map((edge, i) => {
          const si = idToIdx[edge.source];
          const ti = idToIdx[edge.target];
          if (si === undefined || ti === undefined) return null;
          const sp = positions[si];
          const tp = positions[ti];
          const highlighted = isConnected(edge.source) && isConnected(edge.target);
          return (
            <line
              key={`e-${i}`}
              x1={sp.x} y1={sp.y}
              x2={tp.x} y2={tp.y}
              stroke={highlighted ? 'var(--ifm-color-emphasis-400)' : 'var(--ifm-color-emphasis-200)'}
              strokeWidth={highlighted && hoveredNode ? 1.5 : 0.8}
              opacity={hoveredNode ? (highlighted ? 0.8 : 0.1) : 0.4}
            />
          );
        })}

        {/* Nodes */}
        {graphData.nodes.map((node, i) => {
          const pos = positions[i];
          const connections = edgeCounts[node.id] || 0;
          const radius = Math.max(4, Math.min(14, 4 + connections * 1.5));
          const color = getCategoryColor(node.category);
          const highlighted = isConnected(node.id);
          const isHovered = hoveredNode === node.id;

          return (
            <g
              key={node.id}
              className="graph-node"
              style={{ cursor: 'pointer' }}
              onMouseEnter={() => setHoveredNode(node.id)}
              onMouseLeave={() => setHoveredNode(null)}
              onClick={() => handleNodeClick(node)}
              opacity={hoveredNode ? (highlighted ? 1 : 0.15) : 1}
            >
              <circle
                cx={pos.x} cy={pos.y} r={radius}
                fill={color}
                stroke={isHovered ? '#fff' : 'none'}
                strokeWidth={isHovered ? 2 : 0}
                filter={isHovered ? 'url(#glow)' : undefined}
              />
              {/* Show label at sufficient zoom or on hover */}
              {(isHovered || (viewBox && viewBox.w < dimensions.width * 1.5 && connections >= 1)) && (
                <text
                  x={pos.x}
                  y={pos.y + radius + 12}
                  textAnchor="middle"
                  fill="var(--ifm-color-emphasis-700)"
                  fontSize={isHovered ? 11 : 9}
                  fontWeight={isHovered ? 600 : 400}
                  fontFamily="var(--ifm-font-family-base)"
                  pointerEvents="none"
                >
                  {truncate(node.title, 24)}
                </text>
              )}
            </g>
          );
        })}

        {/* Glow filter for hovered node */}
        <defs>
          <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
      </svg>
    </div>
  );
}

export default function GraphPage() {
  return (
    <Layout title="Knowledge Graph" description="Visual graph of wiki link connections between all pages">
      <BrowserOnly>{() => <ErrorBoundary><GraphVisualization /></ErrorBoundary>}</BrowserOnly>
    </Layout>
  );
}
