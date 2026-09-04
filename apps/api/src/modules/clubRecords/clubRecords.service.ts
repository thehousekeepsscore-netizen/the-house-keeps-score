import { prisma } from '../../lib/prisma.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { emitToClub } from '../../realtime/socket.js';
import * as clubsService from '../clubs/clubs.service.js';
import { computeSettlement, SettlementSettings, SETTLEMENT_ENGINE_VERSION } from '../offlineSessions/settlementEngine.js';
import {
  BUY_IN_SOURCE_APPROVED_BANKS,
  buildCanonicalInputs,
  canonicalOutputsFrom,
  hasAuthoritativeBuyIns,
} from '../offlineSessions/canonicalSettlement.js';
import { AUDIT_SCHEMA_VERSION } from './auditMeta.js';
import { Prisma } from '@prisma/client';

interface HistoricalPlayerStat {
  userName: string;
  userId?: string;
  totalBuyIn: number;
  cashOut: number;
  profit: number;
  timestamp: string;
}

interface PlayerSessionSummary {
  userId: string;
  userDisplayName: string;
  totalBuyIn: number;
  cashOut: number;
  grossProfit: number;
  winnersCutDeduction: number;
  excessDeduction: number;
  netResult: number;
}

function hasOtherAdmins(club: { admins: { userId: string }[] }, excludeUserId: string) {
  return club.admins.some((a) => a.userId !== excludeUserId);
}

// ---------- Club pot ledger ----------
//
// The pot was previously increment-only: settling or recording a night added to
// it, and nothing ever took anything back out. Deleting a session therefore
// stranded its rake in the balance forever, with no way to tell which sessions
// the money belonged to. `ClubPotLog` is the ledger of record, so every
// correction is written there as its own row rather than by rewriting history —
// the balance is always the sum of the rows.
const POT_REVERSAL_SOURCE = 'session_reversal';

type PotTx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/**
 * Pot rows are keyed by the *live session* id, not the settlement row's own id:
 * settleSession logs against `PokerSession.id`, which a CashOutSettlement
 * stores in its `sessionId` column. Back-dated nights have no live session, so
 * they key off the historical record's own id.
 */
async function potKeyFor(tx: PotTx, recordId: string, sourceType: 'historical' | 'cashout') {
  if (sourceType === 'historical') return recordId;
  const settlement = await tx.cashOutSettlement.findUnique({
    where: { id: recordId },
    select: { sessionId: true },
  });
  return settlement?.sessionId ?? recordId;
}

/**
 * `net` is what this session currently holds in the pot; `intended` is what it
 * would hold if it weren't reversed. Reversals are tagged so restoring a
 * deleted session can put back exactly what was taken out, including any
 * adjustment an edit made along the way.
 */
async function potLedgerFor(tx: PotTx, clubId: string, potKey: string) {
  const rows = await tx.clubPotLog.findMany({
    where: { clubId, sessionId: potKey },
    select: { amount: true, source: true },
  });
  return {
    net: rows.reduce((sum, r) => sum + r.amount, 0),
    intended: rows.filter((r) => r.source !== POT_REVERSAL_SOURCE).reduce((sum, r) => sum + r.amount, 0),
  };
}

/** Moves the pot by `delta` and records why. No-ops on zero. */
async function movePot(
  tx: PotTx,
  clubId: string,
  potKey: string,
  delta: number,
  source: string,
  note: string
) {
  if (delta === 0) return;
  await tx.clubPotLog.create({ data: { clubId, sessionId: potKey, amount: delta, source, note } });
  await tx.club.update({ where: { id: clubId }, data: { clubPotBalance: { increment: delta } } });
}

// ---------- History ----------


export interface CreatePastSessionInput {
  /** ISO date the night was actually played (not when it was recorded). */
  sessionDate: string;
  title?: string;
  entries: { userId?: string; userName: string; buyIn: number; cashOut: number; manualWinner?: boolean }[];
  notes?: string;
  mismatchAcknowledged?: boolean;
}

/**
 * Records a night that was played before it was entered into the app.
 *
 * Owner-only: a back-dated night rewrites lifetime standings for everyone in
 * the club, so it's a stronger action than settling a live session (which any
 * admin may do).
 *
 * The figures run through the same computeSettlement() the live cash-out uses,
 * so the club's rake, winners' cut and mismatch rules apply identically —
 * this is never a raw insert of whatever numbers were typed.
 *
 * NOTE: the club's rules as they stand *today* are applied, not whatever they
 * were on the date played. The app keeps no history of rule changes, so a
 * night recorded after a rake change settles under the new rules.
 */
