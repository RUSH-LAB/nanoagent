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
  return function (props) {
    return (
      <BrowserOnly fallback={<Placeholder label={label} />}>
        {() => {
          const Component = loader().default;
          return <Component {...props} />;
        }}
      </BrowserOnly>
    );
  };
}

export const VectorPlayground = lazyDemo(() => require('./demos/VectorPlayground'), 'vector playground');
export const LinearTransformDemo = lazyDemo(() => require('./demos/LinearTransformDemo'), 'linear transformation demo');
export const GradientDescentDemo = lazyDemo(() => require('./demos/GradientDescentDemo'), 'gradient descent demo');
export const EigenDemo = lazyDemo(() => require('./demos/EigenDemo'), 'eigenvalue demo');
export const RiemannSumDemo = lazyDemo(() => require('./demos/RiemannSumDemo'), 'Riemann sum demo');
export const DistributionExplorer = lazyDemo(() => require('./demos/DistributionExplorer'), 'distribution explorer');
export const Surface3DDemo = lazyDemo(() => require('./demos/Surface3DDemo'), '3D surface demo');
