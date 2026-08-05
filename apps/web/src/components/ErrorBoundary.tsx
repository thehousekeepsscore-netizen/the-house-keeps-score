import React from 'react';

/**
 * Catches a render-time throw and shows something other than a blank page.
 *
 * There was no boundary anywhere in this application, which means React's
 * default applied: any error thrown while rendering unmounts the entire tree.
 * Not the failing panel — the whole document, down to a white screen with the
 * error only in the console.
 *
 * That is a poor default for any app and a bad one for this app specifically.
 * The screens most likely to throw are the ones rendering money: a settlement
 * with an unexpected shape, a history record from a PDF import with a null
 * where a number is assumed, a leaderboard row for a player who has since been
 * removed. Those are exactly the cases where the user most needs to see
 * something honest rather than nothing at all.
 *
 * A class component because this is the one thing hooks still cannot do.
 *
 * Deliberately not a global catch-all wrapped once around the router. It takes a
 * `title` so it can be placed per route, letting a broken club screen fall back
 * without taking the dashboard, the toasts, or the sign-out control with it.
 */

interface Props {
  children: React.ReactNode;
  /** Named so the fallback can say what failed rather than "something". */
  title: string;
  /** Changing this remounts the subtree — pass the route key so navigating retries. */
  resetKey?: string;
  onReset?: () => void;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidUpdate(prev: Props) {
    // Navigating away from a screen that failed should not leave the fallback
    // on screen forever. Without this the boundary latches: the user presses
    // Back, the URL changes, and they still see the error from the last route.
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // The console is the whole reporting story today. When an error reporter is
    // added this is its single call site, which is part of why the boundary is
    // worth having even before there is somewhere to send the report.
    console.error(`[${this.props.title}] render failed:`, error, info.componentStack);
  }

  private handleRetry = () => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div
        role="alert"
        className="min-h-[60vh] flex flex-col items-center justify-center gap-4 p-6 text-center"
      >
        <p className="text-sm font-bold text-text">This screen didn't load.</p>
        <p className="text-xs text-text-muted max-w-sm leading-relaxed">
          Something went wrong rendering {this.props.title}. Your data is safe — nothing
          was changed. Try again, and if it keeps happening take a screenshot of this page.
        </p>
        {/*
          The message is shown rather than hidden. It is a client-side render
          error, not a server response, so it carries no secrets — and "take a
          screenshot" is worthless advice if the screenshot says nothing.
        */}
        <code className="text-[10px] font-mono text-text-muted bg-surface border border-line rounded-lg px-3 py-2 max-w-md overflow-x-auto">
          {this.state.error.message || 'Unknown error'}
        </code>
        <button
          onClick={this.handleRetry}
          className="px-4 py-2 bg-accent text-accent-contrast rounded-xl text-xs font-bold uppercase tracking-wider cursor-pointer"
        >
          Try again
        </button>
      </div>
    );
  }
}
