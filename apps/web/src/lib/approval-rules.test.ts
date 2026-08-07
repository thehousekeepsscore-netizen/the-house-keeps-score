import { describe, it, expect } from 'vitest';
import { hasAnotherAdminHere, selfApprovalBlock, WhoIsHere } from './approval-rules';

/**
 * Nobody gives themselves chips — unless there is nobody to ask.
 *
 * The escape hatch is the load-bearing half. An admin who cannot approve their
 * own request and has nobody available to do it is an admin whose game has
 * stopped, and a rule written to prevent self-dealing must not be the thing
 * that ends the night.
 */

const table = (over: Partial<WhoIsHere> = {}): WhoIsHere => ({
  ownerUid: 'owner',
  adminUids: ['admin'],
  seatedUids: ['owner', 'admin', 'player'],
  pendingSitInUids: [],
  cashedOutUids: [],
  ...over,
});

describe('another pair of eyes has to be in the room', () => {
  it('finds one when another admin is sitting at the table', () => {
    expect(hasAnotherAdminHere(table(), 'admin')).toBe(true);
  });

  it('finds none once that admin has stood up and gone', () => {
    // THE OWNER-GOES-HOME CASE. The owner opens the night, plays an hour,
    // cashes out and drives home. The one admin still dealing cards must be
    // able to rebuy — the alternative is a table that cannot continue because
    // somebody eleven miles away is asleep.
    expect(
      hasAnotherAdminHere(
        table({ seatedUids: ['admin', 'player'], cashedOutUids: ['owner'] }),
        'admin'
      )
    ).toBe(false);
  });

  it('counts an admin who has asked for a chair but is not seated yet', () => {
    // They are in the room. Waiting on a seat is not being absent.
    expect(
      hasAnotherAdminHere(
        table({ seatedUids: ['admin', 'player'], pendingSitInUids: ['owner'] }),
        'admin'
      )
    ).toBe(true);
  });

  it('ignores an admin who is on the roster but not at this table', () => {
    expect(
      hasAnotherAdminHere(table({ seatedUids: ['admin', 'player'] }), 'admin')
    ).toBe(false);
  });

  it('never counts the person asking', () => {
    expect(hasAnotherAdminHere(table({ adminUids: [] }), 'owner')).toBe(false);
  });

  it('gives the owner no special standing', () => {
    // Every session action is admin-gated on the server; the owner is an admin,
    // not an exception to the rule. Two copies of this on the client had
    // drifted into exempting them, which offered a button the API refused.
    expect(hasAnotherAdminHere(table(), 'owner')).toBe(true);
  });
});

describe('what the queue says about it', () => {
  it('stays silent about somebody else’s request', () => {
    expect(selfApprovalBlock(table(), 'admin', 'player', 'buy-in')).toBeNull();
  });

  it('names the reason rather than greying a button', () => {
    // A disabled control that will not say why costs the host three taps to
    // learn what one line tells them.
    expect(selfApprovalBlock(table(), 'admin', 'admin', 'buy-in')).toMatch(/another admin/i);
    expect(selfApprovalBlock(table(), 'admin', 'admin', 'cash-out')).toMatch(/confirm/i);
  });

  it('lets the last admin at the table act on their own', () => {
    const alone = table({ seatedUids: ['admin', 'player'], cashedOutUids: ['owner'] });
    expect(selfApprovalBlock(alone, 'admin', 'admin', 'buy-in')).toBeNull();
  });

  it('blocks the author, not the recipient', () => {
    // An admin banking somebody else is the author of that request and may not
    // wave it through; the player receiving the chips is not the question.
    const who = table();
    expect(selfApprovalBlock(who, 'admin', 'admin', 'buy-in')).not.toBeNull();
    expect(selfApprovalBlock(who, 'admin', 'player', 'buy-in')).toBeNull();
  });
});
