import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ToastContainer } from './ToastContainer';

/**
 * A toast's tone follows what it says.
 *
 * Every toast used to wear the emerald border and title whatever its type, so
 * "Sign-in failed" and "Could not settle" arrived looking like good news; the
 * only cue was a small triangle. And nothing was announced: a screen-reader
 * user heard no sign-in failure at all. These pin the tone per type and the
 * live region.
 */
const toast = (type: 'success' | 'info' | 'warning', title = `${type} title`) => ({
  id: `t-${type}`,
  title,
  message: 'message',
  type,
});

describe('ToastContainer', () => {
  it('renders nothing with no toasts', () => {
    const { container } = render(<ToastContainer toasts={[]} onDismiss={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('is a polite live region, and each warning is an alert', () => {
    render(<ToastContainer toasts={[toast('success'), toast('warning')]} onDismiss={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByRole('alert')).toHaveTextContent('warning title');
  });

  it('a warning is not dressed as success', () => {
    render(<ToastContainer toasts={[toast('warning')]} onDismiss={vi.fn()} />);
    const card = screen.getByRole('alert');
    expect(card.className).toContain('border-warning');
    expect(card.className).not.toContain('border-accent-2');
    const title = screen.getByText('warning title');
    expect(title.className).toContain('text-warning');
    expect(title.className).not.toContain('text-accent-2');
  });

  it('success keeps its emerald, and info takes brass', () => {
    render(<ToastContainer toasts={[toast('success'), toast('info')]} onDismiss={vi.fn()} />);
    expect(screen.getByText('success title').className).toContain('text-accent-2');
    expect(screen.getByText('info title').className).toContain('text-accent');
    expect(screen.getByText('info title').className).not.toContain('text-accent-2');
  });

  it('the dismiss control is labelled, and dismisses its own toast', () => {
    const onDismiss = vi.fn();
    render(<ToastContainer toasts={[toast('success'), toast('warning')]} onDismiss={onDismiss} />);
    const buttons = screen.getAllByRole('button', { name: /dismiss/i });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[1]);
    expect(onDismiss).toHaveBeenCalledWith('t-warning');
  });
});
