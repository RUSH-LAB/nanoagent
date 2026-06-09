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

export function VectorPlayground(props) {
  return (
    <BrowserOnly fallback={<Placeholder label="vector playground" />}>
      {() => {
        const Component = require('./interactive/VectorPlayground').default;
        return <Component {...props} />;
      }}
    </BrowserOnly>
  );
}

export function LinearTransformDemo(props) {
  return (
    <BrowserOnly fallback={<Placeholder label="linear transformation demo" />}>
      {() => {
        const Component = require('./interactive/LinearTransformDemo').default;
        return <Component {...props} />;
      }}
    </BrowserOnly>
  );
}

export function GradientDescentDemo(props) {
  return (
    <BrowserOnly fallback={<Placeholder label="gradient descent demo" />}>
      {() => {
        const Component = require('./interactive/GradientDescentDemo').default;
        return <Component {...props} />;
      }}
    </BrowserOnly>
  );
}

export function EigenDemo(props) {
  return (
    <BrowserOnly fallback={<Placeholder label="eigenvalue demo" />}>
      {() => {
        const Component = require('./interactive/EigenDemo').default;
        return <Component {...props} />;
      }}
    </BrowserOnly>
  );
}

export function RiemannSumDemo(props) {
  return (
    <BrowserOnly fallback={<Placeholder label="Riemann sum demo" />}>
      {() => {
        const Component = require('./interactive/RiemannSumDemo').default;
        return <Component {...props} />;
      }}
    </BrowserOnly>
  );
}

export function DistributionExplorer(props) {
  return (
    <BrowserOnly fallback={<Placeholder label="distribution explorer" />}>
      {() => {
        const Component = require('./interactive/DistributionExplorer').default;
        return <Component {...props} />;
      }}
    </BrowserOnly>
  );
}

export function Surface3DDemo(props) {
  return (
    <BrowserOnly fallback={<Placeholder label="3D surface demo" />}>
      {() => {
        const Component = require('./interactive/Surface3DDemo').default;
        return <Component {...props} />;
      }}
    </BrowserOnly>
  );
}
