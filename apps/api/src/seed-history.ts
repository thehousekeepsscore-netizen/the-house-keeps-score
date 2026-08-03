// One-off import of the two already-played "The House Keeps Score" sessions
// (25th & 26th July) from the Splitwise-style cost-split PDF. The per-player
// buy-in/cash-out numbers here are the same ones already reverse-engineered
// from that PDF in apps/web/src/lib/pdfHistorySeed.ts (Firestore version) —
// this just imports them into the new Postgres HistoricalSessionRecord table.
//
// Run with: npx tsx src/seed-history.ts [clubName]

import { prisma } from './lib/prisma.js';
import { assertSeedingAllowed } from './lib/seedGuard.js';

const CLUB_NAME = process.argv[2] || 'Texas Holdem Club';

interface PlayerStatInput {
  userName: string;
  totalBuyIn: number;
  cashOut: number;
}

// Every player's dummy timestamp is the session's own date/time — the PDF
// only has a lump-sum reconciliation per session, not real per-buy-in times.
function withTimestamp(stats: PlayerStatInput[], sessionTimestamp: string) {
  return stats.map(s => ({
    userName: s.userName,
    totalBuyIn: s.totalBuyIn,
    cashOut: s.cashOut,
    profit: s.cashOut - s.totalBuyIn,
    timestamp: sessionTimestamp,
  }));
}

const DAY1_TIMESTAMP = '2026-07-25T20:00:00.000Z';
const DAY1_STATS: PlayerStatInput[] = [
  { userName: 'Aniket', totalBuyIn: 0, cashOut: 89300 },
  { userName: 'Poras Shah', totalBuyIn: 0, cashOut: 96900 },
  { userName: 'Parshv Lalwani', totalBuyIn: 0, cashOut: 69350 },
  { userName: 'Bafna', totalBuyIn: 0, cashOut: 950 },
  { userName: 'Rohinish', totalBuyIn: 8000, cashOut: 0 },
  { userName: 'Sangini', totalBuyIn: 10000, cashOut: 0 },
  { userName: 'Jainy', totalBuyIn: 20000, cashOut: 0 },
  { userName: 'Rushi', totalBuyIn: 20000, cashOut: 0 },
  { userName: 'Bhavya Nandu', totalBuyIn: 23000, cashOut: 0 },
  { userName: 'Yash', totalBuyIn: 27500, cashOut: 0 },
  { userName: 'Bhanu', totalBuyIn: 50000, cashOut: 0 },
  { userName: 'Addu', totalBuyIn: 55000, cashOut: 0 },
  { userName: 'Raj', totalBuyIn: 90000, cashOut: 38452.42 },
];

const DAY2_TIMESTAMP = '2026-07-26T22:00:00.000Z';
const DAY2_STATS: PlayerStatInput[] = [
  { userName: 'Bafna', totalBuyIn: 26135.75, cashOut: 404700 },
  { userName: 'Rohinish', totalBuyIn: 23061.70, cashOut: 218500 },
  { userName: 'Jainy', totalBuyIn: 27111.10, cashOut: 85500 },
  { userName: 'Aniket', totalBuyIn: 3703.70, cashOut: 28500 },
  { userName: 'Sangini', totalBuyIn: 13192.59, cashOut: 19950 },
  { userName: 'Parshv Lalwani', totalBuyIn: 2397.58, cashOut: 6650 },
  { userName: 'Raj', totalBuyIn: 1000, cashOut: 1000 },
  { userName: 'Rushi', totalBuyIn: 1000, cashOut: 0 },
  { userName: 'Bhavya Nandu', totalBuyIn: 1000, cashOut: 0 },
  { userName: 'Addu', totalBuyIn: 12000, cashOut: 0 },
  { userName: 'Rajen', totalBuyIn: 21000, cashOut: 0 },
  { userName: 'Yogi', totalBuyIn: 37000, cashOut: 0 },
  { userName: 'Bhanu', totalBuyIn: 52000, cashOut: 0 },
  { userName: 'Yash', totalBuyIn: 152000, cashOut: 0 },
  { userName: 'Poras Shah', totalBuyIn: 182000, cashOut: 0 },
  { userName: 'Hemang', totalBuyIn: 320000, cashOut: 0 },
];

async function main() {
  // Same gate as seed.ts. This script writes HistoricalSessionRecord rows —
  // money that shows up in history, leaderboards and every profit total — so a
  // stray run against production invents nights that were never played.
  assertSeedingAllowed('two historical session records (real money figures) for a club');

  const club = await prisma.club.findFirst({ where: { name: CLUB_NAME } });
  if (!club) {
    throw new Error(`No club named "${CLUB_NAME}" found — pass the right club name as an argument.`);
  }

  const existing = await prisma.historicalSessionRecord.findFirst({
    where: { clubId: club.id, sessionDate: '2026-07-25' },
  });
  if (existing) {
    console.log(`Historical records already imported for club "${club.name}" — skipping.`);
    return;
  }

  await prisma.historicalSessionRecord.create({
    data: {
      clubId: club.id,
      sessionDate: '2026-07-25',
      sessionTitle: 'Day 1',
      sessionType: 'Offline Session',
      dayNumber: 1,
      playerStats: withTimestamp(DAY1_STATS, DAY1_TIMESTAMP) as any,
      notes: 'Imported from 25th July PDF Expenses Ledger',
      importedBy: 'system',
      createdAt: new Date(DAY1_TIMESTAMP),
    },
  });

  await prisma.historicalSessionRecord.create({
    data: {
      clubId: club.id,
      sessionDate: '2026-07-26',
      sessionTitle: 'Day 2',
      sessionType: 'Offline Session',
      dayNumber: 2,
      playerStats: withTimestamp(DAY2_STATS, DAY2_TIMESTAMP) as any,
      notes: 'Imported from 26th July PDF Expenses Ledger',
      importedBy: 'system',
      createdAt: new Date(DAY2_TIMESTAMP),
    },
  });

  console.log(`✅ Imported Day 1 & Day 2 historical records for club "${club.name}" (${club.id}).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
