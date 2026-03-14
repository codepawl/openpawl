import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-screen items-center justify-center bg-stone-50 dark:bg-stone-950 p-8">
          <div className="max-w-md rounded-2xl border border-rose-300 dark:border-rose-700 bg-white dark:bg-stone-900 p-6 shadow">
            <h2 className="text-lg font-semibold text-rose-600 dark:text-rose-400 mb-2">
              Something went wrong
            </h2>
            <p className="text-sm text-stone-600 dark:text-stone-400 mb-4">
              {this.state.error?.message ?? "Unknown error"}
            </p>
            <button
              type="button"
              onClick={() => this.setState({ hasError: false, error: null })}
              className="rounded-lg bg-stone-800 dark:bg-stone-700 px-3 py-1.5 text-sm text-white hover:bg-stone-700 dark:hover:bg-stone-600 transition-colors"
            >
              Try again
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
