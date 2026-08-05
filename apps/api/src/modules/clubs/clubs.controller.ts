import type { Request, Response } from "express";
import { z } from "zod";
import * as clubsService from "./clubs.service.js";

function serializeClub(club: clubsService.ClubWithRoster, currentUserId: string) {
  return {
    id: club.id,
    name: club.name,
    code: club.code,
    description: club.description,
    ownerId: club.ownerId,
    owner: club.owner,
    maxCapacity: club.maxCapacity,
    minBuyIn: club.minBuyIn,
    maxBuyIn: club.maxBuyIn,
    devaluationFactor: club.devaluationFactor,
    enableDevaluation: club.enableDevaluation,
    clubPotBalance: club.clubPotBalance,
    leaderboardVisibleToPlayers: club.leaderboardVisibleToPlayers,
    sessionRakeAmount: club.sessionRakeAmount,
    winnersCutPercent: club.winnersCutPercent,
    buyInMode: club.buyInMode,
    rakeEnabled: club.rakeEnabled,
    rakeMethod: club.rakeMethod,
    rakeValue: club.rakeValue,
    potEnabled: club.potEnabled,
    mismatchStrategy: club.mismatchStrategy,
    rakeOrder: club.rakeOrder,
    winnerDefinition: club.winnerDefinition,
    winnerTopN: club.winnerTopN,
    roundingRule: club.roundingRule,
    createdAt: club.createdAt,
    admins: club.admins.map((a) => a.user),
    members: club.members.map((m) => m.user),
    isOwner: club.ownerId === currentUserId,
    isAdmin: clubsService.isClubAdmin(club, currentUserId, false),
    isMember: club.members.some((m) => m.userId === currentUserId),
    ...relationship(club),
  };
}

/**
 * The counts and role flags both projections carry.
 *
 * Callers used to derive these from the roster arrays -- memberUids.length for
 * the count, memberUids.includes(me) for the flag -- which meant the browse
 * screen needed the full roster just to render "12/20 members". Computing them
 * here is what lets the public projection omit the roster entirely.
 */
function relationship(club: clubsService.ClubWithRoster) {
  return {
    memberCount: club.members.length,
    adminCount: club.admins.length,
  };
}

/**
 * What someone outside the club may see.
 *
 * This is an allowlist, not a blocklist, and deliberately so: a field added to
 * the club model in future is private until someone chooses to add it here.
 * The reverse -- deleting sensitive keys from the full record -- fails open,
 * and failing open is how every member's email address ended up on
 * GET /clubs in the first place.
 *
 * Omitted on purpose: the roster (and therefore every member's email address),
 * the pot balance, and the entire rake and settlement configuration. None of it
 * is needed to decide whether to ask to join, which is the only thing a
 * non-member does with a club.
 *
 * `code` is included because it is a display label, not an invite secret --
 * nothing joins a club by code; joining is always by request and approval.
 */
function serializeClubPublic(club: clubsService.ClubWithRoster, currentUserId: string) {
  return {
    id: club.id,
    name: club.name,
    code: club.code,
    description: club.description,
    maxCapacity: club.maxCapacity,
    createdAt: club.createdAt,
    ...relationship(club),
    isOwner: false,
    isAdmin: false,
    isMember: false,
    // Transitional, for the window where a deployed API is newer than a
    // deployed client. The previous bundle maps c.admins/c.members
    // unconditionally, so omitting them entirely throws inside toClub and
    // blanks the dashboard until Vercel catches up. Empty is not a leak, and
    // it only ever applies to clubs the caller is not in.
    // Remove once no client older than 0231045 is in circulation.
    admins: [],
    members: [],
  };
}

export async function list(req: Request, res: Response) {
  const clubs = await clubsService.listClubs();
  const userId = req.user!.sub;
  const isSuperAdmin = req.user!.isSuperAdmin;
  // Chosen per club, per caller: your own clubs come back whole so the
  // dashboard can still seed the cache and paint a club on the first frame,
  // while everything else is reduced to what the browse list needs.
  return res.json(
    clubs.map((c) =>
      clubsService.isClubMember(c, userId, isSuperAdmin)
        ? serializeClub(c, userId)
        : serializeClubPublic(c, userId)
    )
  );
}

export async function getOne(req: Request, res: Response) {
  const club = await clubsService.getClubOrThrow(req.params.clubId);
  // Members only. Browsing reads the list, which carries the public projection;
  // nothing outside the club needs a single club's full record.
  clubsService.assertClubMember(club, req.user!.sub, req.user!.isSuperAdmin);
  return res.json(serializeClub(club, req.user!.sub));
}

