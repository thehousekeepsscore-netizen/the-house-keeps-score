import { apiFetch } from './api-client';
import { ClubPotLog, PendingChangeRequest, AuditLog, HistoricalPlayerStat, PlayerSessionSummary } from '../types';

export interface NormalizedSession {
  id: string;
  sourceType: 'historical' | 'cashout';
  date: string;
  createdAt: string;
  sessionType: string;
  notes: string | null;
  totalBuyIns: number;
  totalCashOuts: number;
  winnersCut: number;
  rake: number;
  playersCount: number;
  playerStats: { name: string; buyIn: number; cashOut: number; profit: number; userId?: string }[];
  dayNumber: number;
  dayTitle: string;
  /**
   * Present when the server derived this night's buy-ins from approved banks
   * and will do so again on any edit — so the edit form shows the figure
   * rather than a field. Absent on historical records and on nights settled
   * before the server began deriving, whose buy-ins stay editable.
   */
  buyInSource?: 'approved-banks';
}

export async function listHistory(clubId: string): Promise<NormalizedSession[]> {
  return apiFetch<NormalizedSession[]>(`/clubs/${clubId}/history`);
}

export interface LinkPlayerInput {
  recordId: string;
  sourceType: 'historical' | 'cashout';
  playerIndex: number;
  userId: string;
}

export async function linkHistoryPlayer(clubId: string, input: LinkPlayerInput): Promise<void> {
  await apiFetch(`/clubs/${clubId}/history/link`, { method: 'POST', body: input });
}

export interface LeaderboardRow {
  /** Absent for unlinked/manually-imported players with no account. */
  userId?: string;
  name: string;
  netProfit: number;
  sessionsPlayed: number;
  totalBuyIns: number;
  totalCashOuts: number;
  /** Shown on a player's own record in Account Settings, not on the club Leaderboard. */
  biggestWin: number;
  biggestLoss: number;
}

export interface PastSessionEntry {
  userId?: string;
  userName: string;
  buyIn: number;
  cashOut: number;
}

export interface CreatePastSessionInput {
  sessionDate: string;
  title?: string;
  notes?: string;
  entries: PastSessionEntry[];
  mismatchAcknowledged?: boolean;
}

export async function createPastSession(clubId: string, input: CreatePastSessionInput): Promise<any> {
  return apiFetch(`/clubs/${clubId}/history/past-session`, { method: 'POST', body: input });
}

export async function getLeaderboard(clubId: string): Promise<LeaderboardRow[]> {
  return apiFetch<LeaderboardRow[]>(`/clubs/${clubId}/leaderboard`);
}

export async function listPotLog(clubId: string): Promise<ClubPotLog[]> {
  const logs = await apiFetch<{ id: string; clubId: string; sessionId: string | null; amount: number; source: string; note: string; createdAt: string }[]>(
    `/clubs/${clubId}/pot-log`
  );
  return logs.map((l) => ({ ...l, sessionId: l.sessionId ?? undefined, source: l.source as ClubPotLog['source'] }));
}

export interface ChangeFieldDiff {
  field: string;
  oldValue: string;
  newValue: string;
}

export interface RequestSessionChangeInput {
  sessionId: string;
  sourceType: 'historical' | 'cashout';
  sessionTitle: string;
  requestType: 'edit_session' | 'delete_session';
  changes: ChangeFieldDiff[];
  updatedDate?: string;
  updatedNotes?: string;
  updatedPlayerStats?: HistoricalPlayerStat[];
  updatedPlayerSummaries?: PlayerSessionSummary[];
  updatedTotalBuyIns?: number;
  updatedTotalCashOuts?: number;
  reason?: string;
}

export async function requestSessionChange(clubId: string, input: RequestSessionChangeInput): Promise<{ status: 'pending' | 'applied' }> {
  return apiFetch(`/clubs/${clubId}/pending-changes`, { method: 'POST', body: input });
}

export async function listPendingChanges(clubId: string): Promise<PendingChangeRequest[]> {
  const raw = await apiFetch<
    {
      id: string;
      clubId: string;
      sessionId: string;
      sessionTitle: string;
      requestType: 'edit_session' | 'delete_session';
      requestedBy: string;
      requestedByName: string;
      requestedAt: string;
      status: 'pending' | 'approved' | 'rejected';
      approvedBy: string | null;
      approvedByName: string | null;
      actionDate: string | null;
      changes: { diffs: ChangeFieldDiff[] } | null;
      reason: string | null;
    }[]
  >(`/clubs/${clubId}/pending-changes`);

  return raw.map((r) => ({
    id: r.id,
    clubId: r.clubId,
    sessionId: r.sessionId,
    sessionTitle: r.sessionTitle,
    requestType: r.requestType,
    requestedBy: r.requestedBy,
    requestedByName: r.requestedByName,
    requestedAt: r.requestedAt,
    status: r.status,
    approvedBy: r.approvedBy ?? undefined,
    approvedByName: r.approvedByName ?? undefined,
    actionDate: r.actionDate ?? undefined,
    changes: r.changes?.diffs,
    reason: r.reason ?? undefined,
  }));
}

export async function decidePendingChange(clubId: string, requestId: string, approve: boolean): Promise<void> {
  await apiFetch(`/clubs/${clubId}/pending-changes/${requestId}/${approve ? 'approve' : 'reject'}`, { method: 'POST' });
}

export interface DeletedSessionRef {
  id: string;
  sourceType: 'historical' | 'cashout';
  title: string;
}

export async function listDeletedSessions(clubId: string): Promise<DeletedSessionRef[]> {
  return apiFetch<DeletedSessionRef[]>(`/clubs/${clubId}/deleted-sessions`);
}

export async function restoreSession(clubId: string, recordId: string, sourceType: 'historical' | 'cashout', sessionTitle: string): Promise<void> {
  await apiFetch(`/clubs/${clubId}/deleted-sessions/${recordId}/restore`, { method: 'POST', body: { sourceType, sessionTitle } });
}

export async function listAuditLog(clubId: string): Promise<AuditLog[]> {
  return apiFetch<AuditLog[]>(`/clubs/${clubId}/audit-log`);
}
