import { apiFetch } from './api-client';
import { PokerSession, BuyInRequest, PlayerSessionSummary } from '../types';

interface ApiOfflineSession {
  id: string;
  clubId: string;
  sessionName: string;
  sessionType: 'OFFLINE' | 'LAZY_DEALER';
  status: 'active' | 'settled';
  startedById: string;
  createdAt: string;
  endedAt: string | null;
  activePlayerUids: string[];
  pendingSitInUids?: string[];
  cashOuts?: { userId: string; amount: number; status: 'pending' | 'confirmed'; requestedAt: string; confirmedBy?: string }[];
  assignedDealerUid?: string;
  assignedDealerName?: string;
  smallBlind?: number;
  bigBlind?: number;
  minBuyIn?: number;
  maxBuyIn?: number;
  maxPlayers?: number;
  skipBlindLimit?: number;
}

function toPokerSession(s: ApiOfflineSession): PokerSession {
  return {
    id: s.id,
    clubId: s.clubId,
    sessionName: s.sessionName,
    sessionType: s.sessionType === 'LAZY_DEALER' ? 'Lazy Dealer Session' : 'Offline Session',
    status: s.status,
    activePlayerUids: s.activePlayerUids || [],
    pendingSitInUids: s.pendingSitInUids || [],
    cashOuts: s.cashOuts || [],
    startedBy: s.startedById,
    createdAt: s.createdAt,
    endedAt: s.endedAt ?? undefined,
    assignedDealerUid: s.assignedDealerUid,
    assignedDealerName: s.assignedDealerName,
    smallBlind: s.smallBlind,
    bigBlind: s.bigBlind,
    minBuyIn: s.minBuyIn,
    maxBuyIn: s.maxBuyIn,
    maxPlayers: s.maxPlayers,
    skipBlindLimit: s.skipBlindLimit,
  };
}

interface ApiBuyInRequest {
  id: string;
  sessionId: string;
  clubId: string;
  userId: string;
  amount: number;
  status: 'pending' | 'approved' | 'rejected';
  requestedBy: string;
  approvedBy: string | null;
  createdAt: string;
}

// userDisplayName isn't stored server-side (it's derived from the club
// roster) — callers should look it up via their own allUsers map when
// rendering rather than trust this placeholder.
function toBuyInRequest(r: ApiBuyInRequest): BuyInRequest {
  return {
    id: r.id,
    sessionId: r.sessionId,
    clubId: r.clubId,
    userId: r.userId,
    userDisplayName: '',
    amount: r.amount,
    status: r.status,
    requestedBy: r.requestedBy,
    approvedBy: r.approvedBy ?? undefined,
    createdAt: r.createdAt,
  };
}

export async function getActiveSession(clubId: string): Promise<PokerSession | null> {
  const s = await apiFetch<ApiOfflineSession | null>(`/clubs/${clubId}/offline-sessions/active`);
  return s ? toPokerSession(s) : null;
}

export interface StartSessionInput {
  sessionType: 'OFFLINE' | 'LAZY_DEALER';
  sessionName: string;
  assignedDealerUid?: string;
  assignedDealerName?: string;
  smallBlind?: number;
  bigBlind?: number;
  minBuyIn?: number;
  maxBuyIn?: number;
  maxPlayers?: number;
  skipBlindLimit?: number;
}

export async function startSession(clubId: string, input: StartSessionInput): Promise<PokerSession> {
  const s = await apiFetch<ApiOfflineSession>(`/clubs/${clubId}/offline-sessions`, { method: 'POST', body: input });
  return toPokerSession(s);
}

export async function joinSession(clubId: string, sessionId: string): Promise<PokerSession> {
  const s = await apiFetch<ApiOfflineSession>(`/clubs/${clubId}/offline-sessions/${sessionId}/join`, { method: 'POST' });
  return toPokerSession(s);
}

export async function requestSitIn(clubId: string, sessionId: string): Promise<PokerSession> {
  const s = await apiFetch<ApiOfflineSession>(`/clubs/${clubId}/offline-sessions/${sessionId}/sit-in-requests`, { method: 'POST' });
  return toPokerSession(s);
}

export async function decideSitIn(clubId: string, sessionId: string, userId: string, approve: boolean): Promise<PokerSession> {
  const s = await apiFetch<ApiOfflineSession>(
    `/clubs/${clubId}/offline-sessions/${sessionId}/sit-in-requests/${approve ? 'approve' : 'reject'}`,
    { method: 'POST', body: { userId } }
  );
  return toPokerSession(s);
}

export async function requestCashOut(clubId: string, sessionId: string, amount: number, userId?: string): Promise<PokerSession> {
  const s = await apiFetch<ApiOfflineSession>(`/clubs/${clubId}/offline-sessions/${sessionId}/cash-out-requests`, { method: 'POST', body: { amount, userId } });
  return toPokerSession(s);
}

export async function decideCashOut(clubId: string, sessionId: string, userId: string, approve: boolean): Promise<PokerSession> {
  const s = await apiFetch<ApiOfflineSession>(
    `/clubs/${clubId}/offline-sessions/${sessionId}/cash-out-requests/${approve ? 'approve' : 'reject'}`,
    { method: 'POST', body: { userId } });
  return toPokerSession(s);
}

export async function listBuyInRequests(clubId: string, sessionId: string): Promise<BuyInRequest[]> {
  const list = await apiFetch<ApiBuyInRequest[]>(`/clubs/${clubId}/offline-sessions/${sessionId}/buy-in-requests`);
  return list.map(toBuyInRequest);
}

export async function requestBuyIn(clubId: string, sessionId: string, amount: number, userId?: string): Promise<void> {
  await apiFetch(`/clubs/${clubId}/offline-sessions/${sessionId}/buy-in-requests`, { method: 'POST', body: { amount, userId } });
}

export async function decideBuyInRequest(clubId: string, sessionId: string, requestId: string, approve: boolean): Promise<PokerSession | null> {
  const s = await apiFetch<ApiOfflineSession | null>(
    `/clubs/${clubId}/offline-sessions/${sessionId}/buy-in-requests/${requestId}/${approve ? 'approve' : 'reject'}`,
    { method: 'POST' }
  );
  return s ? toPokerSession(s) : null;
}

export interface SettleInput {
  entries: { userId: string; buyIn: number; cashOut: number; manualWinner?: boolean }[];
  mismatchAcknowledged?: boolean;
}

export async function settleSession(clubId: string, sessionId: string, input: SettleInput): Promise<PlayerSessionSummary[]> {
  const result = await apiFetch<{ playerSummaries: PlayerSessionSummary[] }>(`/clubs/${clubId}/offline-sessions/${sessionId}/settle`, {
    method: 'POST',
    body: input,
  });
  return result.playerSummaries;
}
