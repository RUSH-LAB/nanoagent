import React from 'react';
import Layout from '@theme/Layout';
import Link from '@docusaurus/Link';
import ErrorBoundary from '@site/src/components/ErrorBoundary';
import pageStyles from '@site/src/css/page.module.css';

const sectionStyle = {
  marginBottom: '2.5rem',
};

const sectionTitleStyle = {
  fontSize: '1.3rem',
  fontWeight: 700,
  marginBottom: '1rem',
  paddingBottom: '8px',
  borderBottom: '2px solid var(--ifm-color-primary)',
};

const cardGridStyle = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
  gap: '1rem',
};

const cardStyle = {
  padding: '1.25rem',
  borderRadius: '8px',
  background: 'var(--ifm-card-background-color, #fff)',
  border: '1px solid var(--ifm-color-emphasis-200, #e0e0e0)',
};

const statCardStyle = {
  ...cardStyle,
  textAlign: 'center',
  padding: '1.5rem 1rem',
};

const statValueStyle = {
  fontSize: '2rem',
  fontWeight: 700,
  color: 'var(--ifm-color-primary)',
  lineHeight: 1.2,
};

const statLabelStyle = {
  color: '#888',
  fontSize: '0.85rem',
  marginTop: '4px',
};

const checkStyle = {
  color: 'var(--ifm-color-primary, #2568c2)',
  marginRight: '8px',
  fontWeight: 700,
};

const featureListStyle = {
  listStyle: 'none',
  padding: 0,
  margin: 0,
};

const featureItemStyle = {
  padding: '6px 0',
  fontSize: '0.92rem',
  lineHeight: 1.5,
};

const kbdStyle = {
  display: 'inline-block',
  padding: '2px 8px',
  borderRadius: '4px',
  fontSize: '0.8rem',
  fontFamily: 'monospace',
  fontWeight: 600,
  background: 'var(--ifm-code-background, #f5f5f5)',
  border: '1px solid var(--ifm-color-emphasis-300, #ccc)',
  lineHeight: 1.6,
};

const shortcutRowStyle = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '8px 0',
  borderBottom: '1px solid var(--ifm-color-emphasis-200, #e0e0e0)',
  fontSize: '0.9rem',
};

const linkCardStyle = {
  ...cardStyle,
  display: 'block',
  textDecoration: 'none',
  color: 'inherit',
  transition: 'border-color 0.15s, box-shadow 0.15s',
};

const FEATURES = [
  {
    title: 'Writing & Editing',
    items: [
      'Rich TipTap editor with Markdown/MDX support',
      'LaTeX math rendering (KaTeX)',
      'Wiki-links ([[page]]) and citation references ([@key])',
      'Syntax highlighting for 20+ languages including Lean 4',
      'File management with trash & restore',
      'Draft mode and frontmatter editing',
    ],
  },
  {
    title: 'Research Tools',
    items: [
      'Bibliography management (YAML-based)',
      'Paper metadata enrichment via Semantic Scholar, CrossRef, DBLP',
      'AI-powered paper recommendations from citation graphs',
      'BibTeX import and export',
      'ArXiv preprint tracking with venue detection',
      'Full-text search across all content',
    ],
  },
  {
    title: 'Collaboration',
    items: [
      'Per-page comments system',
      'Real-time editing presence indicators',
      'Role-based access control (owner/editor/viewer)',
      'Git-backed version history with diffs',
      'Notification system for new activity',
    ],
  },
  {
    title: 'Visualization & Discovery',
    items: [
      'Interactive knowledge graph of page connections',
      'Analytics dashboard with pageview tracking',
      'Backlink exploration for any page',
      'Content statistics and word counts',
      'AI writing assistant (continue, improve, explain, summarize)',
      'Template system for quick page creation',
    ],
  },
];

const STATS = [
  { value: '10+', label: 'Interactive Pages' },
  { value: '90+', label: 'API Endpoints' },
  { value: '844', label: 'References' },
  { value: '342', label: 'Test Cases' },
];

const SHORTCUTS = [
  { keys: 'Cmd + K', description: 'Open command palette / quick search' },
  { keys: 'Cmd + O', description: 'Open file navigator' },
  { keys: 'Cmd + S', description: 'Save current file' },
  { keys: 'Cmd + J', description: 'Toggle bottom panel' },
  { keys: 'Cmd + /', description: 'Toggle comment / help' },
];

const TECH_STACK = [
  { name: 'Docusaurus', detail: 'Static site framework with docs, blog, and pages' },
  { name: 'TipTap', detail: 'Rich-text editor built on ProseMirror' },
  { name: 'Clerk', detail: 'Authentication and user management' },
  { name: 'Node.js', detail: 'Editor server with 90+ API endpoints (no Express)' },
  { name: 'KaTeX', detail: 'Fast LaTeX math rendering' },
  { name: 'Semantic Scholar', detail: 'Academic paper metadata and recommendations' },
];

const WHATS_NEW = [
  { feature: 'Focus mode & split view editor' },
  { feature: 'Spaced repetition flashcards' },
  { feature: 'Knowledge graph & mindmap' },
  { feature: 'Content quality scoring' },
  { feature: 'Collaborative annotations' },
  { feature: 'Writing streaks & goals' },
];

