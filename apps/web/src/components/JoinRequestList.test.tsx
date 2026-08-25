import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { JoinRequestList, classifyJoinRequestError } from './JoinRequestList';
import { ApiError } from '../lib/api-client';
import { ClubJoinRequest } from '../types';

/**
 * One list, two contexts, and three ways a decision can go wrong.
 *
 * The test that earns this file is the stale one. When two admins tap accept at
 * the same moment the API answers the loser with a 409 — and the screen this
 * replaced turned that into `alert('Failed to process request.')`, which is the
 * same message it showed for a network drop. The request was handled correctly;
 * it just wasn't handled by this admin. That has to read as a refresh, not a
 * failure, or admins learn to distrust a queue that is telling the truth.
 */

const request = (over: Partial<ClubJoinRequest> = {}): ClubJoinRequest => ({
  id: 'req-1',
  clubId: 'club-1',
  clubName: 'All in 2026',
  userId: 'u-hopeful',
  userDisplayName: 'Priya Shah',
  userEmail: 'priya@test.local',
  status: 'pending',
  createdAt: '2026-08-16T19:40:00.000Z',
  ...over,
});

const setup = (props: Partial<React.ComponentProps<typeof JoinRequestList>> = {}) => {
  const onDecide = props.onDecide ?? vi.fn().mockResolvedValue(undefined);
  const onStale = props.onStale ?? vi.fn();
  const utils = render(
    <JoinRequestList requests={[request()]} onDecide={onDecide} onStale={onStale} {...props} />
  );
  return { ...utils, onDecide, onStale };
};

