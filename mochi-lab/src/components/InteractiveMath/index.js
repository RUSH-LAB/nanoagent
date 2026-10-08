import React, {lazy, Suspense} from 'react';
import BrowserOnly from '@docusaurus/BrowserOnly';

const placeholderStyle = {
  height: 420,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: '#f5f7f9',
  borderRadius: '8px',
  margin: '1.5em 0',
  color: '#999',
  fontSize: '0.95rem',
  fontFamily: '"Inter", system-ui, sans-serif',
};

function Placeholder({ label }) {
  return <div style={placeholderStyle}>Loading {label}...</div>;
}

function lazyDemo(loader, label) {
  const Demo = lazy(loader);
  return function DeferredDemo(props) {
    return (
      <BrowserOnly fallback={<Placeholder label={label} />}>
        {() => (
          <Suspense fallback={<Placeholder label={label} />}>
            <Demo {...props} />
          </Suspense>
        )}
      </BrowserOnly>
    );
  };
}

export const VectorPlayground = lazyDemo(() => import('./demos/VectorPlayground'), 'vector playground');
export const LinearTransformDemo = lazyDemo(() => import('./demos/LinearTransformDemo'), 'linear transformation demo');
export const GradientDescentDemo = lazyDemo(() => import('./demos/GradientDescentDemo'), 'gradient descent demo');
export const EigenDemo = lazyDemo(() => import('./demos/EigenDemo'), 'eigenvalue demo');
export const RiemannSumDemo = lazyDemo(() => import('./demos/RiemannSumDemo'), 'Riemann sum demo');
export const DistributionExplorer = lazyDemo(() => import('./demos/DistributionExplorer'), 'distribution explorer');
export const Surface3DDemo = lazyDemo(() => import('./demos/Surface3DDemo'), '3D surface demo');
