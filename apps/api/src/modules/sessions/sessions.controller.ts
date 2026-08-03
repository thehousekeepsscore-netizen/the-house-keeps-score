import type { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { HttpError } from '../../middleware/errorHandler.js';
import * as sessionsService from './sessions.service.js';

async function currentUser(req: Request) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.sub } });
  return user;
}

export async function getActiveVirtualTable(req: Request, res: Response) {
  const session = await sessionsService.getActiveVirtualTableSession(req.params.clubId, req.user!.sub);
  return res.json(session);
}

const createSchema = z.object({
  tableName: z.string().min(1).max(80),
  smallBlind: z.number().int().positive(),
  bigBlind: z.number().int().positive(),
  minBuyIn: z.number().int().positive(),
  maxBuyIn: z.number().int().positive(),
  maxPlayers: z.number().int().min(2).max(11),
  skipBlindLimit: z.number().int().min(0).max(2),
});

export async function createVirtualTable(req: Request, res: Response) {
  const input = createSchema.parse(req.body);
  const user = await currentUser(req);
  const session = await sessionsService.createVirtualTableSession(
    req.params.clubId,
    user.id,
    user.displayName,
    user.avatarUrl ?? undefined,
    input
  );
  return res.status(201).json(session);
}

export async function getOne(req: Request, res: Response) {
  const session = await sessionsService.getSession(req.params.sessionId, req.user!.sub);
  return res.json(session);
}

export async function enter(req: Request, res: Response) {
  const user = await currentUser(req);
  const session = await sessionsService.enterSeat(req.params.sessionId, user.id, user.displayName, user.avatarUrl ?? undefined);
  return res.json(session);
}

export async function addBot(req: Request, res: Response) {
  const session = await sessionsService.addBot(req.params.sessionId, req.user!.sub, req.user!.isSuperAdmin);
  return res.json(session);
}

export async function dealHand(req: Request, res: Response) {
  const session = await sessionsService.dealHand(req.params.sessionId, req.user!.sub, req.user!.isSuperAdmin);
  return res.json(session);
}

export async function fold(req: Request, res: Response) {
  const session = await sessionsService.fold(req.params.sessionId, req.user!.sub);
  return res.json(session);
}

export async function check(req: Request, res: Response) {
  const session = await sessionsService.check(req.params.sessionId, req.user!.sub);
  return res.json(session);
}

export async function call(req: Request, res: Response) {
  const session = await sessionsService.call(req.params.sessionId, req.user!.sub);
  return res.json(session);
}

const raiseSchema = z.object({ targetBet: z.number().int().nonnegative() });

export async function betRaise(req: Request, res: Response) {
  const { targetBet } = raiseSchema.parse(req.body);
  const session = await sessionsService.betRaise(req.params.sessionId, req.user!.sub, targetBet);
  return res.json(session);
}

const settingsSchema = z.object({
  tableName: z.string().min(1).max(80).optional(),
  smallBlind: z.number().int().positive().optional(),
  bigBlind: z.number().int().positive().optional(),
  skipBlindLimit: z.number().int().min(0).max(2).optional(),
});

export async function updateSettings(req: Request, res: Response) {
  const input = settingsSchema.parse(req.body);
  const session = await sessionsService.updateSettings(req.params.sessionId, req.user!.sub, req.user!.isSuperAdmin, input);
  return res.json(session);
}

export async function endSession(req: Request, res: Response) {
  await sessionsService.endSession(req.params.sessionId, req.user!.sub, req.user!.isSuperAdmin);
  return res.status(204).send();
}

export async function listHandHistory(req: Request, res: Response) {
  const records = await sessionsService.listHandHistory(req.params.sessionId);
  return res.json(records);
}

const buyInSchema = z.object({ amount: z.number().int().positive() });

export async function requestBuyIn(req: Request, res: Response) {
  const { amount } = buyInSchema.parse(req.body);
  const session = await prisma.pokerSession.findUnique({ where: { id: req.params.sessionId } });
  if (!session) throw new HttpError(404, 'Session not found');
  const request = await sessionsService.requestBuyIn(req.params.sessionId, session.clubId, req.user!.sub, amount);
  return res.status(201).json(request);
}

export async function listBuyInRequests(req: Request, res: Response) {
  const requests = await sessionsService.listBuyInRequests(req.params.sessionId);
  return res.json(requests);
}

export async function decideBuyInRequest(req: Request, res: Response) {
  const approve = req.params.decision === 'approve';
  const session = await sessionsService.decideBuyInRequest(
    req.params.sessionId,
    req.params.requestId,
    req.user!.sub,
    req.user!.isSuperAdmin,
    approve
  );
  return res.json(session);
}
