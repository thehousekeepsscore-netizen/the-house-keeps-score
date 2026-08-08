import { describe, it, expect } from 'vitest';
import { FeedEvent } from './night-feed';
import { historyEntry, unreadCount } from './night-history';

/**
 * The ledger half of a night.
 *
 * night-feed.test.ts owns what happened; this owns how it reads to somebody
 * asking who moved money and when — the questions the story deliberately
 * refuses to answer.
 */

const name = (uid: string) => (uid === 'me' ? 'You' : uid[0].toUpperCase() + uid.slice(1));
const chips = (n: number) => `${n.toLocaleString()}`;
const entry = (e: Partial<FeedEvent> & Pick<FeedEvent, 'kind' | 'at'>) =>
  historyEntry({ id: 'e1', ...e } as FeedEvent, name, chips);

const AT = '2026-08-09T20:11:00.000Z';

describe('an entry reads as a ledger line', () => {
  it('names the player and the amount they asked for', () => {
    const e = entry({ kind: 'bought-in', at: AT, userId: 'rahul', amount: 5000 });

    expect(e.title).toBe('Rahul requested Buy-in');
    expect(e.amount).toBe(5000);
  });

  it('says who approved it', () => {
    const e = entry({ kind: 'bought-in', at: AT, userId: 'rahul', approvedBy: 'aniket' });

    expect(e.steps.map((s) => s.label)).toContain('Approved by Aniket');
  });

  it('gives the approval its own timestamp, not the request time', () => {
    const e = entry({
      kind: 'bought-in',
      at: AT,
      userId: 'rahul',
      approvedBy: 'aniket',
      approvedAt: '2026-08-09T20:12:00.000Z',
    });

    const step = e.steps.find((s) => s.label.startsWith('Approved'));
    expect(step?.at).toBe('2026-08-09T20:12:00.000Z');
    expect(step?.at).not.toBe(e.at);
  });

  it('shows an approval with no recorded time rather than borrowing one', () => {
    // Rows decided before approvedAt existed. Inventing a time here would put
    // a number in the audit trail that nobody can vouch for.
    const e = entry({ kind: 'bought-in', at: AT, userId: 'rahul', approvedBy: 'aniket' });

    const step = e.steps.find((s) => s.label.startsWith('Approved'));
    expect(step).toBeDefined();
    expect(step?.at).toBeUndefined();
  });

  it('names the requester only when it was not the player', () => {
    const own = entry({ kind: 'bought-in', at: AT, userId: 'rahul', requestedBy: 'rahul' });
    expect(own.steps.some((s) => s.label.startsWith('Requested by'))).toBe(false);

    // An admin banking chips for somebody: the buy-in is Priya's, the request
    // is the host's, and only one of those is visible from the amount.
    const behalf = entry({ kind: 'bought-in', at: AT, userId: 'priya', requestedBy: 'aniket' });
    expect(behalf.steps.map((s) => s.label)).toContain('Requested by Aniket');
  });

  it('shows a correction as a change, not just as a new number', () => {
    const e = entry({
      kind: 'bought-in',
      at: AT,
      userId: 'rahul',
      amount: 4000,
      previousAmount: 5000,
      editedBy: 'aniket',
      editedAt: '2026-08-09T20:40:00.000Z',
    });

    expect(e.steps.map((s) => s.label)).toContain('Edited by Aniket · 5,000 → 4,000');
  });

  it('keeps a removed buy-in visible, with its figure struck rather than dropped', () => {
    const e = entry({
      kind: 'buyin-deleted',
      at: '2026-08-09T20:44:00.000Z',
      userId: 'rahul',
      amount: 5000,
      deletedBy: 'priya',
    });

    expect(e.withdrawn).toBe(true);
    expect(e.amount).toBe(5000);
    expect(e.steps.map((s) => s.label)).toContain('Deleted by Priya');
  });

  it('calls you You, exactly as the felt does', () => {
    const e = entry({ kind: 'bought-in', at: AT, userId: 'me', amount: 3000 });
    expect(e.title).toBe('You requested Buy-in');
  });
});

describe('the unread dot', () => {
  const ev = (id: string, at: string, extra: Partial<FeedEvent> = {}): FeedEvent =>
    ({ id, kind: 'bought-in', at, userId: 'rahul', ...extra }) as FeedEvent;

  const T = (m: number) => `2026-08-09T20:${String(m).padStart(2, '0')}:00.000Z`;

  it('counts nothing before the first look', () => {
    // The indicator is for what happened WHILE YOU WERE AWAY, and before your
    // first look there is no away — a badge of thirty on arrival is noise.
    expect(unreadCount([ev('a', T(10)), ev('b', T(20))], null, 'me')).toBe(0);
  });

  it('counts what happened since you last opened it', () => {
    expect(unreadCount([ev('a', T(10)), ev('b', T(20)), ev('c', T(30))], T(15), 'me')).toBe(2);
  });

  it('does not count your own actions back at you', () => {
    const mine = ev('a', T(30), { approvedBy: 'me' });
    const theirs = ev('b', T(30), { approvedBy: 'aniket' });

    expect(unreadCount([mine, theirs], T(15), 'me')).toBe(1);
  });

  it('counts an approval of somebody else as unread for the player', () => {
    // Priya's buy-in, approved by the host: he acted, she did not.
    const e = ev('a', T(30), { userId: 'priya', requestedBy: 'priya', approvedBy: 'aniket' });
    expect(unreadCount([e], T(15), 'aniket')).toBe(0);
    expect(unreadCount([e], T(15), 'priya')).toBe(1);
  });

  it('notices a correction to something old, not just new events', () => {
    // The buy-in is from 20:10 and was edited at 20:40. Comparing on the
    // event's own timestamp would call that read.
    const edited = ev('a', T(10), { editedAt: T(40), editedBy: 'aniket' });
    expect(unreadCount([edited], T(20), 'me')).toBe(1);
  });

  it('survives a garbled last-seen rather than badging everything', () => {
    expect(unreadCount([ev('a', T(30))], 'not-a-date', 'me')).toBe(0);
  });
});
