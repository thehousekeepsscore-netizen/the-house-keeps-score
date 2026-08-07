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
      // Somebody arriving is pulling up a chair, not entering a pending state.
      // They are here — they are just not in yet, and that is a thing everyone
      // at a real table understands without being told.
      return seat.state === 'waitingToSit'
        ? `pulling up a chair with ${amount(seat.pendingBuyIn ?? 0)}`
        : `wants ${amount(seat.pendingBuyIn ?? 0)} more`;
    case 'waitingToSit':
      return 'pulling up a chair';
    case 'countingOut':
      // The figure and the fact that it is not settled yet. "Counting 7,200"
      // described the act and left out the only part anyone needed: that the
      // number is a claim nobody has agreed to.
      return `standing up with ${amount(seat.pendingCashOut ?? 0)}, pending approval`;
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
  // Somebody arriving is described by their arrival, not by the figure — the
  // figure is what they are bringing, and the interesting fact is that they
  // are about to sit down.
  if (seat.state === 'waitingToSit') return 'pulling up a chair';

  switch (subject(seat)) {
    case 'pendingBuyIn':
      // "+5,000" rather than "WANTS 5,000". A delta needs no verb and no
      // reading: everyone at a table understands chips being added.
      return `+${amount(seat.pendingBuyIn ?? 0)}`;
    case 'waitingToSit':
      return 'pulling up a chair';
    case 'countingOut':
      // Room for the act and the figure, not for "pending approval" as well —
      // the pending-ness is carried on the felt by the seat still being there
      // and by the request sitting in the queue.
      return `standing up ${amount(seat.pendingCashOut ?? 0)}`;
    case 'cashedOut':
      return `stood up ${amount(seat.confirmedCashOut ?? 0)}`;
    case 'seatedNoChips':
      return 'no chips yet';
    default:
      return amount(seat.totalBuyIn);
  }
}
