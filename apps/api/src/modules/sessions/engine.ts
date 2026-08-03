import { createDeck, evaluate7CardHand } from './pokerEvaluator.js';
import { VTEngineState, VTSeat, HandHistoryPayload } from './types.js';

export const TURN_DURATION_SEC = 30;

export interface EngineMutationResult {
  state: VTEngineState;
  historyRecord?: HandHistoryPayload;
  ended?: boolean;
}

export function getActiveSeats(seats: VTSeat[]): VTSeat[] {
  return seats.filter(s => s.uid && !s.isSatOut && s.chipStack > 0).sort((a, b) => a.seatNumber - b.seatNumber);
}

function appendLog(log: string[] | undefined, entry: string): string[] {
  return [entry, ...(log || [])].slice(0, 25);
}

function makeHistoryRecord(state: VTEngineState, winnerNames: string[], handDesc: string, pot: number): HandHistoryPayload {
  return {
    handNumber: state.handNumber || 0,
    dealerSeat: state.dealerSeat || 0,
    smallBlind: state.smallBlind || 0,
    bigBlind: state.bigBlind || 0,
    communityCards: state.communityCards || [],
    potTotal: pot,
    winnerNames,
    winningHandDesc: handDesc,
    timestamp: new Date().toLocaleTimeString(),
  };
}

function awardPotToWinner(state: VTEngineState, winner: VTSeat | undefined, reason: string): EngineMutationResult | null {
  if (!winner) return null;
  const pot = state.potSize || 0;
  const seats = (state.playerSeats || []).map(s => (s.uid === winner.uid ? { ...s, chipStack: s.chipStack + pot } : s));

  return {
    state: {
      ...state,
      playerSeats: seats,
      street: 'Showdown',
      currentTurnSeat: null,
      winningAnnouncement: { winners: [winner.name], handDesc: reason, amountWon: pot },
      actionLog: appendLog(state.actionLog, `🏆 ${winner.name} won ₹${pot} (${reason})`)
    },
    historyRecord: makeHistoryRecord(state, [winner.name], reason, pot)
  };
}

function performShowdown(state: VTEngineState): EngineMutationResult | null {
  const seats = state.playerSeats || [];
  const contenders = seats.filter(s => s.uid && !s.isFolded);
  if (contenders.length === 0) return null;
  if (contenders.length === 1) return awardPotToWinner(state, contenders[0], 'All other players folded');

  let bestScore = -1;
  let winners: VTSeat[] = [];
  let bestHandDesc = '';

  contenders.forEach(p => {
    const all7 = [...(p.holeCards || []), ...(state.communityCards || [])];
    const evalRes = evaluate7CardHand(all7);
    if (evalRes.value > bestScore) {
      bestScore = evalRes.value;
      winners = [p];
      bestHandDesc = evalRes.description;
    } else if (evalRes.value === bestScore) {
      winners.push(p);
    }
  });

  const pot = state.potSize || 0;
  const winShare = Math.floor(pot / winners.length);
  const winnerUids = new Set(winners.map(w => w.uid));
  const updatedSeats = seats.map(s => (winnerUids.has(s.uid) ? { ...s, chipStack: s.chipStack + winShare } : s));
  const winnerNames = winners.map(w => w.name);

  return {
    state: {
      ...state,
      playerSeats: updatedSeats,
      street: 'Showdown',
      currentTurnSeat: null,
      winningAnnouncement: { winners: winnerNames, handDesc: bestHandDesc, amountWon: pot },
      actionLog: appendLog(state.actionLog, `🏆 ${winnerNames.join(', ')} won ₹${pot} with ${bestHandDesc}`)
    },
    historyRecord: makeHistoryRecord(state, winnerNames, bestHandDesc, pot)
  };
}

