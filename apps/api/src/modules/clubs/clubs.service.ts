import crypto from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { HttpError } from "../../middleware/errorHandler.js";
import type { RakeMethod, MismatchStrategy, RakeOrder, WinnerDefinition, RoundingRule } from "../offlineSessions/settlementEngine.js";

const MAX_ADMINS_EXCLUDING_OWNER = 2; // owner + up to 2 promoted admins = 3 total

async function generateUniqueClubCode(): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const code = String(Math.floor(10000 + Math.random() * 90000));
    const existing = await prisma.club.findUnique({ where: { code } });
    if (!existing) return code;
  }
  throw new HttpError(500, "Could not generate a unique club code, please retry");
}

const clubInclude = {
  admins: { include: { user: { select: { id: true, displayName: true, avatarUrl: true, email: true } } } },
  members: { include: { user: { select: { id: true, displayName: true, avatarUrl: true, email: true } } } },
  owner: { select: { id: true, displayName: true, avatarUrl: true, email: true } },
} as const;

export type ClubWithRoster = Awaited<ReturnType<typeof getClubOrThrow>>;

export async function listClubs() {
  return prisma.club.findMany({ include: clubInclude, orderBy: { createdAt: "desc" } });
}

export async function getClubOrThrow(clubId: string) {
  const club = await prisma.club.findUnique({ where: { id: clubId }, include: clubInclude });
  if (!club) throw new HttpError(404, "Club not found");
  return club;
}

/**
 * Is this user in the club at all?
 *
 * The weakest of the three roles, and the one that was missing. Admin and owner
 * checks existed from the start, so anything gated on them was safe; everything
 * else was gated on authentication alone, which every account on the platform
 * passes.
 *
 * Owner and admin are included explicitly rather than assumed to be in the
 * members list, because nothing enforces that they are.
 */
export function isClubMember(
  club: { ownerId: string; admins: { userId: string }[]; members: { userId: string }[] },
  userId: string,
  isSuperAdmin: boolean
) {
  return (
    isSuperAdmin ||
    club.ownerId === userId ||
    club.admins.some((a) => a.userId === userId) ||
    club.members.some((m) => m.userId === userId)
  );
}

export function assertClubMember(
  club: { ownerId: string; admins: { userId: string }[]; members: { userId: string }[] },
  userId: string,
  isSuperAdmin: boolean
) {
  if (!isClubMember(club, userId, isSuperAdmin)) {
    // Deliberately the same shape as the admin refusal: a non-member learns
    // that they may not read this, not whether the club exists.
    throw new HttpError(403, "You are not a member of this club");
  }
}

export function isClubAdmin(club: { ownerId: string; admins: { userId: string }[] }, userId: string, isSuperAdmin: boolean) {
  return isSuperAdmin || club.ownerId === userId || club.admins.some((a) => a.userId === userId);
}

export function isClubOwner(club: { ownerId: string }, userId: string, isSuperAdmin: boolean) {
  return isSuperAdmin || club.ownerId === userId;
}

export function assertClubAdmin(club: { ownerId: string; admins: { userId: string }[] }, userId: string, isSuperAdmin: boolean) {
  if (!isClubAdmin(club, userId, isSuperAdmin)) {
    throw new HttpError(403, "Only a Club Admin or Owner can do this");
  }
}

export function assertClubOwner(club: { ownerId: string }, userId: string, isSuperAdmin: boolean) {
  if (!isClubOwner(club, userId, isSuperAdmin)) {
    throw new HttpError(403, "Only the Club Owner can do this");
  }
}

export interface CreateClubInput {
  name: string;
  description?: string;
  minBuyIn?: number;
  maxBuyIn?: number;
  devaluationFactor?: number;
  enableDevaluation?: boolean;
  rakeEnabled?: boolean;
  rakeMethod?: RakeMethod;
  buyInMode?: 'MATCH_HIGHEST' | 'UNCAPPED';
  sessionRakeAmount?: number;
  winnersCutPercent?: number;
  rakeValue?: number;
  potEnabled?: boolean;
  mismatchStrategy?: MismatchStrategy;
  rakeOrder?: RakeOrder;
  winnerDefinition?: WinnerDefinition;
  winnerTopN?: number;
  roundingRule?: RoundingRule;
  leaderboardVisibleToPlayers?: boolean;
}

