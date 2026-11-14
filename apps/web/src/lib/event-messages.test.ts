import { describe, it, expect } from 'vitest';
import { declinedToast, settledToast } from './event-messages';

/**
 * Who is told what, when an event arrives.
 *
 * The rules here are about silence as much as wording: an event about somebody
 * else, one the viewer caused, and one from an API that has not caught up must
 * each say nothing at all.
 */

const fmt = (n: number) => `${n.toLocaleString()} Chips`;
const signed = (n: number) => `${n > 0 ? '+' : '-'}${Math.abs(n).toLocaleString()} Chips`;

describe('a declined request', () => {
  const declined = { userId: 'me', approve: false, decidedBy: 'boss', request: { amount: 2500 } };

  it('names the figure and quotes the reason', () => {
    const t = declinedToast('buy-in', { ...declined, reason: 'Settle up first' }, 'me', fmt)!;
    expect(t.title).toBe('Buy-in declined');
    expect(t.message).toContain('2,500 Chips was declined');
    expect(t.message).toContain('“Settle up first”');
    expect(t.type).toBe('warning');
  });

  it('still says so with no reason given', () => {
    const t = declinedToast('buy-in', declined, 'me', fmt)!;
    expect(t.message).toContain('Ask the host, or ask again.');
    expect(t.message).not.toContain('The host said');
  });

  it('treats a blank reason as no reason', () => {
    expect(declinedToast('buy-in', { ...declined, reason: '   ' }, 'me', fmt)!.message).not.toContain('The host said');
  });

  it('is silent about somebody else', () => {
    expect(declinedToast('buy-in', declined, 'someone-else', fmt)).toBeNull();
  });

  it('is silent for an approval', () => {
    expect(declinedToast('buy-in', { ...declined, approve: true }, 'me', fmt)).toBeNull();
    expect(declinedToast('sit-in', { userId: 'me', approved: true, decidedBy: 'boss' }, 'me', fmt)).toBeNull();
  });

  it('leaves an expired request to its own message', () => {
    expect(declinedToast('buy-in', { ...declined, expired: true }, 'me', fmt)).toBeNull();
  });

  it('is silent when the viewer declined their own', () => {
    expect(declinedToast('buy-in', { ...declined, decidedBy: 'me' }, 'me', fmt)).toBeNull();
  });

  it('is silent for an event that names no decider — an API that has not caught up', () => {
    expect(declinedToast('buy-in', { userId: 'me', approve: false }, 'me', fmt)).toBeNull();
  });

  it('reads sit-in and cash-out decisions by `approved`, not `approve`', () => {
    expect(declinedToast('sit-in', { userId: 'me', approved: false, decidedBy: 'boss' }, 'me', fmt)!.title).toBe('Seat request declined');
    expect(declinedToast('cash-out', { userId: 'me', approved: false, decidedBy: 'boss' }, 'me', fmt)!.title).toBe('Count sent back');
    // A buy-in's field on a sit-in event decides nothing.
    expect(declinedToast('sit-in', { userId: 'me', approve: false, decidedBy: 'boss' }, 'me', fmt)).toBeNull();
  });

  it('tells a sent-back count what to do next, with or without a reason', () => {
    expect(declinedToast('cash-out', { userId: 'me', approved: false, decidedBy: 'boss' }, 'me', fmt)!.message)
      .toBe('Re-count your chips and send it again.');
    expect(declinedToast('cash-out', { userId: 'me', approved: false, decidedBy: 'boss', reason: 'Two stacks short' }, 'me', fmt)!.message)
      .toBe('The host said: “Two stacks short” Re-count your chips and send it again.');
  });

  it('survives a missing payload', () => {
    expect(declinedToast('buy-in', undefined, 'me', fmt)).toBeNull();
    expect(declinedToast('buy-in', null, 'me', fmt)).toBeNull();
  });
});

describe('a settled night', () => {
  const settled = { title: 'Friday · Day 3', settledBy: 'boss' };

  it('tells a winner their figure, as good news', () => {
    const t = settledToast({ ...settled, you: { net: 1800 } }, 'me', signed)!;
    expect(t.title).toBe('Night settled');
    expect(t.message).toBe('Friday · Day 3 — you finished +1,800 Chips.');
    expect(t.type).toBe('success');
  });

  it('tells a loser their figure, without dressing it as success or as an error', () => {
    const t = settledToast({ ...settled, you: { net: -500 } }, 'me', signed)!;
    expect(t.message).toBe('Friday · Day 3 — you finished -500 Chips.');
    expect(t.type).toBe('info');
  });

  it('says "even" rather than a signed zero', () => {
    expect(settledToast({ ...settled, you: { net: 0 } }, 'me', signed)!.message).toBe('Friday · Day 3 — you finished even.');
  });

  it('gives someone who did not play no number', () => {
    const t = settledToast(settled, 'me', signed)!;
    expect(t.message).toBe('Friday · Day 3 is settled. Results are in History.');
  });

  it('is silent for the host who settled it', () => {
    expect(settledToast({ ...settled, settledBy: 'me', you: { net: 10 } }, 'me', signed)).toBeNull();
  });

  it('is silent for an event with no title — an API that has not caught up', () => {
    expect(settledToast({}, 'me', signed)).toBeNull();
    expect(settledToast(undefined, 'me', signed)).toBeNull();
  });
});
