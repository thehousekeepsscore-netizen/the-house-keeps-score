/**
 * What a live event says to the person holding this phone.
 *
 * Two events used to change the screen and say nothing. A declined request
 * reached its asker as the request quietly vanishing, which reads as the app
 * losing it. A settled night reached every player as the table disappearing,
 * and each of them then went looking for their own number.
 *
 * Both now carry what is needed to say it: the decision events name who
 * decided and — to the asker only — the admin's reason; the settled event
 * carries the night's title and, to each player only, their own net.
 *
 * Pure, and separate from the screen, so the wording and the "who is told"
 * rules can be tested without mounting a club. Each returns null when there is
 * nothing to say: the event was about somebody else, the viewer caused it
 * themselves (they already have the acknowledgement of their own action), or
 * the payload came from an API build that does not carry these fields yet —
 * in which case the screen behaves exactly as it did before.
 */

export interface EventToast {
  title: string;
  message: string;
  type: 'success' | 'info' | 'warning';
}

export type DeclinedKind = 'buy-in' | 'sit-in' | 'cash-out';

export interface DecisionEvent {
  userId?: string;
  /** Buy-in decisions say `approve`; sit-in and cash-out decisions say `approved`. */
  approve?: boolean;
  approved?: boolean;
  /** A request nobody acted on. Announced by its own "expired" message. */
  expired?: boolean;
  decidedBy?: string;
  reason?: string;
  request?: { amount?: number };
}

const quoted = (reason: string) => `The host said: “${reason}”`;

export function declinedToast(
  kind: DeclinedKind,
  event: DecisionEvent | null | undefined,
  viewerUid: string,
  formatAmount: (chips: number) => string
): EventToast | null {
  if (!event || event.userId !== viewerUid) return null;
  const approved = kind === 'buy-in' ? event.approve : event.approved;
  if (approved !== false || event.expired) return null;
  // No decider means an older API, or the expiry sweep. Deciding your own is
  // an action you just took and were already told about.
  if (!event.decidedBy || event.decidedBy === viewerUid) return null;

  const reason = event.reason?.trim();
  if (kind === 'buy-in') {
    const amount = event.request?.amount;
    const what = amount !== undefined ? `Your request for ${formatAmount(amount)} was declined.` : 'Your request was declined.';
    return {
      title: 'Buy-in declined',
      message: `${what} ${reason ? quoted(reason) : 'Ask the host, or ask again.'}`,
      type: 'warning',
    };
  }
  if (kind === 'sit-in') {
    return {
      title: 'Seat request declined',
      message: reason ? quoted(reason) : 'The host did not seat you. Ask them, or ask again.',
      type: 'warning',
    };
  }
  return {
    title: 'Count sent back',
    message: `${reason ? `${quoted(reason)} ` : ''}Re-count your chips and send it again.`,
    type: 'warning',
  };
}

export interface SettledEvent {
  title?: string;
  settledBy?: string;
  /** Present only on the phone of someone who played, and only their own. */
  you?: { net?: number };
}

export function settledToast(
  event: SettledEvent | null | undefined,
  viewerUid: string,
  formatSigned: (chips: number) => string
): EventToast | null {
  // No title means an older API: stay silent, as before.
  if (!event?.title) return null;
  // The host who settled it has their own acknowledgement.
  if (event.settledBy === viewerUid) return null;

  const net = event.you?.net;
  if (typeof net !== 'number') {
    return { title: 'Night settled', message: `${event.title} is settled. Results are in History.`, type: 'info' };
  }
  if (net === 0) {
    return { title: 'Night settled', message: `${event.title} — you finished even.`, type: 'info' };
  }
  return {
    title: 'Night settled',
    message: `${event.title} — you finished ${formatSigned(net)}.`,
    type: net > 0 ? 'success' : 'info',
  };
}
