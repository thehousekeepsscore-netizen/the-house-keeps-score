export interface Card {
  id: string;
  rank: string;
  suit: string;
  color: string;
  isRed: boolean;
  suitName: string;
}

export interface VTSeat {
  seatNumber: number;
  uid: string;
  name: string;
  avatarUrl?: string;
  chipStack: number;
  activeBank: number;
  // When activeBank last changed (initial seating or an approved buy-in) —
  // going forward every session bank needs a timestamp, not just a total.
  bankUpdatedAt: string;
  isFolded: boolean;
  isSatOut: boolean;
  holeCards: Card[];
  currentBet?: number;
  totalInvestedInHand?: number;
  isAllIn?: boolean;
  statVPIP?: number;
  statPFR?: number;
  statHandsPlayed?: number;
}

export type Street = 'Preflop' | 'Flop' | 'Turn' | 'River' | 'Showdown';

export interface VTEngineState {
  hostUid: string;
  hostName: string;
  tableName: string;
  smallBlind: number;
  bigBlind: number;
  minBuyIn: number;
  maxBuyIn: number;
  maxPlayers: number;
  skipBlindLimit: number;

  isGameStarted: boolean;
  handNumber: number;
  street: Street;
  dealerSeat: number;
  potSize: number;
  currentHighBet: number;
  currentTurnSeat: number | null;
  turnStartedAt?: string;
  communityCards: Card[];
  burnCards: Card[];
  deck: Card[];
  playerSeats: VTSeat[];
  winningAnnouncement: { winners: string[]; handDesc: string; amountWon: number } | null;
  actionLog: string[];
}

export interface HandHistoryPayload {
  handNumber: number;
  dealerSeat: number;
  smallBlind: number;
  bigBlind: number;
  communityCards: Card[];
  potTotal: number;
  winnerNames: string[];
  winningHandDesc: string;
  timestamp: string;
}
