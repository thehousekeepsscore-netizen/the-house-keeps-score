import React, { StrictMode, useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createBrowserRouter, createMemoryRouter, Outlet, RouterProvider } from 'react-router-dom';
import { Sheet, __resetSheetHistory } from './Sheet';
import { Button } from './Button';

// The bookkeeping outlives any one render, which is the whole point of it —
// so a test that leaves a sheet open must not be allowed to fail the next one.
beforeEach(__resetSheetHistory);

/**
 * A sheet is a history entry, so the platform's own Back closes it.
 *
 * On a phone Back is the edge swipe, and it is the first thing people reach for
 * to dismiss anything that slid up over the screen. Before this it did the one
 * thing nobody wants: navigated away from the screen behind the sheet — or out
 * of the app — when the sheet was the only thing they meant to dismiss.
 *
 * The stack bookkeeping is the subtle half. A sheet closed by its own button
 * must leave history exactly as it found it, or the *next* Back press is
 * silently swallowed by a leftover entry and the gesture looks broken.
 */

/** A sheet driven the way real call sites drive it: open is parent state. */
const Harness: React.FC<{ onOpenChange?: (open: boolean) => void }> = ({ onOpenChange }) => {
  const [open, setOpen] = useState(false);
  const set = (next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
  };
  return (
    <>
      <Button onClick={() => set(true)}>Open sheet</Button>
      <Sheet
        open={open}
        onClose={() => set(false)}
        title="Buy in"
        footer={<Button onClick={() => set(false)}>Done</Button>}
      />
    </>
  );
};

/**
 * The sheet is rendered in a layout that OUTLIVES the routes beneath it.
 *
 * This matters more than it looks. If the sheet sits inside the route element,
 * navigating away unmounts it as a side effect, and a test asserting "the sheet
 * closed" passes whether or not the mechanism under test exists. Hoisting it
 * into the layout means only the history marker can close it.
 *
 * The stack starts one entry deep — /elsewhere, then / — so there is always a
 * real destination for Back to reach, and a leftover sheet entry is detectable
 * as Back failing to arrive there.
 */
function renderInRouter(ui: React.ReactNode, { strict = false } = {}) {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        element: (
          <>
            {ui}
            <Outlet />
          </>
        ),
        children: [
          { index: true, element: <p>Home</p> },
          { path: 'elsewhere', element: <p>Elsewhere</p> },
        ],
      },
    ],
    { initialEntries: ['/elsewhere', '/'], initialIndex: 1 }
  );
  const tree = <RouterProvider router={router} />;
  render(strict ? <StrictMode>{tree}</StrictMode> : tree);
  return router;
}

describe('Sheet participates in history', () => {
  it('closes on Back instead of navigating away', async () => {
    const user = userEvent.setup();
    const router = renderInRouter(<Harness />);

    await user.click(screen.getByRole('button', { name: /open sheet/i }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();

    await router.navigate(-1);

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // The screen behind is still the screen behind. This is the whole point.
    expect(router.state.location.pathname).toBe('/');
  });

  it('leaves the history stack as it found it when closed by its own button', async () => {
    const user = userEvent.setup();
    const router = renderInRouter(<Harness />);

    await user.click(screen.getByRole('button', { name: /open sheet/i }));
    await screen.findByRole('dialog');
    await user.click(screen.getByRole('button', { name: /done/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    // The next Back must reach the page before this one. A leftover sheet entry
    // would swallow it and leave the location unchanged — the gesture would
    // look broken exactly once, which is the hardest kind of bug to report.
    await router.navigate(-1);

    await waitFor(() => expect(router.state.location.pathname).toBe('/elsewhere'));
  });

  it('closes when the user navigates away, without unmounting doing the work', async () => {
    const user = userEvent.setup();
    const router = renderInRouter(<Harness />);

    await user.click(screen.getByRole('button', { name: /open sheet/i }));
    await screen.findByRole('dialog');

    // Harness lives in the layout, so it survives this. Only the marker
    // disappearing can close the sheet.
    await router.navigate('/elsewhere');

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: /open sheet/i })).toBeInTheDocument();
  });

  it('does not close itself the moment it opens', async () => {
    // The push is asynchronous, so the location effect runs once against the
    // pre-push location. A naive implementation closes instantly here.
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderInRouter(<Harness onOpenChange={onOpenChange} />);

    await user.click(screen.getByRole('button', { name: /open sheet/i }));

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  it('still renders with no router around it', () => {
    // Sheet is used in tests and stories bare. Losing Back is acceptable there;
    // refusing to render is not.
    render(<Sheet open onClose={() => {}} title="Buy in" />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

/**
 * The same sheet, over a real history and under StrictMode.
 *
 * Everything above runs on a memory router, which applies a navigation the
 * moment it is asked to. That is a kinder world than the browser, and it is why
 * five passing tests missed a live bug: push-on-mount paired with pop-on-cleanup
 * only breaks when the push has not landed yet by the time the pop is decided.
 *
 * Instrumenting the running app showed opening one sheet producing
 * `push · push · go(-1) · push` — the stray pop consuming the entry for the page
 * underneath, and the push after it truncating that page off the stack. Closing
 * the sheet then stepped back past where it started. From a club table, the
 * dashboard.
 *
 * Two conditions were missing before and are present here: StrictMode, so React
 * runs the effect twice, and a real `window.history` underneath.
 *
 * Honest limit: jsdom still does not reproduce the *symptom* — landing on the
 * dashboard — because its history settles more obligingly than Chrome's. What it
 * does reproduce is the cause, an unbalanced stack, and the test below fails
 * against the original implementation. The symptom itself was confirmed gone by
 * instrumenting `history.pushState`/`go` in the running app.
 */
describe('Sheet participates in history — real history, StrictMode', () => {
  function renderOverBrowserHistory() {
    const router = createBrowserRouter([
      {
        path: '/',
        element: (
          <>
            <Harness />
            <Outlet />
          </>
        ),
        children: [
          { index: true, element: <p>Home</p> },
          { path: 'club', element: <p>Club</p> },
        ],
      },
    ]);
    render(
      <StrictMode>
        <RouterProvider router={router} />
      </StrictMode>
    );
    return router;
  }

  beforeEach(async () => {
    // jsdom keeps one history for the whole file. Start every test back at the
    // root so "the page underneath" means the same thing each time.
    window.history.replaceState(null, '', '/');
  });

  it('gives back exactly the entry it took, so the next Back still works', async () => {
    const user = userEvent.setup();
    const router = renderOverBrowserHistory();

    // Stand on a second page, so losing an entry is visible rather than silent.
    await act(async () => {
      await router.navigate('/club');
    });

    await user.click(screen.getByRole('button', { name: /open sheet/i }));
    await screen.findByRole('dialog');
    // The address bar must not move when a sheet opens. A sheet is not a place.
    expect(window.location.pathname).toBe('/club');

    await user.click(screen.getByRole('button', { name: /done/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(window.location.pathname).toBe('/club'));

    // One entry too many left behind swallows this press; one too few has
    // already skipped past the root.
    await act(async () => {
      window.history.back();
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(window.location.pathname).toBe('/');
  });
});