const rakeMethodSchema = z.enum(['PERCENT_PROFIT', 'PERCENT_CASHOUT', 'FIXED_PER_WINNER', 'FIXED_PER_SESSION', 'CUSTOM']);
const mismatchStrategySchema = z.enum([
  'PROPORTIONAL_WINNERS',
  'EQUAL_WINNERS',
  'EQUAL_ALL',
  'SHORTFALL_TO_POT',
  'EXCESS_FROM_POT',
  'MANUAL',
  'CUSTOM',
]);
const rakeOrderSchema = z.enum(['MISMATCH_FIRST', 'RAKE_FIRST']);
const winnerDefinitionSchema = z.enum(['PROFIT_POSITIVE', 'TOP_N', 'MANUAL', 'CUSTOM']);
const roundingRuleSchema = z.enum(['NONE', 'NEAREST_1', 'NEAREST_5', 'NEAREST_10']);

const createSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500).optional(),
  minBuyIn: z.number().int().positive().optional(),
  maxBuyIn: z.number().int().positive().optional(),
  devaluationFactor: z.number().int().positive().optional(),
  enableDevaluation: z.boolean().optional(),
  leaderboardVisibleToPlayers: z.boolean().optional(),
  rakeEnabled: z.boolean().optional(),
  rakeMethod: rakeMethodSchema.optional(),
  buyInMode: z.enum(['MATCH_HIGHEST', 'UNCAPPED']).optional(),
  sessionRakeAmount: z.number().int().nonnegative().max(1_000_000).optional(),
  winnersCutPercent: z.number().int().min(0).max(100).optional(),
  rakeValue: z.number().int().nonnegative().optional(),
  potEnabled: z.boolean().optional(),
  mismatchStrategy: mismatchStrategySchema.optional(),
  rakeOrder: rakeOrderSchema.optional(),
  winnerDefinition: winnerDefinitionSchema.optional(),
  winnerTopN: z.number().int().positive().optional(),
  roundingRule: roundingRuleSchema.optional(),
});

export async function create(req: Request, res: Response) {
  const input = createSchema.parse(req.body);
  const club = await clubsService.createClub(req.user!.sub, input);
  return res.status(201).json(serializeClub(club, req.user!.sub));
}

const updateSchema = createSchema.partial().omit({ description: true });

export async function update(req: Request, res: Response) {
  const input = updateSchema.parse(req.body);
  const club = await clubsService.updateClub(req.params.clubId, req.user!.sub, req.user!.isSuperAdmin, input);
  return res.json(serializeClub(club, req.user!.sub));
}

export async function remove(req: Request, res: Response) {
  await clubsService.deleteClub(req.params.clubId, req.user!.sub, req.user!.isSuperAdmin);
  return res.status(204).send();
}

export async function superuserJoin(req: Request, res: Response) {
  const club = await clubsService.superuserJoin(req.params.clubId, req.user!.sub, req.user!.isSuperAdmin);
  return res.json(serializeClub(club, req.user!.sub));
}

export async function requestToJoin(req: Request, res: Response) {
  const request = await clubsService.requestToJoin(req.params.clubId, req.user!.sub);
  return res.status(201).json(request);
}

export async function listJoinRequests(req: Request, res: Response) {
  const requests = await clubsService.listRelevantJoinRequests(req.user!.sub, req.user!.isSuperAdmin);
  return res.json(requests);
}

export async function decideJoinRequest(req: Request, res: Response) {
  const accept = req.params.decision === "accept";
  const result = await clubsService.decideJoinRequest(
    req.params.clubId,
    req.params.requestId,
    req.user!.sub,
    req.user!.isSuperAdmin,
    accept
  );
  return res.json(result);
}

const targetUserSchema = z.object({ userId: z.string().min(1) });

export async function promoteAdmin(req: Request, res: Response) {
  const { userId } = targetUserSchema.parse(req.body);
  const club = await clubsService.promoteAdmin(req.params.clubId, req.user!.sub, req.user!.isSuperAdmin, userId);
  return res.json(serializeClub(club, req.user!.sub));
}

export async function demoteAdmin(req: Request, res: Response) {
  const club = await clubsService.demoteAdmin(req.params.clubId, req.user!.sub, req.user!.isSuperAdmin, req.params.userId);
  return res.json(serializeClub(club, req.user!.sub));
}

export async function removeMember(req: Request, res: Response) {
  const club = await clubsService.removeMember(req.params.clubId, req.user!.sub, req.user!.isSuperAdmin, req.params.userId);
  return res.json(serializeClub(club, req.user!.sub));
}