function advanceStreet(state: VTEngineState): EngineMutationResult | null {
  const seats = (state.playerSeats || []).map(s => ({ ...s, currentBet: 0 }));
  const contenders = seats.filter(s => s.uid && !s.isFolded);

  if (contenders.length <= 1) {
    return awardPotToWinner({ ...state, playerSeats: seats }, contenders[0], 'All other players folded');
  }

  let deck = [...(state.deck || [])];
  let community = [...(state.communityCards || [])];
  let burns = [...(state.burnCards || [])];
  let log = state.actionLog;
  let street = state.street;

  if (street === 'Preflop') {
    const burn = deck.shift();
    community = [deck.shift()!, deck.shift()!, deck.shift()!];
    if (burn) burns = [...burns, burn];
    street = 'Flop';
    log = appendLog(log, `🎴 Flop dealt: ${community.map(c => c.rank + c.suit).join(' ')}`);
  } else if (street === 'Flop') {
    const burn = deck.shift();
    const turnCard = deck.shift()!;
    community = [...community, turnCard];
    if (burn) burns = [...burns, burn];
    street = 'Turn';
    log = appendLog(log, `🎴 Turn dealt: ${turnCard.rank}${turnCard.suit}`);
  } else if (street === 'Turn') {
    const burn = deck.shift();
    const riverCard = deck.shift()!;
    community = [...community, riverCard];
    if (burn) burns = [...burns, burn];
    street = 'River';
    log = appendLog(log, `🎴 River dealt: ${riverCard.rank}${riverCard.suit}`);
  } else {
    return performShowdown({ ...state, playerSeats: seats, communityCards: community });
  }

  const workingState: VTEngineState = {
    ...state,
    playerSeats: seats,
    deck,
    communityCards: community,
    burnCards: burns,
    street,
    currentHighBet: 0,
    actionLog: log
  };

  const eligible = contenders.filter(p => !p.isAllIn).map(p => p.seatNumber).sort((a, b) => a - b);
  if (eligible.length < 2) {
    return advanceStreet(workingState);
  }

  return {
    state: {
      ...workingState,
      currentTurnSeat: eligible[0],
      turnStartedAt: new Date().toISOString()
    }
  };
}

function advanceTurn(state: VTEngineState): EngineMutationResult | null {
  const seats = state.playerSeats || [];
  const contenders = seats.filter(s => s.uid && !s.isFolded);

  if (contenders.length <= 1) {
    return awardPotToWinner(state, contenders[0], 'All other players folded');
  }

  const eligible = contenders.filter(p => !p.isAllIn);
  const highBet = state.currentHighBet || 0;
  const roundComplete = eligible.every(p => (p.currentBet || 0) === highBet);

  if (roundComplete || eligible.length < 2) {
    return advanceStreet(state);
  }

  const order = eligible.map(p => p.seatNumber).sort((a, b) => a - b);
  const currentIdx = order.indexOf(state.currentTurnSeat ?? -1);
  const nextSeat = order[(currentIdx + 1) % order.length];

  return {
    state: {
      ...state,
      currentTurnSeat: nextSeat,
      turnStartedAt: new Date().toISOString()
    }
  };
}

export function dealNewHand(state: VTEngineState): EngineMutationResult | null {
  const seats = state.playerSeats || [];
  const activeSeats = getActiveSeats(seats);
  if (activeSeats.length < 2) return null;

  const freshDeck = createDeck();
  let deckIdx = 0;

  const currDealer = state.dealerSeat ?? activeSeats[0].seatNumber;
  const currIdx = activeSeats.findIndex(s => s.seatNumber === currDealer);
  const n = activeSeats.length;
  const dealerIdx = currIdx === -1 ? 0 : (currIdx + 1) % n;

  const dealerSeatNum = activeSeats[dealerIdx].seatNumber;
  const sbSeatNum = activeSeats[(dealerIdx + 1) % n].seatNumber;
  const bbSeatNum = activeSeats[(dealerIdx + 2) % n].seatNumber;
  const utgSeatNum = activeSeats[(dealerIdx + 3) % n].seatNumber;

  const sb = state.smallBlind || 10;
  const bb = state.bigBlind || 10;

  const updatedSeats = seats.map(seat => {
    if (!seat.uid || seat.isSatOut || seat.chipStack <= 0) {
      return { ...seat, holeCards: [], isFolded: true, isAllIn: false, currentBet: 0, totalInvestedInHand: 0 };
    }

    const c1 = freshDeck[deckIdx++];
    const c2 = freshDeck[deckIdx++];

    let bet = 0;
    let newStack = seat.chipStack;
    if (seat.seatNumber === sbSeatNum) {
      bet = Math.min(sb, seat.chipStack);
      newStack -= bet;
    } else if (seat.seatNumber === bbSeatNum) {
      bet = Math.min(bb, seat.chipStack);
      newStack -= bet;
    }

    return {
      ...seat,
      holeCards: [c1, c2],
      isFolded: false,
      isAllIn: newStack <= 0,
      chipStack: newStack,
      currentBet: bet,
      totalInvestedInHand: bet
    };
  });

  const initialPot = updatedSeats.reduce((sum, s) => sum + (s.currentBet || 0), 0);
  const nextHandNumber = (state.handNumber || 0) + 1;

  return {
    state: {
      ...state,
      deck: freshDeck.slice(deckIdx),
      playerSeats: updatedSeats,
      communityCards: [],
      burnCards: [],
      potSize: initialPot,
      currentHighBet: bb,
      street: 'Preflop',
      dealerSeat: dealerSeatNum,
      currentTurnSeat: utgSeatNum,
      turnStartedAt: new Date().toISOString(),
      winningAnnouncement: null,
      isGameStarted: true,
      handNumber: nextHandNumber,
      actionLog: appendLog(state.actionLog, `♠️ Hand #${nextHandNumber} started. Dealer: Seat ${dealerSeatNum}, SB: ₹${sb}, BB: ₹${bb}`)
    }
  };
}

