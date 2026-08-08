import { RakeMethod, MismatchStrategy, RakeOrder, WinnerDefinition, RoundingRule } from './lib/settlementEngine';

export interface Suit {
  symbol: string;
  name: string;
  color: string;
  isRed: boolean;
}

export interface Card {
  id: string;
  rank: string;
  suit: string;
  color: string;
  isRed: boolean;
  suitName: string;
}

export interface Player {
  id: string;
  name: string;
  avatarUrl?: string;
  isConnected?: boolean;
}

export interface Seat {
  seatNumber: number;
  player: Player | null;
  isSatOut: boolean;
  isFolded: boolean;
  holeCards: Card[];
}

export interface Board {
  id: number;
  flop: Card[];
  turn: Card | null;
  river: Card | null;
}

export interface ToastMessage {
  id: string;
  title: string;
  message: string;
  type?: 'success' | 'info' | 'warning';
}

export interface Club {
  id: string;
  name: string;
  code?: string;
  description?: string;
  ownerUid?: string; // Single Club Owner
  maxCapacity: number; // Default 50 players
  /** MATCH_HIGHEST | UNCAPPED — how the table's buy-in ceiling is decided. */
  buyInMode?: 'MATCH_HIGHEST' | 'UNCAPPED';
  minBuyIn?: number; // Default ₹1,000
  maxBuyIn?: number; // Default ₹5,000
  devaluationFactor?: number; // Devaluation ratio (e.g. 5 means 5 points = ₹1 INR cash)
  enableDevaluation?: boolean; // Whether currency devaluation is enabled
  clubPotBalance?: number;
  leaderboardVisibleToPlayers?: boolean; // Owner-controlled — when false, only Owner/Admins can view the Leaderboard tab
  // ---- Settlement Rules (config-driven Cashout Engine, see lib/settlementEngine.ts) ----
  sessionRakeAmount?: number;
  winnersCutPercent?: number;
  rakeEnabled?: boolean;
  rakeMethod?: RakeMethod;
  rakeValue?: number;
  potEnabled?: boolean;
  mismatchStrategy?: MismatchStrategy;
  rakeOrder?: RakeOrder;
  winnerDefinition?: WinnerDefinition;
  winnerTopN?: number;
  roundingRule?: RoundingRule;
  // Rosters arrive only for clubs the viewer belongs to. A club they are merely
  // browsing carries counts and flags instead — the server decides which, so a
  // non-member cannot be handed a roster by asking differently.
  adminUids: string[]; // Up to 2 additional assigned Club Admins (Max 3 total admins including Owner)
  memberUids: string[];
  memberCount: number;
  adminCount: number;
  isMember: boolean;
  isAdmin: boolean;
  isOwner: boolean;
  createdBy: string;
  createdAt: string;
}

export interface ClubJoinRequest {
  id: string;
  clubId: string;
  clubName: string;
  userId: string;
  userDisplayName: string;
  userAvatarUrl?: string;
  userEmail?: string;
  status: 'pending' | 'accepted' | 'rejected';
  createdAt: string;
}

export interface LazyPlayerSeat {
  seatNumber: number;
  uid: string;
  name: string;
  avatarUrl?: string;
  chipStack: number;
  activeBank: number;
  isFolded: boolean;
  isSatOut: boolean;
  skippedBlindsCount: number;
  holeCards: Card[];
  blindRole?: 'SB' | 'BB' | 'D' | null;
  status?: 'Waiting' | 'Acting' | 'Folded' | 'All-In' | 'Sitting Out' | 'Blocked';
  // Virtual Table automated betting-engine fields
  currentBet?: number;
  totalInvestedInHand?: number;
  isAllIn?: boolean;
  timeBankRemaining?: number;
  statVPIP?: number;
  statPFR?: number;
  statHandsPlayed?: number;
}

export interface PokerSession {
  id: string;
  clubId: string;
  sessionName: string;
  sessionType?: 'Offline Session' | 'Lazy Dealer Session' | 'Virtual Table Session';
  status: 'active' | 'settled';
  activePlayerUids: string[];
  pendingSitInUids?: string[];
  /**
   * When each pending sit-in was asked for. The server has always sent this —
   * it is part of engineState — but the client dropped it, which left sit-ins
   * as the one request type with no timestamp, so they could not be ordered
   * against the other two or shown a countdown.
   */
  sitInRequestedAt?: Record<string, string>;
  cashOuts?: {
    userId: string; amount: number; status: 'pending' | 'confirmed';
    requestedAt: string; confirmedBy?: string;
    /** Set when an admin corrected an already-agreed count. */
    amendedBy?: string; amendedAt?: string;
  }[];
  /**
   * When the host said "alright, let's start", or null while the table is open
   * and people are still gathering.
   *
   * UNDEFINED means a session created before the lobby existed. Those are being
   * played right now, so they are read as started — see deriveNight.
   */
  startedPlayingAt?: string | null;
  /**
   * Minutes the host originally set aside. Absent means no limit.
   *
   * The PLAN, not the current total — extensions live beside it so the feed can
   * say "started with a 2-hour timer" and "extended by 30 minutes" rather than
   * silently showing a bigger number. See scheduledMinutes in night-clock.ts.
   */
  durationMinutes?: number;
  /** Every extension, in the order they were granted. Additive and unlimited. */
  timeExtensions?: { minutes: number; at: string }[];
  /**
   * When the host chose to carry on with no limit.
   *
   * One-way for the rest of the night, and that is the point: it is what stops
   * a night running three hours over from showing a grace period every five
   * minutes for the last two of them.
   */
  timeLimitLiftedAt?: string | null;
  /**
   * When the host started settling, and the table stopped moving.
   *
   * Figures cannot be agreed while they are still changing underneath. Nothing
   * mutates from here until the night settles or the host hands it back —
   * reversible on purpose, because a mis-tap must not hold a room hostage.
   */
  settlingAt?: string | null;
  /** Superseded by the grace period, which is a banner rather than an alert. */
  remindAtEnd?: boolean;
  startedBy: string;
  createdAt: string;
  endedAt?: string;
  // Lazy Dealer Mode Fields
  assignedDealerUid?: string;
  assignedDealerName?: string;
  smallBlind?: number;
  bigBlind?: number;
  minBuyIn?: number;
  maxBuyIn?: number;
  maxPlayers?: number;
  skipBlindLimit?: number;
  isGameStarted?: boolean;
  handNumber?: number;
  street?: 'Preflop' | 'Flop' | 'Turn' | 'River' | 'Showdown' | 'HandFinished';
  potSize?: number;
  dealerSeat?: number;
  communityCards?: Card[];
  burnCards?: Card[];
  deck?: Card[];
  playerSeats?: LazyPlayerSeat[];
  // Virtual Table automated betting-engine fields
  currentHighBet?: number;
  currentTurnSeat?: number | null;
  turnStartedAt?: string;
  winningAnnouncement?: {
    winners: string[];
    handDesc: string;
    amountWon: number;
  } | null;
  actionLog?: string[];
}

