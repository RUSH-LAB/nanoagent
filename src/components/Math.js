import { useEffect, useState, useRef, createContext, useContext, useMemo } from 'react';
import { usePluginData } from '@docusaurus/useGlobalData';

// ── Helper: read math-registry manifest from Docusaurus global data ─────────
// Returns the manifest object or {} if plugin not loaded.
function useMathManifest() {
  try {
    return usePluginData('math-registry') ?? {};
  } catch {
    return {};
  }
}

// ── Section context for docs-style section-prefixed numbering ────────────────
// Wrap doc content in <Section number={2}> to get "Figure 2.1", "Table 2.1".
// Each Section gets its own scoped registries so numbering resets per section.
const SectionContext = createContext(null);

function useSectionContext() {
  return useContext(SectionContext);
}

// Per-section scoped registries, keyed by section number.
// Theorem-like environments (theorem, lemma, proposition, corollary, definition,
// remark, example) share a single 'theoremLike' counter.
// Equation, figure, table, code, algorithm each have their own counter.
const sectionRegistries = new Map();

function getSectionRegistries(sectionNumber) {
  if (!sectionRegistries.has(sectionNumber)) {
    sectionRegistries.set(sectionNumber, {
      theoremLike: new Map(),
      equation: new Map(), figure: new Map(),
      table: new Map(), code: new Map(), algorithm: new Map(),
    });
  }
  return sectionRegistries.get(sectionNumber);
}

// ── Section provider component ───────────────────────────────────────────────
// Usage: <Section number={2}>...content...</Section>
// All Figure/Table/Equation/Theorem inside will number as "X 2.1", "X 2.2".
export function Section({ number, children }) {
  return (
    <SectionContext.Provider value={{ number }}>
      {children}
    </SectionContext.Provider>
  );
}

// ── Global registries ───────────────────────────────────────────────────────
// Theorem-like environments share a single 'theoremLike' counter.
// Used when no Section context and no manifest (e.g. blog posts).
const THEOREM_LIKE_TYPES = new Set([
  'theorem', 'lemma', 'proposition', 'corollary',
  'definition', 'remark', 'example',
]);

function registryKey(typeName) {
  return THEOREM_LIKE_TYPES.has(typeName) ? 'theoremLike' : typeName;
}

const registries = {
  theoremLike: new Map(),
  equation: new Map(), figure: new Map(),
  table: new Map(), code: new Map(), algorithm: new Map(),
};

// ── Helper: format a display number with optional section prefix ─────────────
function formatNumber(section, localNumber) {
  return section ? `${section.number}.${localNumber}` : `${localNumber}`;
}

// ── Helper: pick the right registry (section-scoped or global) ───────────────
function pickRegistry(typeName, section) {
  const key = registryKey(typeName);
  if (section) {
    return getSectionRegistries(section.number)[key];
  }
  return registries[key];
}

