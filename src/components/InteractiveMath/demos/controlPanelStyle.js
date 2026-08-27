// Shared wrapper style for the interactive-demo control panels
// (DistributionExplorer, RiemannSumDemo, Surface3DDemo, GradientDescentDemo).
// These nine layout properties are identical across all four demos; each demo
// spreads this constant and sets its own per-demo spacing value inline.

export const CONTROL_PANEL_STYLE = {
  display: 'flex',
  flexWrap: 'wrap',
  justifyContent: 'center',
  alignItems: 'center',
  marginTop: '0.75em',
  padding: '0.75em 1em',
  background: '#f5f7f9',
  borderRadius: '8px',
  fontSize: '0.9rem',
};
