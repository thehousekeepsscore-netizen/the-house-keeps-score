/**
 * Who may approve their own request — mirroring the server, deliberately.
 *
 * The rule is "nobody gives themselves chips", and its escape hatch is being
 * alone, because an admin who cannot approve their own request and has nobody
 * to ask is an admin whose game has stopped.
 *
 * "Alone" means alone AT THE TABLE, not alone on the club roster. The club
 * roster gets the owner-goes-home case exactly backwards: the owner opens the
 * night, plays an hour, cashes out and drives home, and the one admin still
 * dealing cards is refused their own rebuy because an admin exists — asleep,
 * eleven miles away, and the only person who could unblock them.
 *
 * The owner has NO special status. Every session action is admin-gated on the
 * server; owner-only powers are club-level things like deleting the club. Two
 * copies of this rule on the client had drifted into exempting them, which
 * meant the screen offered a button the API then refused.
 *
 * This is a screen-side copy of a server rule and can only ever be wrong in one
 * direction: the server is the authority, and this exists so the queue can say
 * why a button is missing rather than discovering it on tap.
 */

export interface WhoIsHere {
  /** The club's owner, who is an admin everywhere in the app. */
  ownerUid?: string;
  /** Everyone else with admin rights. */
  adminUids?: string[];
  /** Seated right now. */
  seatedUids: string[];
  /** Asked for a chair and waiting. Still here, so still able to approve. */
  pendingSitInUids?: string[];
  /**
   * Confirmed cash-outs. Deliberately NOT counted as present — standing up is
   * what leaving looks like in this app, and treating somebody who has gone as
   * an available approver is the same deadlock in a different hat.
   */
  cashedOutUids?: string[];
}

/** Another admin, at this table, who could look at it instead. */
export function hasAnotherAdminHere(who: WhoIsHere, excludeUid: string): boolean {
  const everyAdmin = new Set([...(who.ownerUid ? [who.ownerUid] : []), ...(who.adminUids ?? [])]);
  everyAdmin.delete(excludeUid);
  if (everyAdmin.size === 0) return false;

  const gone = new Set(who.cashedOutUids ?? []);
  return [...(who.seatedUids ?? []), ...(who.pendingSitInUids ?? [])]
    .filter((uid) => !gone.has(uid))
    .some((uid) => everyAdmin.has(uid));
}

/**
 * The reason a request cannot be waved through by the person looking at it,
 * or null when it can.
 *
 * A sentence rather than a boolean, because a disabled button that will not say
 * why costs the host three taps to learn what one line tells them.
 */
export function selfApprovalBlock(
  who: WhoIsHere,
  viewerUid: string,
  authorUid: string,
  what: 'buy-in' | 'cash-out'
): string | null {
  if (authorUid !== viewerUid) return null;
  if (!hasAnotherAdminHere(who, viewerUid)) return null;
  return what === 'cash-out'
    ? 'Another admin needs to confirm this one.'
    : 'Another admin needs to approve this one.';
}
