import { apiFetch } from './api-client';
import { Card } from '../types';

export interface VTSeat {
  seatNumber: number;
  uid: string;
  name: string;
  avatarUrl?: string;
  chipStack: number;
  activeBank: number;
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

export type VTStreet = 'Preflop' | 'Flop' | 'Turn' | 'River' | 'Showdown';

export interface VTSession {
  id: string;
  clubId: string;
  sessionName: string;
  sessionType: string;
  status: 'active' | 'settled';
  startedById: string;
  createdAt: string;
  endedAt: string | null;

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
  street: VTStreet;
  dealerSeat: number;
  potSize: number;
  currentHighBet: number;
  currentTurnSeat: number | null;
  turnStartedAt?: string;
  communityCards: Card[];
  burnCards: Card[];
  playerSeats: VTSeat[];
  winningAnnouncement: { winners: string[]; handDesc: string; amountWon: number } | null;
  actionLog: string[];
}

export interface VTHandHistoryRecord {
  id: string;
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

export interface VTBuyInRequest {
  id: string;
  sessionId: string;
  userId: string;
  amount: number;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
}

export interface CreateVirtualTableInput {
  tableName: string;
  smallBlind: number;
  bigBlind: number;
  minBuyIn: number;
  maxBuyIn: number;
  maxPlayers: number;
  skipBlindLimit: number;
}

export function getActiveVirtualTable(clubId: string): Promise<VTSession | null> {
  return apiFetch(`/clubs/${clubId}/sessions/virtual-table`);
}

export function createVirtualTable(clubId: string, input: CreateVirtualTableInput): Promise<VTSession> {
  return apiFetch(`/clubs/${clubId}/sessions/virtual-table`, { method: 'POST', body: input });
}

export function getSession(sessionId: string): Promise<VTSession> {
  return apiFetch(`/sessions/${sessionId}`);
}

export function enterSeat(sessionId: string): Promise<VTSession> {
  return apiFetch(`/sessions/${sessionId}/enter`, { method: 'POST' });
}

export function addBot(sessionId: string): Promise<VTSession> {
  return apiFetch(`/sessions/${sessionId}/bots`, { method: 'POST' });
}

export function dealHand(sessionId: string): Promise<VTSession> {
  return apiFetch(`/sessions/${sessionId}/deal`, { method: 'POST' });
}

export function fold(sessionId: string): Promise<VTSession> {
  return apiFetch(`/sessions/${sessionId}/fold`, { method: 'POST' });
}

export function check(sessionId: string): Promise<VTSession> {
  return apiFetch(`/sessions/${sessionId}/check`, { method: 'POST' });
}

export function call(sessionId: string): Promise<VTSession> {
  return apiFetch(`/sessions/${sessionId}/call`, { method: 'POST' });
}

export function raise(sessionId: string, targetBet: number): Promise<VTSession> {
  return apiFetch(`/sessions/${sessionId}/raise`, { method: 'POST', body: { targetBet } });
}

export interface UpdateSettingsInput {
  tableName?: string;
  smallBlind?: number;
  bigBlind?: number;
  skipBlindLimit?: number;
}

export function updateSettings(sessionId: string, input: UpdateSettingsInput): Promise<VTSession> {
  return apiFetch(`/sessions/${sessionId}/settings`, { method: 'PATCH', body: input });
}

export function endSession(sessionId: string): Promise<void> {
  return apiFetch(`/sessions/${sessionId}/end`, { method: 'POST' });
}

export function listHandHistory(sessionId: string): Promise<VTHandHistoryRecord[]> {
  return apiFetch(`/sessions/${sessionId}/hand-history`);
}

export function listBuyInRequests(sessionId: string): Promise<VTBuyInRequest[]> {
  return apiFetch(`/sessions/${sessionId}/buy-in-requests`);
}

export function requestBuyIn(sessionId: string, amount: number): Promise<VTBuyInRequest> {
  return apiFetch(`/sessions/${sessionId}/buy-in-requests`, { method: 'POST', body: { amount } });
}

export function decideBuyInRequest(sessionId: string, requestId: string, approve: boolean): Promise<VTSession> {
  return apiFetch(`/sessions/${sessionId}/buy-in-requests/${requestId}/${approve ? 'approve' : 'reject'}`, { method: 'POST' });
}
