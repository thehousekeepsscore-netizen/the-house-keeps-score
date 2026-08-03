import type { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import * as clubRecordsService from './clubRecords.service.js';

async function currentUserName(req: Request) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.sub } });
  return user.displayName;
}

export async function listHistory(req: Request, res: Response) {
  const history = await clubRecordsService.listHistory(req.params.clubId, req.user!.sub, req.user!.isSuperAdmin);
  return res.json(history);
}

const linkSchema = z.object({
  recordId: z.string().min(1),
  sourceType: z.enum(['historical', 'cashout']),
  playerIndex: z.number().int().nonnegative(),
  userId: z.string().min(1),
});

export async function linkHistoryPlayer(req: Request, res: Response) {
  const input = linkSchema.parse(req.body);
  await clubRecordsService.linkHistoryPlayer(req.params.clubId, req.user!.sub, req.user!.isSuperAdmin, input);
  return res.status(204).send();
}

const pastSessionSchema = z.object({
  sessionDate: z.string().min(4),
  title: z.string().max(120).optional(),
  notes: z.string().max(1000).optional(),
  mismatchAcknowledged: z.boolean().optional(),
  entries: z.array(z.object({
    userId: z.string().optional(),
    userName: z.string().min(1).max(80),
    // A player who never bought in didn't play. Zero would also distort the
    // settlement: they'd be a "winner" on any cash-out at all, and the pot and
    // mismatch would be computed against buy-ins that never happened.
    // Cash-out stays nonnegative — busting out with nothing is normal.
    buyIn: z.number().positive('Every player needs a buy-in greater than zero'),
    cashOut: z.number().nonnegative(),
    manualWinner: z.boolean().optional(),
  })).min(1),
});

export async function createPastSession(req: Request, res: Response) {
  const input = pastSessionSchema.parse(req.body);
  const result = await clubRecordsService.createPastSession(
    req.params.clubId, req.user!.sub, req.user!.isSuperAdmin, input);
  return res.status(201).json(result);
}

export async function getLeaderboard(req: Request, res: Response) {
  const leaderboard = await clubRecordsService.getLeaderboard(req.params.clubId, req.user!.sub, req.user!.isSuperAdmin);
  return res.json(leaderboard);
}

export async function listPotLog(req: Request, res: Response) {
  const logs = await clubRecordsService.listPotLog(req.params.clubId, req.user!.sub, req.user!.isSuperAdmin);
  return res.json(logs);
}

const diffSchema = z.object({ field: z.string(), oldValue: z.string(), newValue: z.string() });

const requestChangeSchema = z.object({
  sessionId: z.string().min(1),
  sourceType: z.enum(['historical', 'cashout']),
  sessionTitle: z.string().min(1),
  requestType: z.enum(['edit_session', 'delete_session']),
  changes: z.array(diffSchema),
  updatedDate: z.string().optional(),
  updatedNotes: z.string().optional(),
  // Same floor as recording a night: an edit can't leave a player on a zero
  // buy-in either. `profit`/`netResult` here are ignored — the server
  // re-settles from the buy-in/cash-out pairs.
  updatedPlayerStats: z
    .array(z.object({
      userName: z.string(), userId: z.string().optional(),
      totalBuyIn: z.number().positive('Every player needs a buy-in greater than zero'),
      cashOut: z.number().nonnegative(), profit: z.number(), timestamp: z.string(),
    }))
    .optional(),
  updatedPlayerSummaries: z
    .array(
      z.object({
        userId: z.string(),
        userDisplayName: z.string(),
        totalBuyIn: z.number().positive('Every player needs a buy-in greater than zero'),
        cashOut: z.number().nonnegative(),
        grossProfit: z.number(),
        winnersCutDeduction: z.number(),
        excessDeduction: z.number(),
        netResult: z.number(),
      })
    )
    .optional(),
  updatedTotalBuyIns: z.number().optional(),
  updatedTotalCashOuts: z.number().optional(),
  reason: z.string().optional(),
});

export async function requestSessionChange(req: Request, res: Response) {
  const input = requestChangeSchema.parse(req.body);
  const requesterName = await currentUserName(req);
  const result = await clubRecordsService.requestSessionChange(req.params.clubId, req.user!.sub, requesterName, req.user!.isSuperAdmin, input);
  return res.status(201).json(result);
}

export async function listPendingChanges(req: Request, res: Response) {
  const requests = await clubRecordsService.listPendingChanges(req.params.clubId, req.user!.sub, req.user!.isSuperAdmin);
  return res.json(requests);
}

export async function decidePendingChange(req: Request, res: Response) {
  const approve = req.params.decision === 'approve';
  const requesterName = await currentUserName(req);
  const result = await clubRecordsService.decidePendingChange(
    req.params.clubId,
    req.user!.sub,
    requesterName,
    req.user!.isSuperAdmin,
    req.params.requestId,
    approve
  );
  return res.json(result);
}

export async function listDeletedSessions(req: Request, res: Response) {
  const sessions = await clubRecordsService.listDeletedSessions(req.params.clubId, req.user!.sub, req.user!.isSuperAdmin);
  return res.json(sessions);
}

const restoreSchema = z.object({
  sourceType: z.enum(['historical', 'cashout']),
  sessionTitle: z.string().min(1),
});

export async function restoreSession(req: Request, res: Response) {
  const { sourceType, sessionTitle } = restoreSchema.parse(req.body);
  const requesterName = await currentUserName(req);
  await clubRecordsService.restoreSession(
    req.params.clubId,
    req.user!.sub,
    requesterName,
    req.user!.isSuperAdmin,
    req.params.recordId,
    sourceType,
    sessionTitle
  );
  return res.status(204).send();
}

export async function listAuditLog(req: Request, res: Response) {
  const logs = await clubRecordsService.listAuditLog(req.params.clubId, req.user!.sub, req.user!.isSuperAdmin);
  return res.json(logs);
}
