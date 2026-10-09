import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** Changing this (e.g. the route path) clears a previous error. */
  resetKey?: string;
}

interface State {
  error: Error | null;
}

/** Keeps a crashing page from blanking the whole shell; the sidebar stays usable. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Page crashed', error, info.componentStack);
  }

  componentDidUpdate(prev: Props) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="kit-page">
        <div className="kit-error-banner">
          This page hit an error: {this.state.error.message}
          <div style={{ marginTop: 10 }}>
            <button type="button" className="kit-pill-button" onClick={() => this.setState({ error: null })}>
              Try again
            </button>
          </div>
        </div>
      </div>
    );
  }
}