export async function createPastSession(
  clubId: string,
  requesterId: string,
  isSuperAdmin: boolean,
  input: CreatePastSessionInput
) {
  const club = await clubsService.getClubOrThrow(clubId);
  clubsService.assertClubOwner(club, requesterId, isSuperAdmin);

  // A poker night needs opponents — a single-player record is always a mistake.
  if ((input.entries?.length ?? 0) < 2) throw new HttpError(400, 'A session needs at least two players');
  const when = new Date(input.sessionDate);
  if (Number.isNaN(when.getTime())) throw new HttpError(400, 'Invalid session date');
  if (when.getTime() > Date.now()) throw new HttpError(400, 'A past session cannot be dated in the future');

  const settings: SettlementSettings = {
    sessionRakeAmount: club.sessionRakeAmount,
    winnersCutPercent: club.winnersCutPercent,
    rakeEnabled: club.rakeEnabled,
    rakeMethod: club.rakeMethod as SettlementSettings['rakeMethod'],
    rakeValue: club.rakeValue,
    potEnabled: club.potEnabled,
    mismatchStrategy: club.mismatchStrategy as SettlementSettings['mismatchStrategy'],
    rakeOrder: club.rakeOrder as SettlementSettings['rakeOrder'],
    winnerDefinition: club.winnerDefinition as SettlementSettings['winnerDefinition'],
    winnerTopN: club.winnerTopN,
    roundingRule: club.roundingRule as SettlementSettings['roundingRule'],
  };

  // Built once, then both run and recorded — see the matching note in
  // settleSession. Participant order is arithmetic, so the array the engine
  // settles must be the array the canonical record keeps.
  const enginePlayers = input.entries.map((e, i) => ({
    userId: e.userId || `unlinked:${i}:${e.userName}`,
    userDisplayName: e.userName,
    buyIn: Number(e.buyIn || 0),
    cashOut: Number(e.cashOut || 0),
    manualWinner: e.manualWinner,
  }));

  const result = computeSettlement(enginePlayers, settings, {
    currentPotBalance: club.clubPotBalance,
    mismatchAcknowledged: input.mismatchAcknowledged,
  });

  const canonicalInputs = buildCanonicalInputs({
    rules: settings,
    players: enginePlayers,
    currentPotBalance: club.clubPotBalance,
    mismatchAcknowledged: input.mismatchAcknowledged,
    capturedFrom: 'createPastSession',
  });
  const canonicalOutputs = canonicalOutputsFrom(result, canonicalInputs);

  if (result.requiresManualResolution) {
    throw new HttpError(409, 'This club requires manual mismatch resolution — acknowledge it before recording.');
  }

  const playerStats: HistoricalPlayerStat[] = result.players.map((p, i) => ({
    userName: p.userDisplayName,
    // Synthetic ids are placeholders for players with no account; they must
    // not leak into stats, or the leaderboard would treat them as real users.
    userId: input.entries[i]?.userId,
    totalBuyIn: p.totalBuyIn,
    cashOut: p.cashOut,
    profit: p.netResult,
    timestamp: when.toISOString(),
  }));

  // Duplicate protection. Recording a night twice doubles every player's
  // profit in the history and the leaderboard, and unlike a duplicate buy-in
  // request nobody has to approve it — it lands straight in the numbers.
  //
  // Until now the only thing preventing it was a `savingPast` flag in the UI,
  // which protects a well-behaved client and nothing else.
  //
  // The key is deliberately the club, the date AND the exact figures rather
  // than club+date alone: two genuinely different sessions on one evening are
  // plausible, two sessions with an identical set of players and identical
  // buy-ins and cash-outs to the chip are not.
  const sameDay = await prisma.historicalSessionRecord.findMany({
    where: { clubId, sessionDate: when.toISOString(), isDeleted: false },
    select: { id: true, playerStats: true },
  });
  const fingerprint = (stats: HistoricalPlayerStat[]) =>
    stats
      .map((p) => `${p.userId ?? p.userName}:${p.totalBuyIn}:${p.cashOut}`)
      .sort()
      .join('|');
  const incoming = fingerprint(playerStats);
  if (sameDay.some((r) => fingerprint(r.playerStats as unknown as HistoricalPlayerStat[]) === incoming)) {
    throw new HttpError(409, 'An identical session for this date has already been recorded');
  }

  const record = await prisma.$transaction(async (tx) => {
    const created = await tx.historicalSessionRecord.create({
      data: {
        clubId,
        sessionDate: when.toISOString(),
        sessionTitle: input.title?.trim() || when.toDateString(),
        sessionType: 'Offline Session',
        playerStats: playerStats as any,
        notes: input.notes,
        importedBy: requesterId,
        /*
         * A back-dated night now records the rules it was settled under.
         *
         * Its audit row never did — meta carried the engine version and not the
         * rules — so a record_past_session record could say which engine ran
         * and not what it was told. Every night recorded from here on carries
         * both, on the record itself.
         */
        engineVersion: canonicalInputs.engineVersion,
        canonicalInputs: canonicalInputs as unknown as Prisma.InputJsonValue,
        canonicalOutputs: canonicalOutputs as unknown as Prisma.InputJsonValue,
      },
    });

    // Recording a back-dated night creates money records, so it leaves a
    // trace like every edit, deletion and restore already does.
    //
    // Written inside the same transaction and placed immediately after the
    // record exists, before the pot movement that can still fail — see the
    // matching note in settleSession. Keyed on the record's own id, the
    // same id applySessionChange audits against, so a record's whole life
    // shares one sessionId. One row per created record; two deliberate
    // submissions are two records and correctly two rows.
    const actor = await tx.user.findUnique({ where: { id: requesterId }, select: { displayName: true } });
    await tx.auditLog.create({
      data: {
        clubId,
        sessionId: created.id,
        sessionTitle: created.sessionTitle,
        action: 'record_past_session',
        changedBy: requesterId,
        changedByName: actor?.displayName ?? 'Unknown',
        details:
          `Recorded back-dated night ${created.sessionTitle} (played ${when.toDateString()}) ` +
          `for ${playerStats.length} player(s): ${result.totalBuyIns} in / ${result.totalCashOuts} out, ` +
          `house take ${result.totalRakeCollected}, pot ${result.potContribution >= 0 ? '+' : ''}${result.potContribution}.`,
        changes: {
          // See auditMeta.ts — provenance that cannot be reconstructed later.
          meta: {
            auditSchemaVersion: AUDIT_SCHEMA_VERSION,
            settlementEngineVersion: SETTLEMENT_ENGINE_VERSION,
            createdFrom: 'createPastSession',
          },
          sessionDate: when.toISOString(),
          totalBuyIns: result.totalBuyIns,
          totalCashOuts: result.totalCashOuts,
          mismatchAmount: result.mismatchAmount,
          totalRakeCollected: result.totalRakeCollected,
          potContribution: result.potContribution,
          players: result.players.map((p) => ({
            userId: p.userId,
            userDisplayName: p.userDisplayName,
            totalBuyIn: p.totalBuyIn,
            cashOut: p.cashOut,
            netResult: p.netResult,
          })),
        } as any,
      },
    });

    // Rake from a back-dated night funds the pot exactly as a live one would.
    if (club.potEnabled && result.potContribution !== 0) {
      await tx.clubPotLog.create({
        data: {
          clubId,
          // Keyed to the record so the contribution can be reversed if the
          // night is later edited or deleted — see potLedgerFor().
          sessionId: created.id,
          amount: result.potContribution,
          source: 'fixed_rake',
          note: `Back-dated session recorded for ${when.toDateString()}`,
        },
      });
      await tx.club.update({
        where: { id: clubId },
        data: { clubPotBalance: { increment: result.potContribution } },
      });
    }

    return created;
  });

  emitToClub(clubId, 'club:history-updated', { recordId: record.id });
  return { record, settlement: result };
}

