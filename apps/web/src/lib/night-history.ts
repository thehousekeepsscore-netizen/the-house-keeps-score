import { FeedEvent } from './night-feed';
import { durationPhrase } from './night-clock';

/**
 * The same night, read as a ledger instead of told as a story.
 *
 * night-feed.ts derives what happened; this renders it for somebody asking who
 * moved money and when. The two are deliberately different voices over one set
 * of events — the felt says "Kabir bought another 5,000", the history says
 * "Kabir requested Buy-in 5,000 / Approved by Aniket". Neither is a better
 * version of the other, and deriving them twice would let them disagree about
 * a night while both claiming to describe it.
 *
 * Steps carry their own timestamps rather than inheriting the entry's, because
 * the gap between asking and being approved is frequently the thing under
 * discussion. A step with no time is one whose time was never recorded — rows
 * decided before `approvedAt` existed — and it says so by omission rather than
 * by borrowing the request's time and quietly stating something false.
 */

export interface HistoryStep {
  /** ISO. Absent when this step's time was never recorded. */
  at?: string;
  label: string;
  /** Withdrawals and corrections read differently from approvals. */
  tone?: 'normal' | 'muted' | 'warning';
}

export interface HistoryEntry {
  id: string;
  /** ISO. When the entry's first event happened. */
  at: string;
  title: string;
  amount?: number;
  /** Struck through in the UI: the money is gone, the record is not. */
  withdrawn?: boolean;
  steps: HistoryStep[];
}

/** "20:11" in the reader's own locale and zone. */
export function clockTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  return new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** "Fri 8 Aug" — the separator between days, for a night that ran past midnight. */
export function dayLabel(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  return new Date(t).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

/**
 * One feed event, as a history entry.
 *
 * `nameOf` is the caller's, so "You" stays "You" here exactly as it does on the
 * felt — a ledger that calls you by your own name while the table calls you You
 * reads like it is describing somebody else.
 */
export function historyEntry(
  event: FeedEvent,
  nameOf: (userId: string) => string,
  amount: (n: number) => string
): HistoryEntry {
  const who = event.userId ? nameOf(event.userId) : '';
  const steps: HistoryStep[] = [];

  // Who asked, when it was not the player themselves. An admin banking chips
  // for somebody is the case this exists for: the buy-in is Priya's, the
  // request is the host's, and only one of those is visible from the amount.
  if (event.requestedBy && event.userId && event.requestedBy !== event.userId) {
    steps.push({ label: `Requested by ${nameOf(event.requestedBy)}`, tone: 'muted' });
  }

  if (event.approvedBy) {
    steps.push({ at: event.approvedAt, label: `Approved by ${nameOf(event.approvedBy)}` });
  }

  if (event.editedBy) {
    const from = event.previousAmount;
    steps.push({
      at: event.editedAt,
      label:
        from !== undefined && event.amount !== undefined
          ? `Edited by ${nameOf(event.editedBy)} · ${amount(from)} → ${amount(event.amount)}`
          : `Edited by ${nameOf(event.editedBy)}`,
      tone: 'warning',
    });
  }

  if (event.deletedBy) {
    steps.push({ at: event.deletedAt, label: `Deleted by ${nameOf(event.deletedBy)}`, tone: 'warning' });
  }

  const base = { id: event.id, at: event.at, steps };
  const n = event.amount ?? 0;

  switch (event.kind) {
    case 'joined':
      return { ...base, title: `${who} joined the table` };
    case 'bought-in':
      return { ...base, title: `${who} requested Buy-in`, amount: n };
    case 'topped-up':
      return { ...base, title: `${who} requested Top-up`, amount: n };
    case 'stood-up':
      return { ...base, title: `${who} requested Cash-out`, amount: n };
    case 'left':
      return { ...base, title: `${who} cashed out`, amount: n };
    case 'buyin-deleted':
      // The amount is kept and struck through rather than dropped: "a buy-in
      // was deleted" without the figure tells you an argument happened and
      // nothing about what it was worth.
      return { ...base, title: `${who}'s buy-in removed`, amount: n, withdrawn: true };
    case 'ceiling':
      return { ...base, title: 'Max buy-in changed', amount: n };
    case 'timer-started':
      return { ...base, title: `Session started · ${durationPhrase(n)} timer` };
    case 'timer-extended':
      return { ...base, title: 'Session extended', amount: undefined, steps: [{ label: minutes(n) }, ...steps] };
    case 'timer-extended-many':
      return {
        ...base,
        title: 'Session extended',
        steps: [{ label: `${event.count} times, ${minutes(n)} in total` }, ...steps],
      };
    case 'timer-reached':
      return { ...base, title: 'Scheduled time reached' };
    case 'timer-lifted':
      return { ...base, title: 'Continued with no time limit' };
    case 'settled':
      return { ...base, title: 'Settlement started' };
  }
}

function minutes(n: number): string {
  return n === 1 ? '1 minute' : `${n} minutes`;
}

/**
 * How many entries this reader has not seen.
 *
 * Compared by timestamp rather than by count, so it survives the list being
 * trimmed, reordered, or arriving out of order after a reconnect — a count
 * would drift the first time an older event was patched in behind a newer one.
 *
 * Your own actions do not count as unread. Pressing approve and then being told
 * you have one unread item is the app reporting your own tap back to you.
 */
export function unreadCount(
  events: FeedEvent[],
  lastSeenIso: string | null,
  currentUserId: string
): number {
  if (!lastSeenIso) {
    // First visit: everything is old news rather than a badge of thirty. The
    // indicator is for what happened WHILE YOU WERE AWAY, and before your first
    // look there is no away.
    return 0;
  }
  const since = Date.parse(lastSeenIso);
  if (!Number.isFinite(since)) return 0;

  return events.filter((e) => {
    const at = Date.parse(latestTimeOf(e));
    if (!Number.isFinite(at) || at <= since) return false;
    return !isMine(e, currentUserId);
  }).length;
}

/** The most recent thing to have happened to this event, not its first. */
function latestTimeOf(e: FeedEvent): string {
  return e.deletedAt || e.editedAt || e.approvedAt || e.at;
}

function isMine(e: FeedEvent, uid: string): boolean {
  // The actor, not the subject: an admin approving Priya's buy-in has acted,
  // and Priya has not — so it is unread for her and not for him.
  const actor = e.deletedBy || e.editedBy || e.approvedBy || e.requestedBy;
  return actor === uid;
}
