import { apiFetch } from './api-client';
import { Club, ClubJoinRequest } from '../types';
import { RakeMethod, MismatchStrategy, RakeOrder, WinnerDefinition, RoundingRule } from './settlementEngine';

interface ApiUserRef {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  email: string;
}

export interface ApiClub {
  id: string;
  name: string;
  code: string;
  description: string | null;
  // Everything below `owner` is present only in the member projection. The
  // public projection carries the counts and flags at the bottom instead.
  ownerId?: string;
  owner?: ApiUserRef;
  memberCount: number;
  adminCount: number;
  maxCapacity: number;
  buyInMode: 'MATCH_HIGHEST' | 'UNCAPPED';
  minBuyIn: number;
  maxBuyIn: number;
  devaluationFactor: number;
  enableDevaluation: boolean;
  clubPotBalance: number;
  leaderboardVisibleToPlayers: boolean;
  sessionRakeAmount: number;
  winnersCutPercent: number;
  rakeEnabled: boolean;
  rakeMethod: RakeMethod;
  rakeValue: number;
  potEnabled: boolean;
  mismatchStrategy: MismatchStrategy;
  rakeOrder: RakeOrder;
  winnerDefinition: WinnerDefinition;
  winnerTopN: number;
  roundingRule: RoundingRule;
  createdAt: string;
  admins: ApiUserRef[];
  members: ApiUserRef[];
  isOwner: boolean;
  isAdmin: boolean;
  isMember: boolean;
}

interface ApiJoinRequest {
  id: string;
  clubId: string;
  userId: string;
  status: 'pending' | 'accepted' | 'rejected';
  createdAt: string;
  user: ApiUserRef;
  club: { id: string; name: string };
}

// Maps the new relational API response back onto the original Club shape
// (adminUids/memberUids as plain uid arrays) so components not yet migrated
// off Firestore (ClubDetailView, LazyDealerConsole, VirtualTableView) keep
// working unchanged during the phased migration.
export function toClub(c: ApiClub): Club {
  return {
    id: c.id,
    name: c.name,
    code: c.code,
    description: c.description ?? undefined,
    ownerUid: c.ownerId,
    maxCapacity: c.maxCapacity,
    buyInMode: c.buyInMode,
    minBuyIn: c.minBuyIn,
    maxBuyIn: c.maxBuyIn,
    devaluationFactor: c.devaluationFactor,
    enableDevaluation: c.enableDevaluation,
    clubPotBalance: c.clubPotBalance,
    leaderboardVisibleToPlayers: c.leaderboardVisibleToPlayers,
    sessionRakeAmount: c.sessionRakeAmount,
    winnersCutPercent: c.winnersCutPercent,
    rakeEnabled: c.rakeEnabled,
    rakeMethod: c.rakeMethod,
    rakeValue: c.rakeValue,
    potEnabled: c.potEnabled,
    mismatchStrategy: c.mismatchStrategy,
    rakeOrder: c.rakeOrder,
    winnerDefinition: c.winnerDefinition,
    winnerTopN: c.winnerTopN,
    roundingRule: c.roundingRule,
    adminUids: c.admins?.map(a => a.id) ?? [],
    memberUids: c.members?.map(m => m.id) ?? [],
    memberCount: c.memberCount,
    adminCount: c.adminCount,
    isMember: c.isMember,
    isAdmin: c.isAdmin,
    isOwner: c.isOwner,
    createdBy: c.ownerId,
    createdAt: c.createdAt,
  };
}

export function toClubJoinRequest(r: ApiJoinRequest): ClubJoinRequest {
  return {
    id: r.id,
    clubId: r.clubId,
    clubName: r.club.name,
    userId: r.userId,
    userDisplayName: r.user.displayName,
    userAvatarUrl: r.user.avatarUrl ?? undefined,
    userEmail: r.user.email,
    status: r.status,
    createdAt: r.createdAt,
  };
}

