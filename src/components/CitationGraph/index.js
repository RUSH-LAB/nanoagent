import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { useHistory } from '@docusaurus/router';
import styles from './styles.module.css';

/**
 * CitationGraph - Year-axis network graph of bibliography references.
 *
 * Layout: papers are grouped by year on the y-axis and spread on the x-axis.
 * Nodes are colored by year (lighter = older, darker = newer).
 * Hover shows tooltip with full title; click navigates to /bibliography/key.
 * Supports pan and zoom via mouse/wheel.
 */

const SVG_WIDTH = 1200;
const SVG_HEIGHT = 800;
const NODE_RADIUS = 8;
const PADDING = 60;

function formatAuthors(authors) {
  if (!authors || authors.length === 0) return 'Unknown';
  // Return last name of first author
  const first = authors[0];
  const parts = first.split(/\s+/);
  return parts[parts.length - 1];
}

function shortLabel(entry) {
  const author = formatAuthors(entry.author);
  const year = entry.year || '??';
  return `${author} ${year}`;
}

/**
 * Compute a year-based color. Older years get lighter hues, newer get darker.
 * Uses a blue gradient: HSL(210, 70%, lightness).
 */
function yearColor(year, minYear, maxYear) {
  if (!year || minYear === maxYear) return 'hsl(210, 70%, 50%)';
  const t = (year - minYear) / (maxYear - minYear); // 0 = oldest, 1 = newest
  const lightness = 80 - t * 45; // 80% (light) to 35% (dark)
  return `hsl(210, 70%, ${lightness}%)`;
}

/**
 * Build co-citation edges between papers sharing venues or authors.
 */
function buildEdges(keys, references) {
  const edges = [];
  const data = keys.map((key) => {
    const entry = references[key];
    return {
      key,
      venue: (entry.venue || '').toLowerCase().trim(),
      authorSet: new Set((entry.author || []).map((a) => a.toLowerCase())),
    };
  });

  for (let i = 0; i < data.length; i++) {
    for (let j = i + 1; j < data.length; j++) {
      let weight = 0;

      // Same venue
      if (data[i].venue && data[i].venue === data[j].venue) {
        weight += 2;
      }

      // Shared author
      for (const author of data[i].authorSet) {
        if (data[j].authorSet.has(author)) {
          weight += 2;
          break;
        }
      }

      if (weight >= 2) {
        edges.push({ source: i, target: j, weight });
      }
    }
  }

  return edges;
}

/**
 * Compute node positions in a year-axis layout.
 * Y-axis: year (newest at top, oldest at bottom).
 * X-axis: spread within each year group.
 */
function computeLayout(keys, references) {
  if (keys.length === 0) return { nodes: [], edges: [], minYear: 0, maxYear: 0 };

  // Group keys by year
  const yearGroups = {};
  let minYear = Infinity;
  let maxYear = -Infinity;

  for (const key of keys) {
    const year = references[key].year || 0;
    if (year > 0) {
      minYear = Math.min(minYear, year);
      maxYear = Math.max(maxYear, year);
    }
    if (!yearGroups[year]) yearGroups[year] = [];
    yearGroups[year].push(key);
  }

  if (minYear === Infinity) {
    minYear = 2000;
    maxYear = 2025;
  }

  // Sort years
  const years = Object.keys(yearGroups)
    .map(Number)
    .sort((a, b) => b - a); // newest first (top)

  const yearSpan = maxYear - minYear || 1;
  const usableHeight = SVG_HEIGHT - PADDING * 2;
  const usableWidth = SVG_WIDTH - PADDING * 2;

  // Assign positions
  const keyToIndex = {};
  const nodes = [];

  for (const year of years) {
    const group = yearGroups[year];
    const yNorm = year > 0 ? (maxYear - year) / yearSpan : 1; // 0=top (newest), 1=bottom (oldest)
    const y = PADDING + yNorm * usableHeight;

    const groupWidth = Math.min(usableWidth, group.length * 50);
    const startX = (SVG_WIDTH - groupWidth) / 2;
    const step = group.length > 1 ? groupWidth / (group.length - 1) : 0;

    for (let i = 0; i < group.length; i++) {
      const key = group[i];
      keyToIndex[key] = nodes.length;
      nodes.push({
        key,
        entry: references[key],
        x: group.length === 1 ? SVG_WIDTH / 2 : startX + i * step,
        y,
        year: year > 0 ? year : null,
      });
    }
  }

  const edges = buildEdges(keys, references);

  return { nodes, edges, minYear, maxYear, years: [...new Set(years.filter((y) => y > 0))] };
}