export async function listHistory(clubId: string, requesterId: string, isSuperAdmin: boolean) {
  const club = await clubsService.getClubOrThrow(clubId);
  // Every other record endpoint asserts admin, which incidentally excluded
  // non-members. These two branch on admin instead of asserting it, so a
  // stranger fell through to the player view and read the club's results.
  clubsService.assertClubMember(club, requesterId, isSuperAdmin);
  const isAdmin = clubsService.isClubAdmin(club, requesterId, isSuperAdmin);

  const [historicalRecords, cashOutSettlements] = await Promise.all([
    prisma.historicalSessionRecord.findMany({ where: { clubId, isDeleted: false } }),
    prisma.cashOutSettlement.findMany({ where: { clubId, isDeleted: false } }),
  ]);

  interface RawItem {
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
    /**
     * Whether this record's buy-ins are server-derived from approved banks.
     * The edit form reads it to decide whether the buy-in is a field or a
     * figure — the same test the server applies when the edit lands, so the
     * screen and the service cannot disagree about which nights are locked.
     * Absent on historical records and on every settlement stamped before
     * the marker existed.
     */
    buyInSource?: 'approved-banks';
  }

  const rawList: RawItem[] = [];

  historicalRecords.forEach((hr) => {
    const stats = hr.playerStats as unknown as HistoricalPlayerStat[];
    rawList.push({
      id: hr.id,
      sourceType: 'historical',
      // Date-only, matching the settlement branch below. A full ISO timestamp
      // here is silently rejected by the edit form's <input type="date">,
      // which then renders blank and demands the date be re-entered.
      date: String(hr.sessionDate).split('T')[0],
      createdAt: hr.createdAt.toISOString(),
      sessionType: hr.sessionType || 'Offline Session',
      notes: hr.notes,
      totalBuyIns: stats.reduce((s, p) => s + (p.totalBuyIn || 0), 0),
      totalCashOuts: stats.reduce((s, p) => s + (p.cashOut || 0), 0),
      winnersCut: 0,
      rake: 0,
      playersCount: stats.length,
      playerStats: stats.map((p) => ({ name: p.userName, buyIn: p.totalBuyIn, cashOut: p.cashOut, profit: p.profit, userId: p.userId })),
    });
  });

  cashOutSettlements.forEach((cs) => {
    const stats = cs.playerSummaries as unknown as PlayerSessionSummary[];
    rawList.push({
      id: cs.id,
      sourceType: 'cashout',
      date: cs.settledAt.toISOString().split('T')[0],
      createdAt: cs.settledAt.toISOString(),
      sessionType: cs.sessionType || 'Offline Session',
      notes: cs.notes,
      totalBuyIns: cs.totalBuyIns,
      totalCashOuts: cs.totalCashOuts,
      winnersCut: cs.totalWinnersCut,
      rake: cs.rakeCollected,
      playersCount: stats.length,
      playerStats: stats.map((p) => ({ name: p.userDisplayName, buyIn: p.totalBuyIn, cashOut: p.cashOut, profit: p.netResult, userId: p.userId })),
      ...(hasAuthoritativeBuyIns(cs.canonicalInputs) ? { buyInSource: BUY_IN_SOURCE_APPROVED_BANKS } : {}),
    });
  });

  rawList.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  const withDay = rawList.map((item, idx) => ({ ...item, dayNumber: idx + 1, dayTitle: `Day ${idx + 1}` }));
  withDay.sort((a, b) => b.dayNumber - a.dayNumber);

  // A plain player only ever sees their own row for a given day — the day
  // itself (and its aggregate totals) still shows so they know a session
  // happened, but the per-player breakdown is redacted down to just them.
  return withDay.map((item) => (isAdmin ? item : { ...item, playerStats: item.playerStats.filter((p) => p.userId === requesterId) }));
}