export function foldSeat(state: VTEngineState, seatNumber: number): EngineMutationResult | null {
  if (state.currentTurnSeat !== seatNumber) return null;
  const seats = (state.playerSeats || []).map(s => (s.seatNumber === seatNumber ? { ...s, isFolded: true } : s));
  const name = seats.find(s => s.seatNumber === seatNumber)?.name || 'Player';
  return advanceTurn({ ...state, playerSeats: seats, actionLog: appendLog(state.actionLog, `❌ ${name} Folded`) });
}

export function checkSeat(state: VTEngineState, seatNumber: number): EngineMutationResult | null {
  if (state.currentTurnSeat !== seatNumber) return null;
  const seat = (state.playerSeats || []).find(s => s.seatNumber === seatNumber);
  if (!seat || (seat.currentBet || 0) !== (state.currentHighBet || 0)) return null;
  return advanceTurn({ ...state, actionLog: appendLog(state.actionLog, `✅ ${seat.name} Checked`) });
}

export function callSeat(state: VTEngineState, seatNumber: number): EngineMutationResult | null {
  if (state.currentTurnSeat !== seatNumber) return null;
  const seats = state.playerSeats || [];
  const seat = seats.find(s => s.seatNumber === seatNumber);
  if (!seat) return null;

  const needed = (state.currentHighBet || 0) - (seat.currentBet || 0);
  const callAmt = Math.max(0, Math.min(needed, seat.chipStack));

  const updatedSeats = seats.map(s => {
    if (s.seatNumber !== seatNumber) return s;
    const newStack = s.chipStack - callAmt;
    return {
      ...s,
      chipStack: newStack,
      currentBet: (s.currentBet || 0) + callAmt,
      totalInvestedInHand: (s.totalInvestedInHand || 0) + callAmt,
      isAllIn: newStack <= 0
    };
  });

  return advanceTurn({
    ...state,
    playerSeats: updatedSeats,
    potSize: (state.potSize || 0) + callAmt,
    actionLog: appendLog(state.actionLog, `💰 ${seat.name} Called ₹${callAmt}`)
  });
}

export function betRaiseSeat(state: VTEngineState, seatNumber: number, targetBet: number): EngineMutationResult | null {
  if (state.currentTurnSeat !== seatNumber) return null;
  const seats = state.playerSeats || [];
  const seat = seats.find(s => s.seatNumber === seatNumber);
  if (!seat) return null;

  const additionalNeeded = Math.max(0, targetBet - (seat.currentBet || 0));
  const actualBetAmt = Math.min(additionalNeeded, seat.chipStack);

  const updatedSeats = seats.map(s => {
    if (s.seatNumber !== seatNumber) return s;
    const newStack = s.chipStack - actualBetAmt;
    return {
      ...s,
      chipStack: newStack,
      currentBet: (s.currentBet || 0) + actualBetAmt,
      totalInvestedInHand: (s.totalInvestedInHand || 0) + actualBetAmt,
      isAllIn: newStack <= 0
    };
  });

  const newHighBet = Math.max(state.currentHighBet || 0, (seat.currentBet || 0) + actualBetAmt);

  return advanceTurn({
    ...state,
    playerSeats: updatedSeats,
    currentHighBet: newHighBet,
    potSize: (state.potSize || 0) + actualBetAmt,
    actionLog: appendLog(state.actionLog, `🔥 ${seat.name} Raised to ₹${newHighBet}`)
  });
}

// Guarded by (currentTurnSeat, turnStartedAt) so a duplicate timeout call
// (two devices racing, a re-invoked effect) is a safe no-op.
export function timeoutSeat(state: VTEngineState, seatNumber: number, expectedTurnStartedAt: string): EngineMutationResult | null {
  if (state.currentTurnSeat !== seatNumber || state.turnStartedAt !== expectedTurnStartedAt) return null;
  const seat = (state.playerSeats || []).find(s => s.seatNumber === seatNumber);
  if (!seat) return null;
  const callAmount = (state.currentHighBet || 0) - (seat.currentBet || 0);
  return callAmount <= 0 ? checkSeat(state, seatNumber) : foldSeat(state, seatNumber);
}