export default function CitationGraph({ references }) {
  const history = useHistory();
  const containerRef = useRef(null);
  const svgRef = useRef(null);

  const [hoveredNode, setHoveredNode] = useState(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });
  const [viewBox, setViewBox] = useState({ x: 0, y: 0, w: SVG_WIDTH, h: SVG_HEIGHT });
  const [isPanning, setIsPanning] = useState(false);
  const panStart = useRef({ x: 0, y: 0, vx: 0, vy: 0 });
  const [containerSize, setContainerSize] = useState({ width: 900, height: 600 });

  // Measure container
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      setContainerSize({ width: rect.width, height: Math.max(500, Math.min(rect.width * 0.65, 700)) });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const keys = useMemo(() => Object.keys(references || {}), [references]);

  const { nodes, edges, minYear, maxYear, years } = useMemo(
    () => computeLayout(keys, references),
    [keys, references]
  );

  // Adjacency for hover highlighting
  const adjacency = useMemo(() => {
    const adj = new Map();
    for (const node of nodes) adj.set(node.key, new Set());
    for (const edge of edges) {
      const sKey = nodes[edge.source].key;
      const tKey = nodes[edge.target].key;
      adj.get(sKey)?.add(tKey);
      adj.get(tKey)?.add(sKey);
    }
    return adj;
  }, [nodes, edges]);

  const isHighlighted = useCallback(
    (key) => {
      if (hoveredNode === null) return true;
      if (key === hoveredNode) return true;
      return adjacency.get(hoveredNode)?.has(key) || false;
    },
    [hoveredNode, adjacency]
  );

  const isEdgeHighlighted = useCallback(
    (edge) => {
      if (hoveredNode === null) return false;
      const sKey = nodes[edge.source].key;
      const tKey = nodes[edge.target].key;
      return sKey === hoveredNode || tKey === hoveredNode;
    },
    [hoveredNode, nodes]
  );

  // Zoom handler
  const handleWheel = useCallback(
    (e) => {
      e.preventDefault();
      const factor = e.deltaY > 0 ? 1.1 : 0.9;
      setViewBox((prev) => {
        const newW = Math.max(200, Math.min(SVG_WIDTH * 3, prev.w * factor));
        const newH = Math.max(150, Math.min(SVG_HEIGHT * 3, prev.h * factor));
        // Zoom toward center of current view
        const cx = prev.x + prev.w / 2;
        const cy = prev.y + prev.h / 2;
        return {
          x: cx - newW / 2,
          y: cy - newH / 2,
          w: newW,
          h: newH,
        };
      });
    },
    []
  );

  // Pan handlers
  const handleMouseDown = useCallback(
    (e) => {
      if (e.target.closest(`.${styles.nodeGroup}`)) return;
      setIsPanning(true);
      panStart.current = { x: e.clientX, y: e.clientY, vx: viewBox.x, vy: viewBox.y };
    },
    [viewBox]
  );

  const handleMouseMove = useCallback(
    (e) => {
      if (!isPanning) return;
      const svg = svgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const scaleX = viewBox.w / rect.width;
      const scaleY = viewBox.h / rect.height;
      const dx = (e.clientX - panStart.current.x) * scaleX;
      const dy = (e.clientY - panStart.current.y) * scaleY;
      setViewBox((prev) => ({
        ...prev,
        x: panStart.current.vx - dx,
        y: panStart.current.vy - dy,
      }));
    },
    [isPanning, viewBox.w, viewBox.h]
  );

  const handleMouseUp = useCallback(() => {
    setIsPanning(false);
  }, []);

  useEffect(() => {
    if (!isPanning) return;
    const onUp = () => setIsPanning(false);
    window.addEventListener('mouseup', onUp);
    return () => window.removeEventListener('mouseup', onUp);
  }, [isPanning]);

  // Attach wheel listener with passive:false
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    svg.addEventListener('wheel', handleWheel, { passive: false });
    return () => svg.removeEventListener('wheel', handleWheel);
  }, [handleWheel]);

  const handleNodeHover = useCallback((key, e) => {
    setHoveredNode(key);
    const container = containerRef.current;
    if (container) {
      const rect = container.getBoundingClientRect();
      setTooltipPos({
        x: e.clientX - rect.left + 12,
        y: e.clientY - rect.top - 10,
      });
    }
  }, []);

  const handleNodeLeave = useCallback(() => {
    setHoveredNode(null);
  }, []);

  const handleNodeClick = useCallback(
    (key) => {
      history.push(`/bibliography/${key}`);
    },
    [history]
  );

  const resetZoom = useCallback(() => {
    setViewBox({ x: 0, y: 0, w: SVG_WIDTH, h: SVG_HEIGHT });
  }, []);

  const zoomIn = useCallback(() => {
    setViewBox((prev) => {
      const factor = 0.8;
      const newW = Math.max(200, prev.w * factor);
      const newH = Math.max(150, prev.h * factor);
      const cx = prev.x + prev.w / 2;
      const cy = prev.y + prev.h / 2;
      return { x: cx - newW / 2, y: cy - newH / 2, w: newW, h: newH };
    });
  }, []);

  const zoomOut = useCallback(() => {
    setViewBox((prev) => {
      const factor = 1.25;
      const newW = Math.min(SVG_WIDTH * 3, prev.w * factor);
      const newH = Math.min(SVG_HEIGHT * 3, prev.h * factor);
      const cx = prev.x + prev.w / 2;
      const cy = prev.y + prev.h / 2;
      return { x: cx - newW / 2, y: cy - newH / 2, w: newW, h: newH };
    });
  }, []);

  if (!references || keys.length === 0) {
    return (
      <div className={styles.container} style={{ height: 300 }}>
        <p className={styles.emptyMessage}>No references available.</p>
      </div>
    );
  }

  if (nodes.length === 0) {
    return (
      <div className={styles.container} style={{ height: 300 }}>
        <p className={styles.emptyMessage}>Not enough data to build a graph.</p>
      </div>
    );
  }

  const hoveredEntry = hoveredNode ? references[hoveredNode] : null;

  // Compute year axis labels (unique years with positions)
  const yearLabels = (years || []).map((year) => {
    const yNorm = (maxYear - year) / (maxYear - minYear || 1);
    const y = PADDING + yNorm * (SVG_HEIGHT - PADDING * 2);
    return { year, y };
  });

  // Deduplicate close year labels
  const filteredYearLabels = [];
  let lastY = -Infinity;
  for (const label of yearLabels) {
    if (Math.abs(label.y - lastY) > 18) {
      filteredYearLabels.push(label);
      lastY = label.y;
    }
  }

  return (
    <div
      ref={containerRef}
      className={styles.container}
      style={{ height: containerSize.height }}
    >
      <svg
        ref={svgRef}
        className={styles.svgCanvas}
        viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`}
        preserveAspectRatio="xMidYMid meet"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        style={{ cursor: isPanning ? 'grabbing' : 'grab' }}
      >
        {/* Year axis labels */}
        {filteredYearLabels.map((label) => (
          <text
            key={`year-${label.year}`}
            x={20}
            y={label.y + 4}
            className={styles.yearLabel}
          >
            {label.year}
          </text>
        ))}

        {/* Year grid lines */}
        {filteredYearLabels.map((label) => (
          <line
            key={`grid-${label.year}`}
            x1={PADDING - 10}
            y1={label.y}
            x2={SVG_WIDTH - PADDING + 10}
            y2={label.y}
            stroke="var(--ifm-color-emphasis-200, #e0e0e0)"
            strokeWidth="0.5"
            strokeDasharray="4,4"
          />
        ))}

        {/* Edges */}
        {edges.map((edge, i) => {
          const source = nodes[edge.source];
          const target = nodes[edge.target];
          const highlighted = isEdgeHighlighted(edge);
          return (
            <line
              key={`e-${i}`}
              x1={source.x}
              y1={source.y}
              x2={target.x}
              y2={target.y}
              stroke={highlighted ? 'var(--ifm-color-primary, #3578e5)' : 'var(--ifm-color-emphasis-300, #ccc)'}
              strokeWidth={highlighted ? 1.5 : 0.5}
              strokeOpacity={hoveredNode === null ? 0.3 : highlighted ? 0.8 : 0.08}
            />
          );
        })}

        {/* Nodes */}
        {nodes.map((node) => {
          const highlighted = isHighlighted(node.key);
          const color = yearColor(node.entry.year, minYear, maxYear);
          const isHovered = hoveredNode === node.key;
          return (
            <g
              key={node.key}
              className={styles.nodeGroup}
              opacity={highlighted ? 1 : 0.2}
              onMouseEnter={(e) => handleNodeHover(node.key, e)}
              onMouseMove={(e) => handleNodeHover(node.key, e)}
              onMouseLeave={handleNodeLeave}
              onClick={() => handleNodeClick(node.key)}
            >
              <circle
                cx={node.x}
                cy={node.y}
                r={isHovered ? NODE_RADIUS + 2 : NODE_RADIUS}
                fill={color}
                stroke={isHovered ? 'var(--ifm-font-color-base, #333)' : 'white'}
                strokeWidth={isHovered ? 2 : 1}
              />
              <text
                x={node.x + NODE_RADIUS + 4}
                y={node.y + 3}
                className={styles.nodeLabel}
                opacity={highlighted ? 0.9 : 0.2}
              >
                {shortLabel(node.entry)}
              </text>
            </g>
          );
        })}
      </svg>

      {/* Zoom controls */}
      <div className={styles.controls}>
        <button className={styles.controlBtn} onClick={zoomIn} title="Zoom in">+</button>
        <button className={styles.controlBtn} onClick={zoomOut} title="Zoom out">&minus;</button>
        <button className={styles.controlBtn} onClick={resetZoom} title="Reset view">&#8634;</button>
      </div>

      {/* Tooltip */}
      {hoveredEntry && (
        <div
          className={styles.tooltip}
          style={{
            left: tooltipPos.x,
            top: tooltipPos.y,
            transform: tooltipPos.x > containerSize.width - 200 ? 'translateX(-110%)' : 'none',
          }}
        >
          <div className={styles.tooltipTitle}>{hoveredEntry.title}</div>
          <div className={styles.tooltipMeta}>
            {(hoveredEntry.author || []).join(', ')} ({hoveredEntry.year || '??'})
            {hoveredEntry.venue && <> &mdash; {hoveredEntry.venue}</>}
          </div>
        </div>
      )}

      {/* Year color legend */}
      <div className={styles.legend}>
        <span className={styles.legendItem}>
          <span
            className={styles.legendSwatch}
            style={{ background: `linear-gradient(to right, ${yearColor(minYear, minYear, maxYear)}, ${yearColor(maxYear, minYear, maxYear)})` }}
          />
          <span>{minYear} &mdash; {maxYear}</span>
        </span>
        <span style={{ marginLeft: 8, fontSize: '0.85em', opacity: 0.7 }}>
          Scroll to zoom, drag to pan
        </span>
      </div>
    </div>
  );
}
