import React, {useState, useRef, useEffect} from 'react';
import BrowserOnly from '@docusaurus/BrowserOnly';

const fabStyle = {
  position: 'fixed',
  bottom: '24px',
  right: '24px',
  zIndex: 1000,
  fontFamily: 'system-ui, -apple-system, sans-serif',
};

const buttonStyle = {
  width: '52px',
  height: '52px',
  borderRadius: '50%',
  border: 'none',
  background: 'var(--ifm-color-primary)',
  color: '#fff',
  fontSize: '24px',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
  transition: 'transform 0.2s ease, background 0.2s ease',
};

const menuStyle = {
  position: 'absolute',
  bottom: '62px',
  right: '0',
  background: 'var(--ifm-background-surface-color, #fff)',
  border: '1px solid var(--ifm-color-emphasis-300, #ddd)',
  borderRadius: '12px',
  padding: '8px 0',
  minWidth: '200px',
  boxShadow: '0 8px 24px rgba(0,0,0,0.15)',
  animation: 'fabMenuIn 0.15s ease-out',
};

const linkStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: '10px',
  padding: '10px 16px',
  color: 'var(--ifm-font-color-base)',
  textDecoration: 'none',
  fontSize: '14px',
  transition: 'background 0.15s',
  cursor: 'pointer',
  border: 'none',
  background: 'none',
  width: '100%',
  textAlign: 'left',
};

const linkHoverBg = 'var(--ifm-color-emphasis-100, #f5f5f5)';

function QuickActionsInner() {
  const [open, setOpen] = useState(false);
  const [hoveredIndex, setHoveredIndex] = useState(-1);
  const containerRef = useRef(null);

  useEffect(() => {
    function handleClickOutside(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false);
      }
    }
    if (open) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  const links = [
    {
      label: 'New Discussion',
      icon: '✏️',
      href: '/discussions?new=1',
    },
    {
      label: 'View Discussions',
      icon: '💬',
      href: '/discussions',
    },
    {
      label: 'Recent Activity',
      icon: '🔥',
      href: '/discussions?sort=recent',
    },
  ];

  return (
    <div ref={containerRef} style={fabStyle}>
      {open && (
        <div style={menuStyle}>
          {links.map((link, i) => (
            <a
              key={link.label}
              href={link.href}
              style={{
                ...linkStyle,
                background: hoveredIndex === i ? linkHoverBg : 'transparent',
              }}
              onMouseEnter={() => setHoveredIndex(i)}
              onMouseLeave={() => setHoveredIndex(-1)}
              onClick={() => setOpen(false)}
            >
              <span style={{fontSize: '16px'}}>{link.icon}</span>
              {link.label}
            </a>
          ))}
        </div>
      )}
      <button
        style={{
          ...buttonStyle,
          transform: open ? 'rotate(45deg)' : 'rotate(0deg)',
        }}
        onClick={() => setOpen((v) => !v)}
        aria-label="Quick actions"
        title="Quick actions"
      >
        {open ? '+' : '💬'}
      </button>
    </div>
  );
}

export default function QuickActions() {
  return (
    <BrowserOnly>{() => <QuickActionsInner />}</BrowserOnly>
  );
}