export async function createClub(ownerId: string, input: CreateClubInput) {
  const code = await generateUniqueClubCode();

  // A rake has to have somewhere to land. With the Club Pot off, the engine
  // still deducts the cut from winners but banks nothing, so the money leaves
  // the players and the app has no record of where it went — the settlement
  // invariant (nets + pot == 0) quietly stops holding. Rules are immutable
  // after creation, so a club created this way could never be corrected.
  const chargesRake = (input.sessionRakeAmount ?? 0) > 0 || (input.winnersCutPercent ?? 0) > 0;
  if (chargesRake && !(input.potEnabled ?? false)) {
    throw new HttpError(
      400,
      'A club that charges a session rake or a winners\' cut must enable the Club Pot — otherwise the money is taken from players but never banked.'
    );
  }

  return prisma.club.create({
    data: {
      name: input.name,
      code,
      description: input.description,
      ownerId,
      minBuyIn: input.minBuyIn ?? 1000,
      maxBuyIn: input.maxBuyIn ?? 5000,
      devaluationFactor: input.devaluationFactor ?? 1,
      enableDevaluation: input.enableDevaluation ?? false,
      rakeEnabled: input.rakeEnabled ?? false,
      rakeMethod: input.rakeMethod ?? "PERCENT_PROFIT",
      buyInMode: input.buyInMode ?? 'MATCH_HIGHEST',
      sessionRakeAmount: input.sessionRakeAmount ?? 0,
      winnersCutPercent: input.winnersCutPercent ?? 0,
      rakeValue: input.rakeValue ?? 5,
      potEnabled: input.potEnabled ?? false,
      mismatchStrategy: input.mismatchStrategy ?? "PROPORTIONAL_WINNERS",
      rakeOrder: input.rakeOrder ?? "MISMATCH_FIRST",
      winnerDefinition: input.winnerDefinition ?? "PROFIT_POSITIVE",
      winnerTopN: input.winnerTopN ?? 1,
      roundingRule: input.roundingRule ?? "NONE",
      // Stated explicitly rather than left to the column default, so the
      // privacy posture of a new club is visible here alongside its rules.
      leaderboardVisibleToPlayers: input.leaderboardVisibleToPlayers ?? false,
      members: { create: { userId: ownerId } },
    },
    include: clubInclude,
  });
}

export interface UpdateClubInput {
  name?: string;
  minBuyIn?: number;
  maxBuyIn?: number;
  enableDevaluation?: boolean;
  devaluationFactor?: number;
  leaderboardVisibleToPlayers?: boolean;
  rakeEnabled?: boolean;
  rakeMethod?: RakeMethod;
  buyInMode?: 'MATCH_HIGHEST' | 'UNCAPPED';
  sessionRakeAmount?: number;
  winnersCutPercent?: number;
  rakeValue?: number;
  potEnabled?: boolean;
  mismatchStrategy?: MismatchStrategy;
  rakeOrder?: RakeOrder;
  winnerDefinition?: WinnerDefinition;
  winnerTopN?: number;
  roundingRule?: RoundingRule;
}

/**
 * The rules a club plays by are fixed at creation.
 *
 * Everything here feeds the settlement engine or the money on the table, and
 * the app has no concept of a rule's effective date: history is re-settled with
 * whatever the club's rules say *now*, so editing a back-dated night — or
 * re-settling one after an edit — would silently restate old results under new
 * rules. Freezing them removes that whole class of problem. A club that wants
 * to play differently starts a new club.
 *
 * Deliberately NOT frozen: the club's name and description, and
 * `leaderboardVisibleToPlayers`, which is a visibility preference rather than a
 * rule and is meant to be toggled.
 */
const IMMUTABLE_CLUB_RULES = [
  'minBuyIn', 'maxBuyIn', 'enableDevaluation', 'devaluationFactor', 'buyInMode',
  'rakeEnabled', 'rakeMethod', 'rakeValue', 'sessionRakeAmount', 'winnersCutPercent',
  'potEnabled', 'mismatchStrategy', 'rakeOrder', 'winnerDefinition', 'winnerTopN',
  'roundingRule',
] as const satisfies readonly (keyof UpdateClubInput)[];

