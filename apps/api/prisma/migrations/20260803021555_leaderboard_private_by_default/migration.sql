-- AlterTable
ALTER TABLE "Club" ALTER COLUMN "leaderboardVisibleToPlayers" SET DEFAULT false;

-- Backfill existing clubs to match the new default.
--
-- The column previously defaulted to true, so every club created before this
-- migration has it on without any owner having chosen it — a plain member
-- could read every other member's lifetime net profit, buy-ins and biggest
-- win/loss. Changing only the default would leave all of those clubs exposed,
-- which is the opposite of the intent, so existing rows are flipped too.
--
-- This is reversible per club: an owner turns the leaderboard back on from
-- Club Settings whenever they actually want it shared.
UPDATE "Club" SET "leaderboardVisibleToPlayers" = false;
