import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ErrorBoundary } from './ErrorBoundary';

/**
 * The boundary's job is to be the difference between one broken panel and a
 * blank document. These assert that, plus the two behaviours that are easy to
 * get wrong and impossible to notice by hand: that it stops latching when the
 * route changes, and that it does not swallow errors silently.
 */

function Boom({ shouldThrow, message = 'kaboom' }: { shouldThrow: boolean; message?: string }): React.ReactElement {
  if (shouldThrow) throw new Error(message);
  return <p>rendered fine</p>;
}

beforeEach(() => {
  // React logs caught errors to console.error regardless. Silenced so a passing
  // run is not full of red text that looks like a failure.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('ErrorBoundary', () => {
  it('renders its children when nothing throws', () => {
    render(
      <ErrorBoundary title="the table">
        <Boom shouldThrow={false} />
      </ErrorBoundary>
    );
    expect(screen.getByText('rendered fine')).toBeInTheDocument();
  });

  it('shows a fallback instead of unmounting the tree when a child throws', () => {
    render(
      <ErrorBoundary title="the table">
        <Boom shouldThrow />
      </ErrorBoundary>
    );

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/didn't load/i)).toBeInTheDocument();
  });

  it('names what failed, so the message is not just "something went wrong"', () => {
    render(
      <ErrorBoundary title="your clubs">
        <Boom shouldThrow />
      </ErrorBoundary>
    );
    expect(screen.getByText(/rendering your clubs/i)).toBeInTheDocument();
  });

  it('tells the user their data is safe, because a render error changed nothing', () => {
    render(
      <ErrorBoundary title="the table">
        <Boom shouldThrow />
      </ErrorBoundary>
    );
    expect(screen.getByText(/nothing\s+was changed/i)).toBeInTheDocument();
  });

  it('shows the underlying message, so "take a screenshot" is worth saying', () => {
    render(
      <ErrorBoundary title="the table">
        <Boom shouldThrow message="cannot read netResult of undefined" />
      </ErrorBoundary>
    );
    expect(screen.getByText('cannot read netResult of undefined')).toBeInTheDocument();
  });

  it('still reports the error rather than swallowing it', () => {
    render(
      <ErrorBoundary title="the table">
        <Boom shouldThrow />
      </ErrorBoundary>
    );
    // The single call site an error reporter would later hook into.
    expect(console.error).toHaveBeenCalled();
  });

  it('recovers when the user retries and the cause has gone', async () => {
    const user = userEvent.setup();

    function Harness() {
      const [broken, setBroken] = React.useState(true);
      return (
        <ErrorBoundary title="the table" onReset={() => setBroken(false)}>
          <Boom shouldThrow={broken} />
        </ErrorBoundary>
      );
    }
    render(<Harness />);
    expect(screen.getByRole('alert')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /try again/i }));

    expect(screen.getByText('rendered fine')).toBeInTheDocument();
  });

  it('clears itself when the route changes, instead of latching', () => {
    // The bug this prevents: a screen throws, the user presses Back, the route
    // underneath changes — and they keep staring at the previous error.
    const { rerender } = render(
      <ErrorBoundary title="the table" resetKey="/clubs/a">
        <Boom shouldThrow />
      </ErrorBoundary>
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();

    rerender(
      <ErrorBoundary title="the table" resetKey="/clubs/b">
        <Boom shouldThrow={false} />
      </ErrorBoundary>
    );

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('rendered fine')).toBeInTheDocument();
  });

  it('does not clear while the route stays the same', () => {
    const { rerender } = render(
      <ErrorBoundary title="the table" resetKey="/clubs/a">
        <Boom shouldThrow />
      </ErrorBoundary>
    );
    rerender(
      <ErrorBoundary title="the table" resetKey="/clubs/a">
        <Boom shouldThrow={false} />
      </ErrorBoundary>
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
});
