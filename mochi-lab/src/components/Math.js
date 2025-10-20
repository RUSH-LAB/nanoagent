import { useEffect, useState, useRef } from 'react';

// Global registries
const theoremRegistry = new Map(); // id -> element ref
const equationRegistry = new Map(); // id -> element ref

export function Theorem({ id, name, children }) {
  const ref = useRef(null);
  const [number, setNumber] = useState(0);

  useEffect(() => {
    // Register this theorem
    theoremRegistry.set(id, ref.current);

    // Recalculate all theorem numbers based on DOM order
    const allTheorems = Array.from(theoremRegistry.entries())
      .map(([tid, el]) => ({ id: tid, el, top: el?.getBoundingClientRect().top || 0 }))
      .sort((a, b) => a.top - b.top);

    allTheorems.forEach(({ id: tid }, index) => {
      const el = theoremRegistry.get(tid);
      if (el) {
        el.dataset.number = index + 1;
      }
    });

    setNumber(parseInt(ref.current.dataset.number || '0'));

    return () => {
      theoremRegistry.delete(id);
    };
  }, [id]);

  return (
    <div
      ref={ref}
      id={id}
      style={{
        margin: '1em 0',
        fontFamily: '"Times New Roman", serif',
        fontSize: '1.0rem',
        backgroundColor: '#f9f9f9',
        border: '1px solid #ddd',
        borderRadius: '8px',
        padding: '0.5em 0.75em 0.1em 0.75em',
        boxShadow: '0 2px 5px rgba(0,0,0,0.05)',
        lineHeight: '1.2',
        width: '100%',
        boxSizing: 'border-box',
      }}
    >
      <strong>Theorem {number}</strong>
      {name && <span style={{ fontStyle: 'italic' }}> ({name})</span>}
      . {children}
    </div>
  );
}

export function Equation({ id, children }) {
  const ref = useRef(null);
  const [number, setNumber] = useState(0);

  useEffect(() => {
    // Register this equation
    equationRegistry.set(id, ref.current);

    // Recalculate all equation numbers based on DOM order
    const allEquations = Array.from(equationRegistry.entries())
      .map(([eid, el]) => ({ id: eid, el, top: el?.getBoundingClientRect().top || 0 }))
      .filter(({ el }) => el !== null)
      .sort((a, b) => a.top - b.top);

    allEquations.forEach(({ id: eid }, index) => {
      const el = equationRegistry.get(eid);
      if (el) {
        el.dataset.number = index + 1;
      }
    });

    const newNumber = parseInt(ref.current.dataset.number || '0');
    setNumber(newNumber);

    // Update all links pointing to this equation
    const links = document.querySelectorAll(`a[href="#${id}"]`);
    links.forEach(link => {
      link.textContent = `(${newNumber})`;
    });

    return () => {
      equationRegistry.delete(id);
    };
  }, [id]);

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
        ({number})
      </span>
    </div>
  );
}

export default Theorem;
