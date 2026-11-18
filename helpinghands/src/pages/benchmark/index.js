import React from 'react';
import Layout from '@theme/Layout';
import BrowserOnly from '@docusaurus/BrowserOnly';
import ErrorBoundary from '@site/src/components/ErrorBoundary';
import useWorkspaceSite from '@site/src/hooks/useWorkspaceSite';
import styles from './styles.module.css';

/**
 * Benchmarks of uploaded harnesses on the member's installed plugins' tasks (src/components/Benchmark): New run, the runs
 * and their live progress, any attempt's saved trace, and the comparison of two attempts.
 */

function BenchmarkContent() {
  const {slug, workspace, error} = useWorkspaceSite();
  if (!slug) return <p className={styles.message}>Open Benchmark from a workspace.</p>;
  if (error) return <p className={styles.message}>{error}</p>;
  if (!workspace) return null;
  const Benchmark = require('@site/src/components/Benchmark').default;
  return <Benchmark key={workspace.id} />;
}

/** The page's Layout props, here and in the shell (components/Shell/registry.js). */
export const page = {title: 'Benchmark', description: 'Benchmark uploaded harnesses on your plugins'};

export function BenchmarkSection() {
  return (
    <BrowserOnly fallback={<div className={styles.message}>Loading…</div>}>
      {() => <ErrorBoundary><BenchmarkContent /></ErrorBoundary>}
    </BrowserOnly>
  );
}

export default function BenchmarkPage() {
  return (
    <Layout {...page}>
      <BenchmarkSection />
    </Layout>
  );
}
