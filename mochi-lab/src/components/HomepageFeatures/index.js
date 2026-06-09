import Link from '@docusaurus/Link';
import Heading from '@theme/Heading';
import styles from './styles.module.css';

const FeatureList = [
  {
    title: 'Rich Content Editor',
    description:
      'TipTap-powered editor with Cmd+O quick search, drag-and-drop image uploads, and seamless markdown plus rich-text authoring.',
    link: '/editor',
    color: '#3b82f6',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
      </svg>
    ),
  },
  {
    title: 'Academic Citations',
    description:
      'Cite papers with [@key] syntax, search Semantic Scholar inline, and auto-generate BibTeX bibliographies for your work.',
    link: '/bibliography',
    color: '#8b5cf6',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
        <line x1="8" y1="7" x2="16" y2="7" />
        <line x1="8" y1="11" x2="14" y2="11" />
      </svg>
    ),
  },
  {
    title: 'Interactive Math',
    description:
      'Render KaTeX equations, write and verify Lean 4 proofs, and embed interactive mathematical demos directly in your pages.',
    link: '/research',
    color: '#06b6d4',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <line x1="18" y1="6" x2="6" y2="18" />
        <path d="M8 6h10v10" />
        <circle cx="6" cy="18" r="2" />
      </svg>
    ),
  },
  {
    title: 'Discussions & Comments',
    description:
      'Threaded comments on every page and dedicated discussion channels for deeper conversations around your research.',
    link: '/discussions',
    color: '#10b981',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        <line x1="8" y1="8" x2="16" y2="8" />
        <line x1="8" y1="12" x2="13" y2="12" />
      </svg>
    ),
  },
  {
    title: 'AI Writing Assistant',
    description:
      'Claude-powered assistant that helps you draft, edit, and refine your writing without leaving the editor.',
    link: '/editor',
    color: '#f59e0b',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2a4 4 0 0 1 4 4v1a4 4 0 0 1-8 0V6a4 4 0 0 1 4-4z" />
        <path d="M6 10a6 6 0 0 0 12 0" />
        <line x1="12" y1="16" x2="12" y2="22" />
        <line x1="8" y1="22" x2="16" y2="22" />
      </svg>
    ),
  },
  {
    title: 'Paper Recommendations',
    description:
      'Discover relevant papers through Semantic Scholar-based recommendations tailored to your research interests.',
    link: '/bibliography',
    color: '#ec4899',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
        <line x1="8" y1="11" x2="14" y2="11" />
        <line x1="11" y1="8" x2="11" y2="14" />
      </svg>
    ),
  },
  {
    title: 'Collaborative Editing',
    description:
      'Real-time presence awareness and role-based access control so your team can co-author documents together.',
    link: '/editor',
    color: '#6366f1',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
      </svg>
    ),
  },
  {
    title: 'Publication Tracking',
    description:
      'Track papers from preprint through peer review to venue acceptance, keeping your publication pipeline organized.',
    link: '/bibliography',
    color: '#ef4444',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
      </svg>
    ),
  },
  {
    title: 'Research & Surveys',
    description:
      'Original research papers and in-depth surveys spanning continual learning, world models, diffusion methods, and more.',
    link: '/research',
    color: '#14b8a6',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
        <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
      </svg>
    ),
  },
];

function Feature({title, description, link, color, icon}) {
  return (
    <Link to={link} className={styles.featureCard}>
      <div className={styles.featureIcon} style={{background: color}}>
        {icon}
      </div>
      <div className={styles.featureTitle}>{title}</div>
      <p className={styles.featureDescription}>{description}</p>
    </Link>
  );
}

export default function HomepageFeatures() {
  return (
    <section className={styles.features}>
      <Heading as="h2" className={styles.sectionTitle}>
        Everything you need for research
      </Heading>
      <p className={styles.sectionSubtitle}>
        A unified platform for writing, citing, collaborating, and publishing your academic work.
      </p>
      <div className={styles.featureGrid}>
        {FeatureList.map((props, idx) => (
          <Feature key={idx} {...props} />
        ))}
      </div>
    </section>
  );
}
