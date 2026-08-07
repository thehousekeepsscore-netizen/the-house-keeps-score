import { Seat } from './night-state';

/**
 * What a seat is doing, in words.
 *
 * Two renderings, one meaning. The felt has roughly 90px per seat, so it needs
 * a caption; a list and a screen reader want the sentence. Deriving both from
 * one place is the point — the moment the table and the list each carry their
 * own copy, one of them drifts, and the thing that drifts is the vocabulary
 * this app got wrong before.
 *
 * The rule they both keep: waiting, in play and counted out are three different
 * vocabularies and never borrow each other's words. A player with a pending
 * request is asked *about*, not counted — which is why "Arjun · 0 Chips" was
 * true and useless.
 */

/** A pending question always outranks a settled fact — same precedence as the
 *  seat state itself, and as the player sheet. */
function subject(seat: Seat): Seat['state'] | 'pendingBuyIn' {
  if (seat.pendingBuyIn !== null) return 'pendingBuyIn';
  return seat.state;
}

/** Full form. Lists, and the accessible name of every seat. */
export function seatSentence(seat: Seat, amount: (n: number) => string): string {
  switch (subject(seat)) {
    case 'pendingBuyIn':
      // Arriving reads differently from topping up, and the seat already knows
      // which one this is: a player not yet at the table is `waitingToSit`.
      return seat.state === 'waitingToSit'
        ? `wants to join with ${amount(seat.pendingBuyIn ?? 0)}`
        : `wants ${amount(seat.pendingBuyIn ?? 0)} more`;
    case 'waitingToSit':
      return 'wants to join';
    case 'countingOut':
      return `counting ${amount(seat.pendingCashOut ?? 0)}`;
    case 'cashedOut':
      // "Stood up", not "cashed out". One is what a person did; the other is
      // what the ledger recorded about it.
      return `stood up with ${amount(seat.confirmedCashOut ?? 0)}`;
    case 'seatedNoChips':
      return 'no chips yet';
    default:
      return `in ${amount(seat.totalBuyIn)}`;
  }
}

/** Short form. The felt, where a seat has about 90px and a face above it. */
export function seatCaption(seat: Seat, amount: (n: number) => string): string {
  switch (subject(seat)) {
    case 'pendingBuyIn':
      return `wants ${amount(seat.pendingBuyIn ?? 0)}`;
    case 'waitingToSit':
      return 'joining';
    case 'countingOut':
      return 'counting up';
    case 'cashedOut':
      return `stood up ${amount(seat.confirmedCashOut ?? 0)}`;
    case 'seatedNoChips':
      return 'no chips yet';
    default:
      return amount(seat.totalBuyIn);
  }
}