export async function listClubsRaw(): Promise<ApiClub[]> {
  return apiFetch<ApiClub[]>('/clubs');
}

export interface CreateClubInput {
  name: string;
  description?: string;
  buyInMode?: 'MATCH_HIGHEST' | 'UNCAPPED';
  minBuyIn?: number;
  maxBuyIn?: number;
  devaluationFactor?: number;
  enableDevaluation?: boolean;
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
}

export async function createClub(input: CreateClubInput): Promise<Club> {
  const club = await apiFetch<ApiClub>('/clubs', { method: 'POST', body: input });
  return toClub(club);
}

export interface UpdateClubInput {
  name?: string;
  buyInMode?: 'MATCH_HIGHEST' | 'UNCAPPED';
  minBuyIn?: number;
  maxBuyIn?: number;
  devaluationFactor?: number;
  enableDevaluation?: boolean;
  leaderboardVisibleToPlayers?: boolean;
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
}

export async function updateClub(clubId: string, input: UpdateClubInput): Promise<Club> {
  const club = await apiFetch<ApiClub>(`/clubs/${clubId}`, { method: 'PATCH', body: input });
  return toClub(club);
}

export async function getClub(clubId: string): Promise<Club> {
  const club = await apiFetch<ApiClub>(`/clubs/${clubId}`);
  return toClub(club);
}

export interface ClubRosterEntry {
  uid: string;
  displayName: string;
  email: string;
  avatarUrl?: string;
}

// Rich name/email/avatar lookup for every user this club's ClubDetailView
// could ever need to display (buy-in requesters, history players, audit log
// actors are always club members) — replaces the old Firestore "all
// registered users" listener, which leaked every user in the whole app.
export async function getClubRoster(clubId: string): Promise<Record<string, ClubRosterEntry>> {
  const club = await apiFetch<ApiClub>(`/clubs/${clubId}`);
  const roster: Record<string, ClubRosterEntry> = {};
  [club.owner, ...club.admins, ...club.members].forEach((u) => {
    roster[u.id] = { uid: u.id, displayName: u.displayName, email: u.email, avatarUrl: u.avatarUrl ?? undefined };
  });
  return roster;
}

export async function requestJoinClub(clubId: string): Promise<void> {
  await apiFetch(`/clubs/${clubId}/join-requests`, { method: 'POST' });
}

export async function listJoinRequests(): Promise<ClubJoinRequest[]> {
  const requests = await apiFetch<ApiJoinRequest[]>('/clubs/join-requests');
  return requests.map(toClubJoinRequest);
}

export async function decideJoinRequest(clubId: string, requestId: string, accept: boolean): Promise<void> {
  await apiFetch(`/clubs/${clubId}/join-requests/${requestId}/${accept ? 'accept' : 'reject'}`, { method: 'POST' });
}

export async function promoteAdmin(clubId: string, userId: string): Promise<Club> {
  const club = await apiFetch<ApiClub>(`/clubs/${clubId}/admins`, { method: 'POST', body: { userId } });
  return toClub(club);
}

export async function demoteAdmin(clubId: string, userId: string): Promise<Club> {
  const club = await apiFetch<ApiClub>(`/clubs/${clubId}/admins/${userId}`, { method: 'DELETE' });
  return toClub(club);
}

export async function superuserJoin(clubId: string): Promise<Club> {
  const club = await apiFetch<ApiClub>(`/clubs/${clubId}/superuser-join`, { method: 'POST' });
  return toClub(club);
}

export async function removeMember(clubId: string, userId: string): Promise<Club> {
  const club = await apiFetch<ApiClub>(`/clubs/${clubId}/members/${userId}`, { method: 'DELETE' });
  return toClub(club);
}

export async function deleteClub(clubId: string): Promise<void> {
  await apiFetch(`/clubs/${clubId}`, { method: 'DELETE' });
}