export interface LinkPlayerInput {
  recordId: string;
  sourceType: 'historical' | 'cashout';
  playerIndex: number;
  userId: string;
}

export async function linkHistoryPlayer(clubId: string, requesterId: string, isSuperAdmin: boolean, input: LinkPlayerInput) {
  const club = await clubsService.getClubOrThrow(clubId);
  clubsService.assertClubAdmin(club, requesterId, isSuperAdmin);

  const targetUser = await prisma.user.findUnique({ where: { id: input.userId } });
  if (!targetUser) throw new HttpError(404, 'User not found');

  if (input.sourceType === 'historical') {
    const record = await prisma.historicalSessionRecord.findUnique({ where: { id: input.recordId } });
    if (!record || record.clubId !== clubId) throw new HttpError(404, 'Record not found');
    const stats = [...(record.playerStats as unknown as HistoricalPlayerStat[])];
    if (!stats[input.playerIndex]) throw new HttpError(400, 'Invalid player index');
    stats[input.playerIndex] = { ...stats[input.playerIndex], userName: targetUser.displayName, userId: targetUser.id };
    await prisma.historicalSessionRecord.update({ where: { id: input.recordId }, data: { playerStats: stats as any } });
  } else {
    const record = await prisma.cashOutSettlement.findUnique({ where: { id: input.recordId } });
    if (!record || record.clubId !== clubId) throw new HttpError(404, 'Record not found');
    const stats = [...(record.playerSummaries as unknown as PlayerSessionSummary[])];
    if (!stats[input.playerIndex]) throw new HttpError(400, 'Invalid player index');
    stats[input.playerIndex] = { ...stats[input.playerIndex], userDisplayName: targetUser.displayName, userId: targetUser.id };
    await prisma.cashOutSettlement.update({ where: { id: input.recordId }, data: { playerSummaries: stats as any } });
  }

  emitToClub(clubId, 'club:history-updated', { recordId: input.recordId });
}

// ---------- Leaderboard ----------

export async function getLeaderboard(clubId: string, requesterId: string, isSuperAdmin: boolean) {
  const club = await clubsService.getClubOrThrow(clubId);
  // Every other record endpoint asserts admin, which incidentally excluded
  // non-members. These two branch on admin instead of asserting it, so a
  // stranger fell through to the player view and read the club's results.
  clubsService.assertClubMember(club, requesterId, isSuperAdmin);
  const isAdmin = clubsService.isClubAdmin(club, requesterId, isSuperAdmin);
  if (!isAdmin && !club.leaderboardVisibleToPlayers) {
    throw new HttpError(403, 'The Leaderboard is currently hidden for players in this club');
  }

  const [historicalRecords, cashOutSettlements] = await Promise.all([
    prisma.historicalSessionRecord.findMany({ where: { clubId, isDeleted: false } }),
    prisma.cashOutSettlement.findMany({ where: { clubId, isDeleted: false } }),
  ]);

  interface Row {
    key: string;
    name: string;
    netProfit: number;
    sessionsPlayed: number;
    totalBuyIns: number;
    totalCashOuts: number;
    // Still returned for a player's own record in Account Settings, even
    // though the club Leaderboard no longer shows them.
    biggestWin: number;
    biggestLoss: number;
  }
  const statsMap = new Map<string, Row>();
  const getOrCreate = (key: string, name: string) => {
    let row = statsMap.get(key);
    if (!row) {
      row = { key, name, netProfit: 0, sessionsPlayed: 0, totalBuyIns: 0, totalCashOuts: 0, biggestWin: 0, biggestLoss: 0 };
      statsMap.set(key, row);
    }
    // Prefer a real linked display name over a still-unlinked one once seen.
    if (name) row.name = name;
    return row;
  };

  historicalRecords.forEach((hr) => {
    const stats = hr.playerStats as unknown as HistoricalPlayerStat[];
    stats.forEach((p) => {
      const key = p.userId || `name:${p.userName}`;
      const row = getOrCreate(key, p.userName);
      row.sessionsPlayed += 1;
      row.totalBuyIns += p.totalBuyIn;
      row.totalCashOuts += p.cashOut;
      row.netProfit += p.profit;
      if (p.profit > row.biggestWin) row.biggestWin = p.profit;
      if (p.profit < row.biggestLoss) row.biggestLoss = p.profit;
    });
  });

  cashOutSettlements.forEach((cs) => {
    const stats = cs.playerSummaries as unknown as PlayerSessionSummary[];
    stats.forEach((p) => {
      const key = p.userId || `name:${p.userDisplayName}`;
      const row = getOrCreate(key, p.userDisplayName);
      row.sessionsPlayed += 1;
      row.totalBuyIns += p.totalBuyIn;
      row.totalCashOuts += p.cashOut;
      row.netProfit += p.netResult;
      if (p.netResult > row.biggestWin) row.biggestWin = p.netResult;
      if (p.netResult < row.biggestLoss) row.biggestLoss = p.netResult;
    });
  });

  // Expose userId so callers can match a row to an account reliably. Rows
  // keyed by name are unlinked/manual imports and have no account to point at.
  return Array.from(statsMap.values())
    .map(({ key, ...rest }) => ({ userId: key.startsWith('name:') ? undefined : key, ...rest }))
    .sort((a, b) => b.netProfit - a.netProfit);
}

