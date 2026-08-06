import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Sheet } from './Sheet';
import { Button } from './Button';
import { ConfirmDialog } from './ConfirmDialog';

/**
 * The behaviours a native dialog gave for free and the eleven hand-rolled ones
 * did not: focus containment, Escape, focus restoration, scroll lock, labelling.
 *
 * These are the reason a shared Sheet exists rather than a shared stylesheet.
 * Every one of them is invisible until it is missing, and every one was missing.
 */

describe('Sheet', () => {
  it('renders nothing when closed', () => {
    render(<Sheet open={false} onClose={() => {}} title="Buy in" />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('is a labelled modal dialog', () => {
    render(<Sheet open onClose={() => {}} title="Buy in" />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    // Labelled by its own title, so a screen reader announces what opened.
    expect(dialog).toHaveAccessibleName('Buy in');
  });

  it('closes on Escape, as every dialog on every platform does', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<Sheet open onClose={onClose} title="Buy in" />);

    await user.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes when the backdrop is tapped', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    const { container } = render(<Sheet open onClose={onClose} title="Buy in" />);

    await user.click(container.querySelector('[aria-hidden="true"]')!);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('moves focus into the sheet, not onto the page behind', async () => {
    render(
      <Sheet open onClose={() => {}} title="Buy in" footer={<Button>Send</Button>} />
    );
    expect(screen.getByRole('button', { name: 'Send' })).toHaveFocus();
  });

  it('traps Tab inside the sheet', async () => {
    const user = userEvent.setup();
    render(
      <>
        <button>outside</button>
        <Sheet
          open
          onClose={() => {}}
          title="Buy in"
          footer={
            <>
              <Button>Cancel</Button>
              <Button>Send</Button>
            </>
          }
        />
      </>
    );

    const dialog = screen.getByRole('dialog');
    // Forward past the last control wraps to the first, rather than escaping to
    // "outside" where the user cannot see what is focused.
    await user.tab();
    await user.tab();

    expect(within(dialog).getAllByRole('button')).toContain(document.activeElement);
  });

  it('restores focus to whatever opened it', async () => {
    const user = userEvent.setup();

    function Harness() {
      const [open, setOpen] = React.useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Open</button>
          <Sheet open={open} onClose={() => setOpen(false)} title="Buy in" />
        </>
      );
    }
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Open' });

    await user.click(opener);
    await user.keyboard('{Escape}');

    // Without this a keyboard user restarts from the top of the page every time
    // they close a dialog.
    expect(opener).toHaveFocus();
  });

  it('locks the page behind from scrolling, and unlocks on close', () => {
    const { rerender } = render(<Sheet open onClose={() => {}} title="Buy in" />);
    expect(document.body.style.overflow).toBe('hidden');

    rerender(<Sheet open={false} onClose={() => {}} title="Buy in" />);
    expect(document.body.style.overflow).not.toBe('hidden');
  });

  it('opts into the safe-area inset that clears the home indicator', () => {
    render(<Sheet open onClose={() => {}} title="Buy in" />);
    // Asserts the class, not the computed padding: jsdom cannot parse env(), so
    // the real value lives in index.css where this test cannot reach it. This
    // catches the class being dropped in a refactor; it does NOT prove the
    // padding renders correctly on a device. That needs a phone.
    expect(screen.getByRole('dialog').className).toContain('safe-bottom');
  });
});

describe('Button', () => {
  it('meets the 44px minimum touch target at every size', () => {
    render(
      <>
        <Button size="sm">sm</Button>
        <Button size="md">md</Button>
        <Button size="lg">lg</Button>
      </>
    );
    for (const label of ['sm', 'md', 'lg']) {
      const cls = screen.getByRole('button', { name: label }).className;
      const min = Number(cls.match(/min-h-\[(\d+)px\]/)?.[1] ?? 0);
      expect(min, `${label} touch target`).toBeGreaterThanOrEqual(44);
    }
  });

  it('acknowledges a press, since a phone has no hover', () => {
    // The press used to be `active:scale-95`. A button is a padded control, so
    // pressing it compresses the material — the highlight collapses, the shadow
    // tucks under, the face drops a pixel. Scaling is a card trick rather than
    // a physical one. That behaviour lives in `.control` (index.css), which
    // jsdom cannot evaluate, so this asserts the material is attached.
    for (const variant of ['primary', 'secondary', 'danger'] as const) {
      const { container, unmount } = render(<Button variant={variant}>Approve</Button>);
      expect(container.querySelector('button')!.className).toContain('control');
      unmount();
    }
  });

  it('never carries a hover that changes nothing', () => {
    // The original defect: 19 buttons with `bg-accent hover:bg-accent`, a hover
    // state that resolved to itself. Feedback now comes from the press rather
    // than from hover — there is no hover on a phone — so the guard is that no
    // self-cancelling hover has crept back in.
    const { container } = render(<Button variant="primary">Approve</Button>);
    const cls = container.querySelector('button')!.className;
    expect(cls).not.toMatch(/bg-(\S+) hover:bg-\1\b/);
    expect(cls).toContain('control-primary');
  });

  it('reports pending state to assistive tech and blocks re-entry', () => {
    render(<Button loading>Approve</Button>);
    const btn = screen.getByRole('button');
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('aria-busy', 'true');
  });

  it('keeps its label while loading, so the row does not resize under a thumb', () => {
    render(<Button loading>Approve</Button>);
    expect(screen.getByRole('button')).toHaveTextContent('Approve');
  });
});

describe('ConfirmDialog', () => {
  it('names the action rather than asking a generic question', () => {
    render(
      <ConfirmDialog
        open
        title="Remove Priya from Friday Night?"
        description="They will lose access to this club's history."
        confirmLabel="Remove"
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Remove Priya from Friday Night?');
    expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument();
  });

  it('does not focus the destructive action by default', () => {
    render(
      <ConfirmDialog open title="Delete club?" confirmLabel="Delete" onConfirm={() => {}} onCancel={() => {}} />
    );
    // A destructive action should cost a deliberate movement, not a stray Return.
    expect(screen.getByRole('button', { name: 'Delete' })).not.toHaveFocus();
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  });

  it('shows a pending state while the action is in flight', async () => {
    const user = userEvent.setup();
    let resolve!: () => void;
    const onConfirm = vi.fn(() => new Promise<void>((r) => (resolve = r)));

    render(
      <ConfirmDialog open title="Delete club?" confirmLabel="Delete" onConfirm={onConfirm} onCancel={() => {}} />
    );
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    // confirm() returned instantly and left callers to invent this themselves,
    // which is why several of these paths had no pending state at all.
    expect(screen.getByRole('button', { name: 'Delete' })).toHaveAttribute('aria-busy', 'true');

    resolve();
  });

  it('cannot be dismissed while its action is in flight', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        open
        title="Delete club?"
        confirmLabel="Delete"
        onConfirm={() => new Promise<void>(() => {})}
        onCancel={onCancel}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.keyboard('{Escape}');

    expect(onCancel).not.toHaveBeenCalled();
  });
});