export interface HandHistoryRecord {
  id: string;
  sessionId: string;
  clubId: string;
  handNumber: number;
  dealerSeat: number;
  smallBlind: number;
  bigBlind: number;
  communityCards: Card[];
  potTotal: number;
  winnerNames: string[];
  winningHandDesc: string;
  timestamp: string;
  createdAt: string;
}

export interface BuyInRequest {
  id: string;
  sessionId: string;
  clubId: string;
  userId: string;
  userDisplayName: string;
  amount: number;
  status: 'pending' | 'approved' | 'rejected';
  requestedBy: string;
  approvedBy?: string;
  createdAt: string;
}

export interface PlayerSessionSummary {
  userId: string;
  userDisplayName: string;
  totalBuyIn: number;
  cashOut: number;
  grossProfit: number; // initial profit: cashOut - totalBuyIn, before any adjustment
  excessDeduction: number; // Step 3: mismatch adjustment, applied to winners first, proportional to initial profit
  winnersCutDeduction: number; // Step 4: rake — winnersCutPercent of the ADJUSTED profit (post-mismatch), winners only
  netResult: number; // final net profit or loss: grossProfit - excessDeduction - winnersCutDeduction
}

export interface CashOutSettlement {
  id: string;
  sessionId: string;
  clubId: string;
  sessionType?: 'Offline Session' | 'Lazy Dealer Session' | 'Virtual Table Session';
  dayNumber?: number;
  isDeleted?: boolean;
  settledBy: string;
  totalBuyIns: number;
  totalCashOuts: number;
  totalWinnersCut: number;
  rakeCollected: number;
  potAdjustment: number; // if buyIns > cashOuts, leftover added to pot
  playerSummaries: PlayerSessionSummary[];
  settledAt: string;
  notes?: string;
}

export interface ClubPotLog {
  id: string;
  clubId: string;
  sessionId?: string;
  amount: number;
  source: 'fixed_rake' | 'winners_cut' | 'buyin_leftover' | 'manual_adjustment';
  note: string;
  createdAt: string;
}

export interface HistoricalPlayerStat {
  userName: string;
  userId?: string;
  totalBuyIn: number;
  cashOut: number;
  profit: number;
  // When this player's bank (buy-in) was set for the session. Real live
  // sessions derive this from the BuyInRequest/seat-update that granted the
  // bank; imported historical records don't have a real per-player time, so
  // this carries a dummy value (the session's own date/time) instead.
  timestamp: string;
}

export interface HistoricalSessionRecord {
  id: string;
  clubId: string;
  sessionDate: string;
  sessionTitle: string;
  sessionType?: 'Offline Session' | 'Lazy Dealer Session' | 'Virtual Table Session';
  dayNumber?: number;
  isDeleted?: boolean;
  playerStats: HistoricalPlayerStat[];
  notes?: string;
  importedBy: string;
  createdAt: string;
}

export interface PendingChangeRequest {
  id: string;
  clubId: string;
  sessionId: string;
  sessionTitle: string;
  requestType: 'edit_session' | 'delete_session';
  requestedBy: string;
  requestedByName: string;
  requestedAt: string;
  status: 'pending' | 'approved' | 'rejected';
  approvedBy?: string;
  approvedByName?: string;
  actionDate?: string;
  changes?: {
    field: string;
    oldValue: any;
    newValue: any;
  }[];
  reason?: string;
}

export interface AuditLog {
  id: string;
  clubId: string;
  sessionId?: string;
  sessionTitle?: string;
  action: 'edit_session' | 'delete_session' | 'restore_session' | 'approve_request' | 'reject_request';
  changedBy: string;
  changedByName: string;
  approvedBy?: string;
  approvedByName?: string;
  details: string;
  changes?: {
    field: string;
    oldValue: any;
    newValue: any;
  }[];
  createdAt: string;
}