// ---------- Pot log ----------

export async function listPotLog(clubId: string, requesterId: string, isSuperAdmin: boolean) {
  const club = await clubsService.getClubOrThrow(clubId);
  clubsService.assertClubAdmin(club, requesterId, isSuperAdmin);
  return prisma.clubPotLog.findMany({ where: { clubId }, orderBy: { createdAt: 'desc' } });
}

// ---------- Pending changes (edit/delete a locked day) ----------

export interface ChangeFieldDiff {
  field: string;
  oldValue: string;
  newValue: string;
}

interface StagedChange {
  sourceType: 'historical' | 'cashout';
  date?: string;
  notes?: string;
  playerStats?: HistoricalPlayerStat[];
  playerSummaries?: PlayerSessionSummary[];
  totalBuyIns?: number;
  totalCashOuts?: number;
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

function settlementSettingsFor(club: {
  sessionRakeAmount: number; winnersCutPercent: number; rakeEnabled: boolean; rakeMethod: string;
  rakeValue: number; potEnabled: boolean; mismatchStrategy: string; rakeOrder: string;
  winnerDefinition: string; winnerTopN: number; roundingRule: string;
}): SettlementSettings {
  return {
    sessionRakeAmount: club.sessionRakeAmount,
    winnersCutPercent: club.winnersCutPercent,
    rakeEnabled: club.rakeEnabled,
    rakeMethod: club.rakeMethod as SettlementSettings['rakeMethod'],
    rakeValue: club.rakeValue,
    potEnabled: club.potEnabled,
    mismatchStrategy: club.mismatchStrategy as SettlementSettings['mismatchStrategy'],
    rakeOrder: club.rakeOrder as SettlementSettings['rakeOrder'],
    winnerDefinition: club.winnerDefinition as SettlementSettings['winnerDefinition'],
    winnerTopN: club.winnerTopN,
    roundingRule: club.roundingRule as SettlementSettings['roundingRule'],
  };
}

/**
 * Applies an approved edit or deletion, keeping the club pot honest.
 *
 * Two things this deliberately does that the previous version did not:
 *
 *  - **It re-settles an edit through the engine.** The client sends raw
 *    buy-in/cash-out pairs; the profit figures it puts alongside them are plain
 *    `cashOut - buyIn` with no rake, no winners' cut and no mismatch handling.
 *    Storing those verbatim silently erased the club's rules from any night
 *    anyone edited. The engine output is authoritative here, exactly as it is
 *    when a night is first recorded or settled.
 *  - **It moves the pot.** Deleting reverses the session's contribution,
 *    editing adjusts it to the recomputed figure, and both leave a row in the
 *    pot ledger explaining the movement.
 *
 * Runs in one transaction so a record can never end up edited with the pot
 * un-adjusted, or vice versa.
 */
/**
 * The rules a recorded night should be re-settled by.
 *
 * A settled session carries the rules it was played under on its engineState,
 * and those are the only honest input to recomputing it. The club's current
 * settings describe a different night.
 *
 * Two cases genuinely have nothing else to use and fall back to the club:
 * back-dated records, which were never a session at all, and sessions settled
 * before snapshots existed. That fallback is safe in a way the live one was
 * not — a club's settlement rules are frozen at creation
 * (IMMUTABLE_CLUB_RULES), so what the club says now is what it said then.
 * Should that freeze ever be relaxed, this becomes the same hole again and
 * wants the same refusal settleSession gives.
 */
async function settlementRulesForRecord(
  tx: Prisma.TransactionClient,
  recordId: string,
  sourceType: StagedChange['sourceType'],
  club: Parameters<typeof settlementSettingsFor>[0]
): Promise<SettlementSettings> {
  if (sourceType !== 'cashout') return settlementSettingsFor(club);

  const settlement = await tx.cashOutSettlement.findUnique({
    where: { id: recordId },
    select: { sessionId: true },
  });
  if (!settlement) return settlementSettingsFor(club);

  const session = await tx.pokerSession.findUnique({
    where: { id: settlement.sessionId },
    select: { engineState: true },
  });
  const snapshot = (session?.engineState as { settlementRules?: SettlementSettings } | null)
    ?.settlementRules;

  return snapshot ?? settlementSettingsFor(club);
}

async function applySessionChange(
  clubId: string,
  recordId: string,
  requestType: 'edit_session' | 'delete_session',
  staged: StagedChange
) {
  await prisma.$transaction(async (tx) => {
    const potKey = await potKeyFor(tx, recordId, staged.sourceType);
    const ledger = await potLedgerFor(tx, clubId, potKey);

    if (requestType === 'delete_session') {
      if (staged.sourceType === 'historical') {
        await tx.historicalSessionRecord.update({ where: { id: recordId }, data: { isDeleted: true } });
      } else {
        await tx.cashOutSettlement.update({ where: { id: recordId }, data: { isDeleted: true } });
      }
      await movePot(tx, clubId, potKey, -ledger.net, POT_REVERSAL_SOURCE,
        'Reversed: session deleted');
      return;
    }

    const entries = (staged.sourceType === 'historical' ? staged.playerStats : staged.playerSummaries) ?? [];
    if (entries.length === 0) {
      // Nothing to re-settle — a metadata-only edit (date or notes). Leave the
      // figures and the pot exactly as they are.
      if (staged.sourceType === 'historical') {
        await tx.historicalSessionRecord.update({
          where: { id: recordId },
          data: {
            ...(staged.date !== undefined ? { sessionDate: staged.date } : {}),
            ...(staged.notes !== undefined ? { notes: staged.notes } : {}),
          },
        });
      } else {
        await tx.cashOutSettlement.update({
          where: { id: recordId },
          data: { ...(staged.notes !== undefined ? { notes: staged.notes } : {}) },
        });
      }
      return;
    }

    const club = await tx.club.findUniqueOrThrow({ where: { id: clubId } });

    /*
     * Re-settle by the rules the night was PLAYED under, not the club's.
     *
     * This re-runs the engine, so whatever it is handed decides the money all
     * over again. Reading the club here was the other half of the hole the
     * session snapshot closed in settleSession: a night settled at 1,000 a seat
     * would quietly come back as free the moment somebody corrected a typo in
     * a cash-out, because the club charges nothing.
     *
     * A back-dated record has no session and never did — it was typed in from
     * a notebook — so the club is the only source it can have, and that is
     * correct for it rather than a fallback.
     */
    const rules = await settlementRulesForRecord(tx, recordId, staged.sourceType, club);

    /*
     * NOTE ON manualWinner, which this path still does not carry.
     *
     * The edit form sends buy-ins and cash-outs and nothing about who won, so a
     * MANUAL-rules night re-settled here comes back with no winners at all.
     * That is a real defect and it predates this change (recorded in
     * SETTLEMENT-REPLAYABILITY-AUDIT.md §2).
     *
     * It is NOT fixed here, deliberately: fixing it would change what an edit
     * computes, and step 3 changes no settlement behaviour. Step 5 replaces
     * this path with one that carries every engine input and refuses rather
     * than defaulting — see SETTLEMENT-HISTORY-DESIGN.md §5.
     *
     * What this change does add is the evidence: the canonical record below
     * states that manualWinner was false for everybody, so a night mis-settled
     * this way is afterwards identifiable instead of indistinguishable.
     */
    /*
     * WHERE THE BUY-IN COMES FROM depends on where it came from the first time.
     *
     * settleSession has derived every buy-in from approved banks since #90, and
     * says so on the record (`canonicalInputs.buyInSource`). This path did not
     * follow, so the guarantee held at settle time and was lost on the first
     * edit: the form's `totalBuyIn` was taken at face value, exactly the
     * workaround #90 closed.
     *
     * It follows now — for records that CARRY the stamp. A record without it
     * was settled from the sheet, and its buy-ins may hold corrections that no
     * bank ever recorded: one production night carries two such figures,
     * deliberately typed under the old workflow, that the approved banks cannot
     * reproduce. Deriving those would silently rewrite a correct settlement. So
     * a legacy record keeps the behaviour it was created under, and only a
     * stamped one is held to the invariant.
     *
     * The stamp is READ here and passed through; it is never written here. An
     * edit that added it would promote a legacy night into the derived
     * population on its second edit, which is the same silent rewrite one step
     * removed. Only settleSession stamps.
     */
    const authoritative =
      staged.sourceType === 'cashout' &&
      hasAuthoritativeBuyIns(
        (await tx.cashOutSettlement.findUniqueOrThrow({
          where: { id: recordId }, select: { canonicalInputs: true },
        })).canonicalInputs
      );

    let derivedBuyIn: Map<string, number> | null = null;
    if (authoritative) {
      const { sessionId } = await tx.cashOutSettlement.findUniqueOrThrow({
        where: { id: recordId }, select: { sessionId: true },
      });
      // `status: 'approved'` by equality — voided rows drop out exactly as they
      // do in settleSession and every live calculation. Read on `tx`, inside
      // the same transaction that will write the figures it produces.
      const approvedByPlayer = await tx.buyInRequest.groupBy({
        by: ['userId'],
        where: { sessionId, status: 'approved' },
        _sum: { amount: true },
      });
      if (approvedByPlayer.length === 0) {
        // A stamped record with nothing to derive from is a contradiction, not
        // a night where nobody bought in. Refuse rather than settle at zero or
        // fall back to the form — either would put a number on the record that
        // no request can name.
        throw new HttpError(409,
          'This night was settled from approved banks, but none exist to derive its buy-ins from. It cannot be re-settled.');
      }
      derivedBuyIn = new Map(approvedByPlayer.map((r) => [r.userId, r._sum.amount ?? 0]));
    }

    const enginePlayers = entries.map((e: any, i: number) => ({
      userId: e.userId || `unlinked:${i}:${e.userName ?? e.userDisplayName}`,
      userDisplayName: e.userName ?? e.userDisplayName,
      // Derived when the record says its buy-ins are derived; the form's figure
      // otherwise. A stamped player with no approved bank put in nothing, which
      // is what settleSession would have said about them too.
      buyIn: derivedBuyIn ? (derivedBuyIn.get(e.userId) ?? 0) : Number(e.totalBuyIn || 0),
      cashOut: Number(e.cashOut || 0),
    }));

    const result = computeSettlement(enginePlayers, rules, { currentPotBalance: club.clubPotBalance });

    const canonicalInputs = buildCanonicalInputs({
      rules,
      players: enginePlayers,
      currentPotBalance: club.clubPotBalance,
      capturedFrom: 'applySessionChange',
      // Carried forward, never introduced: a stamped night stays stamped, an
      // unstamped one stays unstamped. Its buy-ins above were derived iff it
      // was, so the stamp remains true of what this record now holds.
      ...(authoritative ? { buyInSource: BUY_IN_SOURCE_APPROVED_BANKS } : {}),
    });
    const canonicalOutputs = canonicalOutputsFrom(result, canonicalInputs);

    if (result.requiresManualResolution) {
      throw new HttpError(409, 'This club requires manual mismatch resolution — reconcile the difference before editing this session.');
    }

    if (staged.sourceType === 'historical') {
      const playerStats: HistoricalPlayerStat[] = result.players.map((p, i) => ({
        userName: p.userDisplayName,
        userId: (entries[i] as any)?.userId,
        totalBuyIn: p.totalBuyIn,
        cashOut: p.cashOut,
        profit: p.netResult,
        timestamp: staged.date ?? new Date().toISOString(),
      }));
      await tx.historicalSessionRecord.update({
        where: { id: recordId },
        data: {
          ...(staged.date !== undefined ? { sessionDate: staged.date } : {}),
          ...(staged.notes !== undefined ? { notes: staged.notes } : {}),
          playerStats: playerStats as any,
          engineVersion: canonicalInputs.engineVersion,
          canonicalInputs: canonicalInputs as unknown as Prisma.InputJsonValue,
          canonicalOutputs: canonicalOutputs as unknown as Prisma.InputJsonValue,
        },
      });
    } else {
      const playerSummaries: PlayerSessionSummary[] = result.players.map((p, i) => ({
        userId: (entries[i] as any)?.userId ?? p.userId,
        userDisplayName: p.userDisplayName,
        totalBuyIn: p.totalBuyIn,
        cashOut: p.cashOut,
        grossProfit: p.grossProfit,
        winnersCutDeduction: p.rakeDeduction,
        excessDeduction: p.mismatchDeduction,
        netResult: p.netResult,
      }));
      await tx.cashOutSettlement.update({
        where: { id: recordId },
        data: {
          ...(staged.notes !== undefined ? { notes: staged.notes } : {}),
          totalBuyIns: result.totalBuyIns,
          totalCashOuts: result.totalCashOuts,
          // The winners' cut, which is what the column is called. It held the
          // FULL rake here and 0 in settleSession, so the same column meant two
          // different things depending on which path wrote last. Both write the
          // same thing now. Rounded for the Int column; canonicalOutputs keeps
          // the unrounded figure.
          totalWinnersCut: Math.round(result.totalWinnersCut),
          rakeCollected: result.totalRakeCollected,
          potAdjustment: result.potContribution,
          playerSummaries: playerSummaries as any,
          engineVersion: canonicalInputs.engineVersion,
          canonicalInputs: canonicalInputs as unknown as Prisma.InputJsonValue,
          canonicalOutputs: canonicalOutputs as unknown as Prisma.InputJsonValue,
        },
      });
    }

    await movePot(tx, clubId, potKey, result.potContribution - ledger.net, 'manual_adjustment',
      `Re-settled after edit: pot contribution now ${result.potContribution}`);
  });
}

export async function requestSessionChange(
  clubId: string,
  requesterId: string,
  requesterName: string,
  isSuperAdmin: boolean,
  input: RequestSessionChangeInput
) {
  const club = await clubsService.getClubOrThrow(clubId);
  clubsService.assertClubAdmin(club, requesterId, isSuperAdmin);
  const isOwner = clubsService.isClubOwner(club, requesterId, isSuperAdmin);
  const requiresApproval = !isOwner && !isSuperAdmin && hasOtherAdmins(club, requesterId);

  const staged: StagedChange =
    input.requestType === 'edit_session'
      ? {
          sourceType: input.sourceType,
          date: input.updatedDate,
          notes: input.updatedNotes,
          playerStats: input.updatedPlayerStats,
          playerSummaries: input.updatedPlayerSummaries,
          totalBuyIns: input.updatedTotalBuyIns,
          totalCashOuts: input.updatedTotalCashOuts,
        }
      : { sourceType: input.sourceType };

  if (requiresApproval) {
    const request = await prisma.pendingChangeRequest.create({
      data: {
        clubId,
        sessionId: input.sessionId,
        sessionTitle: input.sessionTitle,
        requestType: input.requestType,
        requestedBy: requesterId,
        requestedByName: requesterName,
        changes: { diffs: input.changes, staged } as any,
        reason: input.reason,
      },
    });
    emitToClub(clubId, 'club:pending-request', { requestId: request.id });
    return { status: 'pending' as const, requestId: request.id };
  }

  await applySessionChange(clubId, input.sessionId, input.requestType, staged);
  await prisma.auditLog.create({
    data: {
      clubId,
      sessionId: input.sessionId,
      sessionTitle: input.sessionTitle,
      action: input.requestType,
      changedBy: requesterId,
      changedByName: requesterName,
      details: `Direct ${input.requestType === 'delete_session' ? 'deletion' : 'edit'} by ${isOwner ? 'Club Owner' : 'Club Admin'}`,
      changes: input.changes as any,
    },
  });
  emitToClub(clubId, 'club:history-updated', { recordId: input.sessionId });
  return { status: 'applied' as const };
}

export async function listPendingChanges(clubId: string, requesterId: string, isSuperAdmin: boolean) {
  const club = await clubsService.getClubOrThrow(clubId);
  clubsService.assertClubAdmin(club, requesterId, isSuperAdmin);
  return prisma.pendingChangeRequest.findMany({ where: { clubId, status: 'pending' }, orderBy: { requestedAt: 'desc' } });
}

export async function decidePendingChange(
  clubId: string,
  requesterId: string,
  requesterName: string,
  isSuperAdmin: boolean,
  requestId: string,
  approve: boolean
) {
  const club = await clubsService.getClubOrThrow(clubId);
  clubsService.assertClubAdmin(club, requesterId, isSuperAdmin);

  const request = await prisma.pendingChangeRequest.findUnique({ where: { id: requestId } });
  if (!request || request.clubId !== clubId) throw new HttpError(404, 'Change request not found');
  if (request.status !== 'pending') throw new HttpError(409, 'This request has already been decided');

  const isOwner = clubsService.isClubOwner(club, requesterId, isSuperAdmin);
  if (request.requestedBy === requesterId && !isOwner && !isSuperAdmin && hasOtherAdmins(club, requesterId)) {
    throw new HttpError(403, 'Another Club Admin must approve your own change request');
  }

  const payload = request.changes as unknown as { diffs: ChangeFieldDiff[]; staged: StagedChange };

  if (approve) {
    await applySessionChange(clubId, request.sessionId, request.requestType as 'edit_session' | 'delete_session', payload.staged);
  }

  await prisma.pendingChangeRequest.update({
    where: { id: requestId },
    data: { status: approve ? 'approved' : 'rejected', approvedBy: requesterId, approvedByName: requesterName, actionDate: new Date() },
  });

  await prisma.auditLog.create({
    data: {
      clubId,
      sessionId: request.sessionId,
      sessionTitle: request.sessionTitle,
      action: approve ? request.requestType : 'reject_request',
      changedBy: request.requestedBy,
      changedByName: request.requestedByName,
      approvedBy: requesterId,
      approvedByName: requesterName,
      details: `${approve ? 'Approved' : 'Rejected'} ${request.requestType === 'delete_session' ? 'deletion' : 'edit'} for ${request.sessionTitle}`,
      changes: payload.diffs as any,
    },
  });

  emitToClub(clubId, 'club:pending-request-decided', { requestId, approve });
  return { status: approve ? ('approved' as const) : ('rejected' as const) };
}

// ---------- Audit trail (owner / superadmin only) ----------

export async function listDeletedSessions(clubId: string, requesterId: string, isSuperAdmin: boolean) {
  const club = await clubsService.getClubOrThrow(clubId);
  clubsService.assertClubOwner(club, requesterId, isSuperAdmin);
  const [historical, cashouts] = await Promise.all([
    prisma.historicalSessionRecord.findMany({ where: { clubId, isDeleted: true } }),
    prisma.cashOutSettlement.findMany({ where: { clubId, isDeleted: true } }),
  ]);
  return [
    ...historical.map((h) => ({ id: h.id, sourceType: 'historical' as const, title: h.sessionTitle })),
    ...cashouts.map((c) => ({ id: c.id, sourceType: 'cashout' as const, title: c.sessionType || 'Session' })),
  ];
}

export async function restoreSession(
  clubId: string,
  requesterId: string,
  requesterName: string,
  isSuperAdmin: boolean,
  recordId: string,
  sourceType: 'historical' | 'cashout',
  sessionTitle: string
) {
  const club = await clubsService.getClubOrThrow(clubId);
  clubsService.assertClubOwner(club, requesterId, isSuperAdmin);

  await prisma.$transaction(async (tx) => {
    if (sourceType === 'historical') {
      await tx.historicalSessionRecord.update({ where: { id: recordId }, data: { isDeleted: false } });
    } else {
      await tx.cashOutSettlement.update({ where: { id: recordId }, data: { isDeleted: false } });
    }
    // Put back exactly what deleting took out — `intended` still carries the
    // original contribution plus any adjustment an edit made before deletion.
    const potKey = await potKeyFor(tx, recordId, sourceType);
    const ledger = await potLedgerFor(tx, clubId, potKey);
    await movePot(tx, clubId, potKey, ledger.intended - ledger.net, POT_REVERSAL_SOURCE,
      'Re-applied: session restored');
  });

  await prisma.auditLog.create({
    data: {
      clubId,
      sessionId: recordId,
      sessionTitle,
      action: 'restore_session',
      changedBy: requesterId,
      changedByName: requesterName,
      details: `Restored soft-deleted session ${sessionTitle}`,
    },
  });

  emitToClub(clubId, 'club:history-updated', { recordId });
}

export async function listAuditLog(clubId: string, requesterId: string, isSuperAdmin: boolean) {
  const club = await clubsService.getClubOrThrow(clubId);
  clubsService.assertClubOwner(club, requesterId, isSuperAdmin);
  return prisma.auditLog.findMany({ where: { clubId }, orderBy: { createdAt: 'desc' }, take: 200 });
}
