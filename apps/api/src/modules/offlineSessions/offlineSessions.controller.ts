import type { Request, Response } from 'express';
import { z } from 'zod';
import * as offlineSessionsService from './offlineSessions.service.js';
import * as clubsService from '../clubs/clubs.service.js';

const startSchema = z.object({
  sessionType: z.enum(['OFFLINE', 'LAZY_DEALER']),
  sessionName: z.string().min(1).max(80),
  assignedDealerUid: z.string().optional(),
  assignedDealerName: z.string().optional(),
  smallBlind: z.number().int().positive().optional(),
  bigBlind: z.number().int().positive().optional(),
  minBuyIn: z.number().int().positive().optional(),
  maxBuyIn: z.number().int().positive().optional(),
  maxPlayers: z.number().int().positive().optional(),
  skipBlindLimit: z.number().int().min(0).max(2).optional(),
  // The night's length, and whether to say anything when it runs out. Capped at
  // a day because the field is minutes and a typo should not create a week.
  durationMinutes: z.number().int().positive().max(24 * 60).optional(),
  remindAtEnd: z.boolean().optional(),
});

export async function startSession(req: Request, res: Response) {
  const input = startSchema.parse(req.body);
  const session = await offlineSessionsService.startSession(req.params.clubId, req.user!.sub, req.user!.isSuperAdmin, input);
  return res.status(201).json(session);
}

const extendSchema = z.object({
  // Same ceiling as the original duration: the field is minutes, and a typo
  // should not buy the night a week.
  minutes: z.number().int().positive().max(24 * 60),
});

/** More time on the clock. Additive, unlimited, admins only. */
export async function extendSession(req: Request, res: Response) {
  const { minutes } = extendSchema.parse(req.body);
  const session = await offlineSessionsService.extendSession(
    req.params.sessionId, req.params.clubId, req.user!.sub, req.user!.isSuperAdmin, minutes);
  return res.json(session);
}

/** Carry on with no limit for the rest of the night. One-way, admins only. */
export async function liftTimeLimit(req: Request, res: Response) {
  const session = await offlineSessionsService.liftTimeLimit(
    req.params.sessionId, req.params.clubId, req.user!.sub, req.user!.isSuperAdmin);
  return res.json(session);
}

/** The host saying "alright, let's start" — the one moment nothing can infer. */
export async function startPlaying(req: Request, res: Response) {
  const session = await offlineSessionsService.startPlaying(
    req.params.sessionId, req.params.clubId, req.user!.sub, req.user!.isSuperAdmin);
  return res.json(session);
}

/**
 * Everything under /clubs/:clubId/offline-sessions is club-private.
 *
 * The decision endpoints already assert admin, so they were safe. The reads and
 * the self-service writes -- the live table, the buy-in list, sitting in,
 * cashing out -- checked authentication only, which meant any account on the
 * platform could watch a club's night and request a seat at its table.
 */
async function assertMemberOfClub(req: Request) {
  const club = await clubsService.getClubOrThrow(req.params.clubId);
  clubsService.assertClubMember(club, req.user!.sub, req.user!.isSuperAdmin);
  return club;
}

export async function getActive(req: Request, res: Response) {
  await assertMemberOfClub(req);
  const session = await offlineSessionsService.getActiveOfflineSession(req.params.clubId);
  return res.json(session);
}

export async function joinSession(req: Request, res: Response) {
  await assertMemberOfClub(req);
  const session = await offlineSessionsService.joinSession(req.params.sessionId, req.user!.sub);
  return res.json(session);
}

export async function requestSitIn(req: Request, res: Response) {
  await assertMemberOfClub(req);
  const session = await offlineSessionsService.requestSitIn(req.params.sessionId, req.params.clubId, req.user!.sub);
  return res.status(201).json(session);
}

const sitInDecisionSchema = z.object({ userId: z.string().min(1) });

export async function decideSitIn(req: Request, res: Response) {
  const { userId } = sitInDecisionSchema.parse(req.body);
  const session = await offlineSessionsService.decideSitIn(
    req.params.sessionId,
    req.params.clubId,
    req.user!.sub,
    req.user!.isSuperAdmin,
    userId,
    req.params.decision === 'approve'
  );
  return res.json(session);
}

const cashOutSchema = z.object({ amount: z.number().int().nonnegative(), userId: z.string().optional() });

export async function requestCashOut(req: Request, res: Response) {
  await assertMemberOfClub(req);
  const { amount, userId } = cashOutSchema.parse(req.body);
  const session = await offlineSessionsService.requestCashOut(
    req.params.sessionId, req.params.clubId, userId || req.user!.sub, amount);
  return res.status(201).json(session);
}

const cashOutDecisionSchema = z.object({
  userId: z.string().min(1),
  // A correction to the submitted count, not a new request — see the service.
  amount: z.number().int().nonnegative().optional(),
});

export async function decideCashOut(req: Request, res: Response) {
  const { userId, amount } = cashOutDecisionSchema.parse(req.body);
  const session = await offlineSessionsService.decideCashOut(
    req.params.sessionId, req.params.clubId, req.user!.sub, req.user!.isSuperAdmin,
    userId, req.params.decision === 'approve', amount);
  return res.json(session);
}

const buyInSchema = z.object({ amount: z.number().int().positive(), userId: z.string().optional() });

export async function requestBuyIn(req: Request, res: Response) {
  await assertMemberOfClub(req);
  const { amount, userId } = buyInSchema.parse(req.body);
  const request = await offlineSessionsService.requestBuyIn(
    req.params.sessionId, req.params.clubId, userId || req.user!.sub, amount, req.user!.sub);
  return res.status(201).json(request);
}

export async function listBuyInRequests(req: Request, res: Response) {
  await assertMemberOfClub(req);
  const requests = await offlineSessionsService.listBuyInRequests(req.params.sessionId);
  return res.json(requests);
}

export async function decideBuyInRequest(req: Request, res: Response) {
  const approve = req.params.decision === 'approve';
  const session = await offlineSessionsService.decideBuyInRequest(
    req.params.sessionId,
    req.user!.sub,
    req.user!.isSuperAdmin,
    req.params.requestId,
    approve
  );
  return res.json(session);
}

const settleSchema = z.object({
  entries: z.array(
    z.object({
      userId: z.string().min(1),
      // Same floor as recording a back-dated night: someone with no buy-in
      // didn't play, and a zero would make them a "winner" on any cash-out
      // while distorting the mismatch and the pot.
      buyIn: z.number().positive('Every player needs a buy-in greater than zero'),
      cashOut: z.number().nonnegative(),
      manualWinner: z.boolean().optional(),
    })
  ),
  mismatchAcknowledged: z.boolean().optional(),
});

export async function settleSession(req: Request, res: Response) {
  const input = settleSchema.parse(req.body);
  const settlement = await offlineSessionsService.settleSession(req.params.sessionId, req.user!.sub, req.user!.isSuperAdmin, input);
  return res.status(201).json(settlement);
}