// ── Shared hook: resolve the display number for a numbered element ───────────
// Priority: manifest → section-scoped DOM count → global DOM count.
// Returns { displayNumber: string, ref, cleanup }.
function useNumberedElement(id, typeName, manifest, section) {
  const ref = useRef(null);
  const [displayNumber, setDisplayNumber] = useState('0');
  const registry = pickRegistry(typeName, section);

  useEffect(() => {
    const globalEntry = manifest[id];
    let localNum;

    if (globalEntry && !section) {
      // Manifest takes precedence when not inside a Section
      localNum = globalEntry.number;
      setDisplayNumber(`${localNum}`);
    } else {
      // DOM-based numbering (scoped to section or global)
      registry.set(id, ref.current);

      const all = Array.from(registry.entries())
        .map(([rid, el]) => ({ id: rid, el, top: el?.getBoundingClientRect().top || 0 }))
        .filter(({ el }) => el !== null)
        .sort((a, b) => a.top - b.top);

      all.forEach(({ id: rid }, index) => {
        const el = registry.get(rid);
        if (el) el.dataset.number = index + 1;
      });

      localNum = parseInt(ref.current?.dataset.number || '0');
      setDisplayNumber(formatNumber(section, localNum));
    }

    // Update same-page cross-reference links (anchors pointing to #id)
    const formatted = section ? formatNumber(section, localNum) : `${localNum}`;
    const links = document.querySelectorAll(`a[href="#${id}"]`);
    links.forEach(link => {
      link.textContent = `${typeName.charAt(0).toUpperCase() + typeName.slice(1)} ${formatted}`;
    });

    // Scroll to this element if the URL hash matches (for cross-page navigation)
    if (window.location.hash === `#${id}` && ref.current) {
      // Small delay to ensure layout is complete after hydration
      setTimeout(() => {
        ref.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 100);
    }

    return () => { registry.delete(id); };
  }, [id, manifest, section]);

  return { ref, displayNumber };
}

// ── Factory: createNumberedBlock ──────────────────────────────────────────────
// Builds a React component for a numbered theorem-like environment.
// `type`     – display label ("Theorem", "Definition", …)
// `typeName` – lowercase registry key
// `style`    – CSS overrides for the outer container
function createNumberedBlock(type, typeName, style) {
  const component = function ({ id, name, children }) {
    const manifest = useMathManifest();
    const section = useSectionContext();
    const { ref, displayNumber } = useNumberedElement(id, typeName, manifest, section);

    return (
      <div
        ref={ref}
        id={id}
        className={`math-block math-block--${typeName}`}
        style={{
          margin: '1em 0',
          fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
          fontSize: '1.0rem',
          borderRadius: '8px',
          padding: '0.5em 0.75em 0.1em 0.75em',
          boxShadow: '0 2px 5px rgba(0,0,0,0.05)',
          lineHeight: '1.6',
          width: '100%',
          boxSizing: 'border-box',
          ...style,
        }}
      >
        <strong>{type} {displayNumber}</strong>
        {name && <span style={{ fontStyle: 'italic' }}> ({name})</span>}
        . {children}
      </div>
    );
  };
  component.displayName = type;
  return component;
}

// ── Theorem-like environments ─────────────────────────────────────────────────
// Blue-gray backgrounds
const blueGrayStyle = { backgroundColor: '#f0f4f8', border: '1px solid #d0d7de' };

export const Theorem     = createNumberedBlock('Theorem',     'theorem',     blueGrayStyle);
export const Lemma       = createNumberedBlock('Lemma',       'lemma',       blueGrayStyle);
export const Proposition = createNumberedBlock('Proposition', 'proposition', blueGrayStyle);
export const Corollary   = createNumberedBlock('Corollary',   'corollary',   blueGrayStyle);

// Definition: green-tinted
export const Definition = createNumberedBlock('Definition', 'definition', {
  backgroundColor: '#f0f8f0',
  border: '1px solid #c4dfc4',
});

// Remark: yellow-tinted, italic label
export const Remark = createNumberedBlock('Remark', 'remark', {
  backgroundColor: '#fdf8e8',
  border: '1px solid #e8deb0',
});

// Example: light purple
export const Example = createNumberedBlock('Example', 'example', {
  backgroundColor: '#f5f0fa',
  border: '1px solid #d4c4e8',
});

// ── Proof (unnumbered, special formatting) ────────────────────────────────────
export function Proof({ children }) {
  return (
    <div
      className="math-block math-block--proof"
      style={{
        margin: '1em 0',
        fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
        fontSize: '1.0rem',
        padding: '0.5em 0.75em 0.1em 0.75em',
        lineHeight: '1.6',
        width: '100%',
        boxSizing: 'border-box',
        borderLeft: '3px solid #999',
      }}
    >
      <em>Proof.</em> {children} <span style={{ float: 'right' }}>∎</span>
    </div>
  );
}

// ── Equation (centered, numbered on the right) ───────────────────────────────
export function Equation({ id, children }) {
  const manifest = useMathManifest();
  const section = useSectionContext();
  const { ref, displayNumber } = useNumberedElement(id, 'equation', manifest, section);

  return (
    <div
      ref={ref}
      id={id}
      data-number="0"
      style={{
        margin: '1em 0',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        position: 'relative',
      }}
    >
      <div style={{ margin: 0, flex: '0 1 auto' }}>
        <style>{`
          #${id} p { margin: 0; }
        `}</style>
        {children}
      </div>
      <span style={{
        position: 'absolute',
        right: '10px',
        fontFamily: '"Times New Roman", serif',
        fontSize: '1rem',
        color: '#666',
      }}>
        ({displayNumber})
      </span>
    </div>
  );
}

export default Theorem;

// ── Figure (captioned, numbered, cross-referenceable) ─────────────────────────
export function Figure({ id, caption, children }) {
  const manifest = useMathManifest();
  const section = useSectionContext();
  const { ref, displayNumber } = useNumberedElement(id, 'figure', manifest, section);

  return (
    <figure
      ref={ref}
      id={id}
      className="numbered-figure"
      style={{
        margin: '1.5em auto',
        textAlign: 'center',
        maxWidth: '100%',
      }}
    >
      <div style={{ display: 'inline-block', maxWidth: '100%', textAlign: 'left' }}>
        {children}
      </div>
      {caption && (
        <figcaption
          style={{
            marginTop: '0.5em',
            fontSize: '0.9rem',
            color: '#555',
            lineHeight: '1.4',
            textAlign: 'center',
          }}
        >
          <strong>Figure {displayNumber}</strong>: {caption}
        </figcaption>
      )}
    </figure>
  );
}

// ── Table (captioned, numbered, cross-referenceable) ──────────────────────────
// columns: "center" | "left" | "right" — default text-align for table cells
export function Table({ id, caption, columns, children }) {
  const manifest = useMathManifest();
  const section = useSectionContext();
  const { ref, displayNumber } = useNumberedElement(id, 'table', manifest, section);

  return (
    <div
      ref={ref}
      id={id}
      className={`numbered-table${columns ? ` numbered-table--cols-${columns}` : ''}`}
      style={{
        margin: '1.5em auto',
        width: '100%',
        textAlign: 'center',
      }}
    >
      {caption && (
        <div
          style={{
            marginBottom: '0.5em',
            fontSize: '0.9rem',
            color: '#555',
            textAlign: 'center',
            lineHeight: '1.4',
          }}
        >
          <strong>Table {displayNumber}</strong>: {caption}
        </div>
      )}
      <div style={{ display: 'inline-block', textAlign: 'left' }}>
        {children}
      </div>
    </div>
  );
}

// ── Code (captioned, numbered, cross-referenceable) ───────────────────────────
export function Code({ id, caption, children }) {
  const manifest = useMathManifest();
  const section = useSectionContext();
  const { ref, displayNumber } = useNumberedElement(id, 'code', manifest, section);

  return (
    <div
      ref={ref}
      id={id}
      className="numbered-code"
      style={{
        margin: '1.5em 0',
        width: '100%',
      }}
    >
      {children}
      {caption && (
        <div
          style={{
            marginTop: '-0.5em',
            fontSize: '0.9rem',
            color: '#555',
            textAlign: 'center',
            lineHeight: '1.4',
          }}
        >
          <strong>Code {displayNumber}</strong>: {caption}
        </div>
      )}
    </div>
  );
}

// ── Algorithm (pseudocode, numbered, cross-referenceable) ─────────────────────
export function Algorithm({ id, caption, children }) {
  const manifest = useMathManifest();
  const section = useSectionContext();
  const { ref, displayNumber } = useNumberedElement(id, 'algorithm', manifest, section);

  return (
    <div
      ref={ref}
      id={id}
      className="numbered-algorithm"
      style={{
        margin: '1.5em 0',
        border: '1px solid #d0d7de',
        borderRadius: '4px',
        padding: '0.75em 1em',
        width: '100%',
        boxSizing: 'border-box',
      }}
    >
      {caption && (
        <div
          style={{
            marginBottom: '0.5em',
            fontSize: '0.95rem',
            fontWeight: 'bold',
            borderBottom: '1px solid #d0d7de',
            paddingBottom: '0.4em',
          }}
        >
          Algorithm {displayNumber}: {caption}
        </div>
      )}
      <div style={{ fontFamily: 'monospace', fontSize: '0.9rem', lineHeight: '1.6' }}>
        {children}
      </div>
    </div>
  );
}

// ── Ref: cross-page reference component ───────────────────────────────────────
// Usage: <Ref id="thm-jensen" /> → renders "Theorem 1" linked to the correct page.
// Works for both same-page and cross-page references.
export function Ref({ id }) {
  const manifest = useMathManifest();
  const entry = manifest[id];
  if (!entry) {
    // Fallback: render the raw id as a same-page anchor
    return <a href={`#${id}`}>{id}</a>;
  }
  return <a href={`${entry.page}#${id}`}>{entry.type} {entry.number}</a>;
}

// ── PageRef: auto-numbered page reference ────────────────────────────────────
// Usage: <PageRef path="./components-of-textbooks/figure-and-table" label="Figure and Table" />
// Renders: "2.1 Figure and Table" as a link, with the number auto-computed from sidebar.
// Also works for categories: <PageRef category="Components of Textbooks" />
import { useDocsSidebar } from '@docusaurus/plugin-content-docs/client';
import { computeNumbers } from '@site/src/theme/SidebarNumberContext';
import Link from '@docusaurus/Link';

function useSidebarNumberMap() {
  const sidebar = useDocsSidebar();
  return useMemo(() => {
    if (!sidebar?.items) return new Map();
    return computeNumbers(sidebar.items);
  }, [sidebar]);
}

// Normalize a path for comparison: strip leading ./ and /, trailing /
function normalizePath(p) {
  return p.replace(/^\.?\//, '').replace(/\/$/, '');
}

// Check if two paths refer to the same page
function pathsMatch(a, b) {
  if (a === b) return true;
  if (a.endsWith(b) || b.endsWith(a)) return true;
  // Handle index pages: "foo/index" matches "foo"
  const stripIndex = s => s.replace(/\/index$/, '').replace(/^index$/, '');
  const a2 = stripIndex(a);
  const b2 = stripIndex(b);
  if (a2 === b2) return true;
  if (a2 && b2 && (a2.endsWith(b2) || b2.endsWith(a2))) return true;
  return false;
}

export function PageRef({ path, label, category }) {
  const numberMap = useSidebarNumberMap();

  if (category) {
    const entry = numberMap.get(`category:${category}`);
    const prefix = entry ? `Chapter ${entry.number}` : category;
    const displayLabel = label === true ? (entry?.label || category) : (typeof label === 'string' ? label : null);
    return <span>{prefix}{displayLabel ? `\u00a0\u00a0${displayLabel}` : ''}</span>;
  }

  // Normalize input path and match against sidebar hrefs
  const normalizedInput = normalizePath(path || '');
  let entry = null;
  let resolvedPath = path;

  // Search href entries (includes category hrefs)
  for (const [href, e] of numberMap) {
    if (href.startsWith('category:')) continue;
    const normalizedHref = normalizePath(href);
    if (pathsMatch(normalizedHref, normalizedInput)) {
      entry = e;
      resolvedPath = href;
      break;
    }
  }

  // If no href match found, try matching against category labels
  // (for index pages that serve as category landing pages)
  if (!entry) {
    for (const [key, e] of numberMap) {
      if (!key.startsWith('category:')) continue;
      const catLabel = key.replace('category:', '').toLowerCase().replace(/\s+/g, '-');
      if (normalizedInput === 'index'
        || normalizedInput.includes(catLabel)
        || catLabel.includes(normalizedInput)) {
        entry = e;
        // Find the matching href for this category to use as link target
        for (const [href2, e2] of numberMap) {
          if (!href2.startsWith('category:') && e2.number === e.number) {
            resolvedPath = href2;
            break;
          }
        }
        break;
      }
    }
  }

  const num = entry?.number;
  const isChapter = num && !num.includes('.');
  const prefix = num ? `${isChapter ? 'Chapter' : 'Section'} ${num}` : '';
  const sidebarLabel = entry?.label;
  // label={true} shows sidebar label, label={false} or omitted hides it
  const displayLabel = label === true ? sidebarLabel : (typeof label === 'string' ? label : null);
  const content = displayLabel ? `${prefix}\u00a0\u00a0${displayLabel}` : prefix || path;
  return <Link to={resolvedPath}>{content}</Link>;
}