describe('what a pending request shows', () => {
  it('renders the requester, and the time as well as the date', () => {
    setup();
    expect(screen.getByText('Priya Shah')).toBeInTheDocument();

    // Formatted the same way the component does, so the assertion does not
    // depend on the machine's timezone or locale — an earlier version hard-coded
    // 19:40 and would have failed anywhere but UTC.
    const expected = new Date('2026-08-16T19:40:00.000Z').toLocaleString(undefined, {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
    // Two requests can arrive on the same day, so a date alone cannot order them.
    expect(expected).toMatch(/\d{1,2}[:.]\d{2}/);
    expect(screen.getByText(expected)).toBeInTheDocument();
  });

  it('names the club in a cross-club list', () => {
    setup({ showClubName: true });
    expect(screen.getByText('All in 2026')).toBeInTheDocument();
  });

  it('omits the club name when the surface already is one club', () => {
    setup({ showClubName: false });
    expect(screen.queryByText('All in 2026')).not.toBeInTheDocument();
  });

  it('shows only pending requests', () => {
    setup({
      requests: [request(), request({ id: 'req-2', userDisplayName: 'Decided Dan', status: 'accepted' })],
    });
    expect(screen.getByText('Priya Shah')).toBeInTheDocument();
    expect(screen.queryByText('Decided Dan')).not.toBeInTheDocument();
  });
});

describe('collapsed is the default, and it asks first', () => {
  it('offers compact accept and reject controls', () => {
    setup();
    expect(screen.getByRole('button', { name: 'Accept Priya Shah' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reject Priya Shah' })).toBeInTheDocument();
  });

  it('a compact accept opens a confirmation naming the person, and decides nothing yet', async () => {
    const { onDecide } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Accept Priya Shah' }));

    expect(screen.getByText('Accept this request?')).toBeInTheDocument();
    // The name is now on screen twice — once in the row, once in the dialog —
    // and the dialog naming the person is the whole point of asking first.
    expect(screen.getAllByText(/Priya Shah/).length).toBeGreaterThanOrEqual(2);
    expect(onDecide).not.toHaveBeenCalled();
  });

  it('a compact reject opens its own confirmation', async () => {
    const { onDecide } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Reject Priya Shah' }));
    expect(screen.getByText('Reject this request?')).toBeInTheDocument();
    expect(onDecide).not.toHaveBeenCalled();
  });

  it('decides only after the confirmation is confirmed', async () => {
    const { onDecide } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Accept Priya Shah' }));
    await userEvent.click(screen.getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith(expect.objectContaining({ id: 'req-1' }), true));
  });
});

describe('expanded acts directly', () => {
  const expand = async () => userEvent.click(screen.getByRole('button', { name: /Expand/i }));

  it('accepts without a confirmation, because the button already carries the weight', async () => {
    const { onDecide } = setup();
    await expand();
    await userEvent.click(screen.getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith(expect.objectContaining({ id: 'req-1' }), true));
    expect(screen.queryByText('Accept this request?')).not.toBeInTheDocument();
  });

  it('rejects without a confirmation', async () => {
    const { onDecide } = setup();
    await expand();
    await userEvent.click(screen.getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith(expect.objectContaining({ id: 'req-1' }), false));
  });
});

describe('when another admin got there first', () => {
  it('says so, and asks the caller to refresh instead of reporting a failure', async () => {
    const onDecide = vi.fn().mockRejectedValue(new ApiError(409, 'This request has already been decided'));
    const onStale = vi.fn();
    setup({ onDecide, onStale });

    await userEvent.click(screen.getByRole('button', { name: 'Accept Priya Shah' }));
    await userEvent.click(screen.getByRole('button', { name: 'Accept' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/Another admin already handled/i));
    expect(onStale).toHaveBeenCalledTimes(1);
  });

  it('does not treat a genuine failure as stale', async () => {
    const onDecide = vi.fn().mockRejectedValue(new Error('network down'));
    const onStale = vi.fn();
    setup({ onDecide, onStale });

    await userEvent.click(screen.getByRole('button', { name: 'Accept Priya Shah' }));
    await userEvent.click(screen.getByRole('button', { name: 'Accept' }));

    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());
    expect(onStale).not.toHaveBeenCalled();
  });
});

describe('a refusal from the API is its own message', () => {
  it('reports 403 as a permission problem, not a generic failure', async () => {
    const onDecide = vi.fn().mockRejectedValue(new ApiError(403, 'Only a Club Admin or Owner can do this'));
    setup({ onDecide });

    await userEvent.click(screen.getByRole('button', { name: 'Accept Priya Shah' }));
    await userEvent.click(screen.getByRole('button', { name: 'Accept' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/do not have permission/i));
  });

  it('classifies the three cases apart', () => {
    expect(classifyJoinRequestError(new ApiError(409, 'x')).kind).toBe('stale');
    expect(classifyJoinRequestError(new ApiError(403, 'x')).kind).toBe('forbidden');
    expect(classifyJoinRequestError(new ApiError(500, 'x')).kind).toBe('unknown');
    expect(classifyJoinRequestError(new Error('boom')).kind).toBe('unknown');
  });

  it('never uses a browser alert', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const onDecide = vi.fn().mockRejectedValue(new ApiError(500, 'server on fire'));
    setup({ onDecide });

    await userEvent.click(screen.getByRole('button', { name: 'Accept Priya Shah' }));
    await userEvent.click(screen.getByRole('button', { name: 'Accept' }));

    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());
    expect(alertSpy).not.toHaveBeenCalled();
    alertSpy.mockRestore();
  });
});

describe('loading, empty and load failure', () => {
  it('shows a skeleton only when nothing has ever loaded', () => {
    setup({ requests: [], loading: true });
    expect(screen.getByTestId('join-requests-loading')).toBeInTheDocument();
  });

  it('says nobody is waiting when the list is empty', () => {
    setup({ requests: [], emptyMessage: 'Nobody is waiting to join this club.' });
    expect(screen.getByText('Nobody is waiting to join this club.')).toBeInTheDocument();
    expect(screen.queryByTestId('join-requests-loading')).not.toBeInTheDocument();
  });

  it('offers a retry when the list itself failed to load', async () => {
    const onRetryLoad = vi.fn();
    setup({ requests: [], loadError: 'Could not load join requests.', onRetryLoad });

    expect(screen.getByText('Could not load join requests.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Try again/i }));
    expect(onRetryLoad).toHaveBeenCalledTimes(1);
  });
});

describe('one decision per row', () => {
  it('ignores a second tap while the first is still in flight', async () => {
    let release: () => void = () => {};
    const onDecide = vi.fn(
      () => new Promise<void>((resolve) => { release = resolve; })
    );
    setup({ onDecide });

    await userEvent.click(screen.getByRole('button', { name: /Expand/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Accept' }));
    await userEvent.click(screen.getByRole('button', { name: 'Accept' }));

    expect(onDecide).toHaveBeenCalledTimes(1);
    release();
  });

  it('leaves other rows usable while one is deciding', async () => {
    let release: () => void = () => {};
    const onDecide = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    setup({
      requests: [request(), request({ id: 'req-2', userId: 'u-2', userDisplayName: 'Rahil Mehta' })],
      onDecide,
    });

    await userEvent.click(screen.getByRole('button', { name: 'Accept Priya Shah' }));
    await userEvent.click(screen.getByRole('button', { name: 'Accept' }));

    // Approving one row must not disable the others — the same independence
    // the buy-in queue has.
    expect(screen.getByRole('button', { name: 'Accept Rahil Mehta' })).not.toBeDisabled();
    release();
  });
});