const QUICK_LINKS = [
  { label: 'Research Papers', to: '/research', desc: 'Read and discuss research paper summaries' },
  { label: 'Blog', to: '/blog', desc: 'Posts on ideas, tutorials, and updates' },
  { label: 'Editor', to: '/editor', desc: 'Rich-text editor for writing content' },
  { label: 'Bibliography', to: '/bibliography', desc: 'Browse and manage references' },
  { label: 'Knowledge Graph', to: '/graph', desc: 'Visualize page connections' },
  { label: 'Discover', to: '/recommendations', desc: 'AI-powered paper recommendations' },
  { label: 'API Reference', to: '/api-docs', desc: 'Full API documentation (90+ endpoints)' },
  { label: 'Analytics', to: '/analytics', desc: 'Pageview tracking dashboard' },
];

function FeatureCard({ title, items }) {
  return (
    <div style={cardStyle}>
      <h3 style={{ fontSize: '1.05rem', fontWeight: 700, marginTop: 0, marginBottom: '0.75rem' }}>
        {title}
      </h3>
      <ul style={featureListStyle}>
        {items.map((item, i) => (
          <li key={i} style={featureItemStyle}>
            <span style={checkStyle}>&#10003;</span>
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function AboutPage() {
  return (
    <Layout title="About" description="About Mochi Lab — features, tech stack, and getting started">
      <ErrorBoundary>
      <main className={pageStyles.pageContainer}>

        {/* Hero */}
        <div style={{ marginBottom: '2.5rem' }}>
          <h1 style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>About Mochi Lab</h1>
          <p style={{ fontSize: '1.1rem', color: '#555', lineHeight: 1.7, maxWidth: '720px' }}>
            Mochi Lab is a one-stop academic collaboration platform for writing, researching,
            and organizing knowledge. It combines a rich content editor, automated bibliography
            management, AI-powered discovery, and collaborative tools into a single, cohesive workspace.
          </p>
        </div>

        {/* What's New */}
        <section style={sectionStyle}>
          <h2 style={sectionTitleStyle}>What's New</h2>
          <ul style={{ ...featureListStyle, ...cardStyle }}>
            {WHATS_NEW.map((item, i) => (
              <li key={i} style={featureItemStyle}>
                <span style={checkStyle}>&#9733;</span>
                {item.feature}
              </li>
            ))}
          </ul>
        </section>

        {/* Stats */}
        <section style={sectionStyle}>
          <h2 style={sectionTitleStyle}>At a Glance</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: '1rem' }}>
            {STATS.map((s, i) => (
              <div key={i} style={statCardStyle}>
                <div style={statValueStyle}>{s.value}</div>
                <div style={statLabelStyle}>{s.label}</div>
              </div>
            ))}
          </div>
        </section>

        {/* Features */}
        <section style={sectionStyle}>
          <h2 style={sectionTitleStyle}>Features</h2>
          <div style={cardGridStyle}>
            {FEATURES.map((f, i) => (
              <FeatureCard key={i} title={f.title} items={f.items} />
            ))}
          </div>
        </section>

        {/* Tech Stack */}
        <section style={sectionStyle}>
          <h2 style={sectionTitleStyle}>Tech Stack</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '0.75rem' }}>
            {TECH_STACK.map((t, i) => (
              <div key={i} style={{ ...cardStyle, padding: '1rem 1.25rem' }}>
                <strong style={{ fontSize: '0.95rem' }}>{t.name}</strong>
                <div style={{ color: '#888', fontSize: '0.85rem', marginTop: '4px' }}>{t.detail}</div>
              </div>
            ))}
          </div>
        </section>

        {/* Keyboard Shortcuts */}
        <section style={sectionStyle}>
          <h2 style={sectionTitleStyle}>Keyboard Shortcuts</h2>
          <div style={cardStyle}>
            {SHORTCUTS.map((s, i) => (
              <div key={i} style={{
                ...shortcutRowStyle,
                ...(i === SHORTCUTS.length - 1 ? { borderBottom: 'none' } : {}),
              }}>
                <span>{s.description}</span>
                <kbd style={kbdStyle}>{s.keys}</kbd>
              </div>
            ))}
          </div>
        </section>

        {/* Quick Links */}
        <section style={sectionStyle}>
          <h2 style={sectionTitleStyle}>Quick Links</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '0.75rem' }}>
            {QUICK_LINKS.map((link, i) => (
              <Link key={i} to={link.to} style={linkCardStyle}>
                <div style={{ fontWeight: 600, fontSize: '0.95rem', marginBottom: '4px' }}>{link.label}</div>
                <div style={{ color: '#888', fontSize: '0.82rem' }}>{link.desc}</div>
              </Link>
            ))}
          </div>
        </section>

        {/* Footer note */}
        <footer style={{
          borderTop: '1px solid var(--ifm-color-emphasis-200, #e0e0e0)',
          paddingTop: '1rem',
          marginTop: '1rem',
          color: '#9ca3af',
          fontSize: '0.82rem',
        }}>
          <p>
            Built with{' '}
            <a href="https://docusaurus.io" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--ifm-color-primary)' }}>
              Docusaurus
            </a>.
            Source on{' '}
            <a href="https://github.com/zeyuyang8/mochi-lab" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--ifm-color-primary)' }}>
              GitHub
            </a>.
          </p>
        </footer>
      </main>
      </ErrorBoundary>
    </Layout>
  );
}
