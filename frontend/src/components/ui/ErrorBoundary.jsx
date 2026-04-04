import { Component } from 'react'

/**
 * React error boundary — catches render errors in the component
 * subtree and displays a recovery UI instead of crashing the app.
 *
 * Usage:
 *   <ErrorBoundary name="Highlights">
 *     <HighlightProvider>…</HighlightProvider>
 *   </ErrorBoundary>
 *
 * Props:
 *   name     — human-readable label shown in the fallback UI
 *   fallback — optional custom fallback component (receives { error, reset })
 *   onError  — optional callback (error, errorInfo)
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, errorInfo) {
    console.error(
      `[ErrorBoundary:${this.props.name || 'unknown'}]`,
      error,
      errorInfo?.componentStack,
    )
    this.props.onError?.(error, errorInfo)
  }

  reset = () => this.setState({ error: null })

  render() {
    if (this.state.error) {
      if (this.props.fallback) {
        const Fallback = this.props.fallback
        return <Fallback error={this.state.error} reset={this.reset} />
      }

      return (
        <div className="flex flex-col items-center justify-center gap-4 p-8 text-center">
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-6 py-4 max-w-lg">
            <h3 className="text-lg font-semibold text-red-400 mb-2">
              {this.props.name ? `${this.props.name} — Error` : 'Something went wrong'}
            </h3>
            <p className="text-sm text-text-secondary mb-4">
              {this.state.error?.message || 'An unexpected error occurred.'}
            </p>
            <button
              onClick={this.reset}
              className="rounded-md bg-red-500/20 px-4 py-2 text-sm font-medium text-red-300 hover:bg-red-500/30 transition-colors"
            >
              Try Again
            </button>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
