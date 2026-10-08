import React from 'react';

const containerStyle = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '3rem 1.5rem',
  textAlign: 'center',
  minHeight: '200px',
};

const headingStyle = {
  fontSize: '1.4rem',
  fontWeight: 600,
  marginBottom: '0.75rem',
  color: 'var(--ifm-color-danger-dark, #e3116c)',
};

const messageStyle = {
  fontSize: '0.95rem',
  color: 'var(--ifm-color-emphasis-700, #555)',
  marginBottom: '1.5rem',
  maxWidth: '600px',
  lineHeight: 1.6,
};

const detailsStyle = {
  width: '100%',
  maxWidth: '600px',
  marginBottom: '1.5rem',
  textAlign: 'left',
};

const detailsSummaryStyle = {
  cursor: 'pointer',
  fontSize: '0.85rem',
  color: 'var(--ifm-color-emphasis-600, #666)',
  marginBottom: '0.5rem',
};

const preStyle = {
  background: 'var(--ifm-color-emphasis-100, #f5f5f5)',
  border: '1px solid var(--ifm-color-emphasis-200, #e0e0e0)',
  borderRadius: '6px',
  padding: '1rem',
  fontSize: '0.8rem',
  overflow: 'auto',
  maxHeight: '200px',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  color: 'var(--ifm-color-emphasis-800, #333)',
};

const buttonStyle = {
  padding: '10px 24px',
  fontSize: '0.9rem',
  fontWeight: 600,
  fontFamily: 'inherit',
  border: '1px solid var(--ifm-color-primary, #2568c2)',
  borderRadius: '6px',
  background: 'var(--ifm-color-primary, #2568c2)',
  color: '#fff',
  cursor: 'pointer',
  transition: 'opacity 0.2s',
};

/** React error boundary that catches render errors and shows a retry UI. Wrap any subtree to prevent full-page crashes. */
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    this.setState({ errorInfo });
    // Log to console for debugging
    console.error('[ErrorBoundary] Caught error:', error, errorInfo);
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null, errorInfo: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div style={containerStyle}>
          <h2 style={headingStyle}>Something went wrong</h2>
          <p style={messageStyle}>
            An unexpected error occurred while rendering this section.
            You can try again, or refresh the page if the problem persists.
          </p>
          <details style={detailsStyle}>
            <summary style={detailsSummaryStyle}>Error details</summary>
            <pre style={preStyle}>
              {this.state.error && this.state.error.toString()}
              {this.state.errorInfo && this.state.errorInfo.componentStack}
            </pre>
          </details>
          <button
            style={buttonStyle}
            onClick={this.handleRetry}
            onMouseEnter={(e) => { e.target.style.opacity = '0.85'; }}
            onMouseLeave={(e) => { e.target.style.opacity = '1'; }}
          >
            Retry
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