export async function updateClub(clubId: string, userId: string, isSuperAdmin: boolean, input: UpdateClubInput) {
  const club = await getClubOrThrow(clubId);
  assertClubAdmin(club, userId, isSuperAdmin);

  // Whether players can see the Leaderboard at all is an Owner-level call —
  // regular admins can tune the rest but not this.
  if (input.leaderboardVisibleToPlayers !== undefined) {
    assertClubOwner(club, userId, isSuperAdmin);
  }

  // Only an actual change is rejected. A client that echoes the current values
  // back on save still works, which keeps this from breaking existing forms.
  const attempted = IMMUTABLE_CLUB_RULES.filter(
    (field) => input[field] !== undefined && input[field] !== (club as Record<string, unknown>)[field]
  );
  if (attempted.length > 0) {
    throw new HttpError(
      400,
      `A club's rules are fixed when it is created and cannot be changed later (${attempted.join(', ')}). Create a new club to play by different rules.`
    );
  }

  const { name, description, leaderboardVisibleToPlayers } = input as UpdateClubInput & { description?: string };
  return prisma.club.update({
    where: { id: clubId },
    data: {
      ...(name !== undefined ? { name } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(leaderboardVisibleToPlayers !== undefined ? { leaderboardVisibleToPlayers } : {}),
    },
    include: clubInclude,
  });
}

// Lets a super admin join+admin any club in one step, bypassing the normal
// join-request flow (mirrors the original app's "Super Join as Admin" button).
export async function superuserJoin(clubId: string, userId: string, isSuperAdmin: boolean) {
  if (!isSuperAdmin) throw new HttpError(403, "Only a Super Admin can do this");
  await prisma.$transaction([
    prisma.clubMember.upsert({ where: { clubId_userId: { clubId, userId } }, create: { clubId, userId }, update: {} }),
    prisma.clubAdmin.upsert({ where: { clubId_userId: { clubId, userId } }, create: { clubId, userId }, update: {} }),
  ]);
  return getClubOrThrow(clubId);
}

export async function deleteClub(clubId: string, userId: string, isSuperAdmin: boolean) {
  const club = await getClubOrThrow(clubId);
  assertClubOwner(club, userId, isSuperAdmin);
  await prisma.club.delete({ where: { id: clubId } });
}

export async function requestToJoin(clubId: string, userId: string) {
  const club = await getClubOrThrow(clubId);

  if (club.members.some((m) => m.userId === userId)) {
    throw new HttpError(409, "You are already a member of this club");
  }

  const existingPending = await prisma.clubJoinRequest.findFirst({
    where: { clubId, userId, status: "pending" },
  });
  if (existingPending) {
    throw new HttpError(409, "You already have a pending join request for this club");
  }

  return prisma.clubJoinRequest.create({ data: { clubId, userId } });
}

// A user should only ever see: their own outgoing requests, or incoming
// requests for clubs they admin — never every club's requests globally.
export async function listRelevantJoinRequests(userId: string, isSuperAdmin: boolean) {
  const adminClubIds = isSuperAdmin
    ? undefined
    : (
        await prisma.club.findMany({
          where: { OR: [{ ownerId: userId }, { admins: { some: { userId } } }] },
          select: { id: true },
        })
      ).map((c) => c.id);

  return prisma.clubJoinRequest.findMany({
    where: isSuperAdmin
      ? {}
      : { OR: [{ userId }, { clubId: { in: adminClubIds } }] },
    include: {
      user: { select: { id: true, displayName: true, avatarUrl: true, email: true } },
      club: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: "desc" },
  });
}

export async function decideJoinRequest(clubId: string, requestId: string, ownerUserId: string, isSuperAdmin: boolean, accept: boolean) {
  const club = await getClubOrThrow(clubId);
  // Only the owner decides join requests — admins can run the table but
  // don't get a say in who's let into the club.
  assertClubOwner(club, ownerUserId, isSuperAdmin);

  const request = await prisma.clubJoinRequest.findUnique({ where: { id: requestId } });
  if (!request || request.clubId !== clubId) throw new HttpError(404, "Join request not found");
  if (request.status !== "pending") throw new HttpError(409, "This request has already been decided");

  if (accept && club.members.length >= club.maxCapacity) {
    throw new HttpError(400, `This club is already at its maximum of ${club.maxCapacity} players`);
  }

  return prisma.$transaction(async (tx) => {
    const updated = await tx.clubJoinRequest.update({
      where: { id: requestId },
      data: { status: accept ? "accepted" : "rejected" },
    });
    if (accept) {
      await tx.clubMember.upsert({
        where: { clubId_userId: { clubId, userId: request.userId } },
        create: { clubId, userId: request.userId },
        update: {},
      });
    }
    return updated;
  });
}

export async function promoteAdmin(clubId: string, ownerId: string, isSuperAdmin: boolean, targetUserId: string) {
  const club = await getClubOrThrow(clubId);
  assertClubOwner(club, ownerId, isSuperAdmin);

  if (!club.members.some((m) => m.userId === targetUserId)) {
    throw new HttpError(400, "User must be a club member before becoming an admin");
  }
  if (club.admins.length >= MAX_ADMINS_EXCLUDING_OWNER && !club.admins.some((a) => a.userId === targetUserId)) {
    throw new HttpError(400, `A club can have at most ${MAX_ADMINS_EXCLUDING_OWNER} additional admins besides the owner`);
  }

  await prisma.clubAdmin.upsert({
    where: { clubId_userId: { clubId, userId: targetUserId } },
    create: { clubId, userId: targetUserId },
    update: {},
  });
  return getClubOrThrow(clubId);
}

export async function demoteAdmin(clubId: string, ownerId: string, isSuperAdmin: boolean, targetUserId: string) {
  const club = await getClubOrThrow(clubId);
  assertClubOwner(club, ownerId, isSuperAdmin);
  await prisma.clubAdmin.deleteMany({ where: { clubId, userId: targetUserId } });
  return getClubOrThrow(clubId);
}

export async function removeMember(clubId: string, adminUserId: string, isSuperAdmin: boolean, targetUserId: string) {
  const club = await getClubOrThrow(clubId);
  assertClubAdmin(club, adminUserId, isSuperAdmin);
  if (targetUserId === club.ownerId) {
    throw new HttpError(400, "The club owner cannot be removed");
  }

  await prisma.$transaction([
    prisma.clubAdmin.deleteMany({ where: { clubId, userId: targetUserId } }),
    prisma.clubMember.deleteMany({ where: { clubId, userId: targetUserId } }),
  ]);
  return getClubOrThrow(clubId);
}
