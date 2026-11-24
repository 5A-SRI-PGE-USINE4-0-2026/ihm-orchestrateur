import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './styles/tokens.css';
import './styles/app.css';

interface ErrorBoundaryState {
  error: Error | null;
}

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: '24px', color: '#E8EEF5', background: '#11171E', minHeight: '100vh' }}>
          <h2 style={{ margin: '0 0 8px 0' }}>Erreur d’affichage de la télémétrie</h2>
          <p className="mono" style={{ color: '#E55353' }}>
            {this.state.error.message}
          </p>
          <button
            type="button"
            className="action-btn"
            onClick={() => this.setState({ error: null })}
          >
            Recharger la vue
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
