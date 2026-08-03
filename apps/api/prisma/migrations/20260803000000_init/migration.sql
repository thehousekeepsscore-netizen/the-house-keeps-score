-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "OAuthProvider" AS ENUM ('GOOGLE');

-- CreateEnum
CREATE TYPE "JoinRequestStatus" AS ENUM ('pending', 'accepted', 'rejected');

-- CreateEnum
CREATE TYPE "SessionType" AS ENUM ('OFFLINE', 'LAZY_DEALER', 'VIRTUAL_TABLE');

-- CreateEnum
CREATE TYPE "SessionStatus" AS ENUM ('active', 'settled');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT,
    "displayName" TEXT NOT NULL,
    "firstName" TEXT,
    "lastName" TEXT,
    "username" TEXT,
    "avatarUrl" TEXT,
    "phoneNumber" TEXT,
    "themePreference" TEXT NOT NULL DEFAULT 'emerald-gold',
    "isSuperAdmin" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OAuthAccount" (
    "id" TEXT NOT NULL,
    "provider" "OAuthProvider" NOT NULL,
    "providerUserId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OAuthAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "replacedBy" TEXT,
    "userAgent" TEXT,
    "ip" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Club" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "ownerId" TEXT NOT NULL,
    "maxCapacity" INTEGER NOT NULL DEFAULT 50,
    "buyInMode" TEXT NOT NULL DEFAULT 'MATCH_HIGHEST',
    "minBuyIn" INTEGER NOT NULL DEFAULT 1000,
    "maxBuyIn" INTEGER NOT NULL DEFAULT 5000,
    "devaluationFactor" INTEGER NOT NULL DEFAULT 1,
    "enableDevaluation" BOOLEAN NOT NULL DEFAULT false,
    "clubPotBalance" INTEGER NOT NULL DEFAULT 0,
    "leaderboardVisibleToPlayers" BOOLEAN NOT NULL DEFAULT true,
    "sessionRakeAmount" INTEGER NOT NULL DEFAULT 0,
    "winnersCutPercent" INTEGER NOT NULL DEFAULT 0,
    "rakeEnabled" BOOLEAN NOT NULL DEFAULT false,
    "rakeMethod" TEXT NOT NULL DEFAULT 'PERCENT_PROFIT',
    "rakeValue" INTEGER NOT NULL DEFAULT 5,
    "potEnabled" BOOLEAN NOT NULL DEFAULT false,
    "mismatchStrategy" TEXT NOT NULL DEFAULT 'PROPORTIONAL_WINNERS',
    "rakeOrder" TEXT NOT NULL DEFAULT 'MISMATCH_FIRST',
    "winnerDefinition" TEXT NOT NULL DEFAULT 'PROFIT_POSITIVE',
    "winnerTopN" INTEGER NOT NULL DEFAULT 1,
    "roundingRule" TEXT NOT NULL DEFAULT 'NONE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Club_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClubAdmin" (
    "clubId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "ClubAdmin_pkey" PRIMARY KEY ("clubId","userId")
);

-- CreateTable
CREATE TABLE "ClubMember" (
    "clubId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClubMember_pkey" PRIMARY KEY ("clubId","userId")
);

-- CreateTable
CREATE TABLE "ClubJoinRequest" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "JoinRequestStatus" NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClubJoinRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PokerSession" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "sessionName" TEXT NOT NULL,
    "sessionType" "SessionType" NOT NULL,
    "status" "SessionStatus" NOT NULL DEFAULT 'active',
    "startedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "engineState" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "PokerSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BuyInRequest" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "requestedBy" TEXT NOT NULL,
    "approvedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BuyInRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashOutSettlement" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "sessionType" TEXT,
    "dayNumber" INTEGER,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "settledBy" TEXT NOT NULL,
    "totalBuyIns" INTEGER NOT NULL,
    "totalCashOuts" INTEGER NOT NULL,
    "totalWinnersCut" INTEGER NOT NULL,
    "rakeCollected" INTEGER NOT NULL,
    "potAdjustment" INTEGER NOT NULL,
    "playerSummaries" JSONB NOT NULL,
    "settledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,

    CONSTRAINT "CashOutSettlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClubPotLog" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "sessionId" TEXT,
    "amount" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClubPotLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HistoricalSessionRecord" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "sessionDate" TEXT NOT NULL,
    "sessionTitle" TEXT NOT NULL,
    "sessionType" TEXT,
    "dayNumber" INTEGER,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "playerStats" JSONB NOT NULL,
    "notes" TEXT,
    "importedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HistoricalSessionRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PendingChangeRequest" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "sessionTitle" TEXT NOT NULL,
    "requestType" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "requestedByName" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "approvedBy" TEXT,
    "approvedByName" TEXT,
    "actionDate" TIMESTAMP(3),
    "changes" JSONB,
    "reason" TEXT,

    CONSTRAINT "PendingChangeRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "sessionId" TEXT,
    "sessionTitle" TEXT,
    "action" TEXT NOT NULL,
    "changedBy" TEXT NOT NULL,
    "changedByName" TEXT NOT NULL,
    "approvedBy" TEXT,
    "approvedByName" TEXT,
    "details" TEXT NOT NULL,
    "changes" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HandHistory" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "handNumber" INTEGER NOT NULL,
    "dealerSeat" INTEGER NOT NULL,
    "smallBlind" INTEGER NOT NULL,
    "bigBlind" INTEGER NOT NULL,
    "communityCards" JSONB NOT NULL,
    "potTotal" INTEGER NOT NULL,
    "winnerNames" TEXT[],
    "winningHandDesc" TEXT NOT NULL,
    "timestamp" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HandHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE INDEX "OAuthAccount_userId_idx" ON "OAuthAccount"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "OAuthAccount_provider_providerUserId_key" ON "OAuthAccount"("provider", "providerUserId");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "RefreshToken_userId_idx" ON "RefreshToken"("userId");

-- CreateIndex
CREATE INDEX "RefreshToken_familyId_idx" ON "RefreshToken"("familyId");

-- CreateIndex
CREATE UNIQUE INDEX "Club_code_key" ON "Club"("code");

-- CreateIndex
CREATE INDEX "ClubJoinRequest_clubId_idx" ON "ClubJoinRequest"("clubId");

-- CreateIndex
CREATE INDEX "ClubJoinRequest_userId_idx" ON "ClubJoinRequest"("userId");

-- CreateIndex
CREATE INDEX "PokerSession_clubId_idx" ON "PokerSession"("clubId");

-- CreateIndex
CREATE INDEX "PokerSession_status_idx" ON "PokerSession"("status");

-- CreateIndex
CREATE INDEX "BuyInRequest_sessionId_idx" ON "BuyInRequest"("sessionId");

-- CreateIndex
CREATE INDEX "BuyInRequest_clubId_idx" ON "BuyInRequest"("clubId");

-- CreateIndex
CREATE INDEX "CashOutSettlement_clubId_idx" ON "CashOutSettlement"("clubId");

-- CreateIndex
CREATE INDEX "ClubPotLog_clubId_idx" ON "ClubPotLog"("clubId");

-- CreateIndex
CREATE INDEX "HistoricalSessionRecord_clubId_idx" ON "HistoricalSessionRecord"("clubId");

-- CreateIndex
CREATE INDEX "PendingChangeRequest_clubId_idx" ON "PendingChangeRequest"("clubId");

-- CreateIndex
CREATE INDEX "AuditLog_clubId_idx" ON "AuditLog"("clubId");

-- CreateIndex
CREATE INDEX "HandHistory_sessionId_idx" ON "HandHistory"("sessionId");

-- AddForeignKey
ALTER TABLE "OAuthAccount" ADD CONSTRAINT "OAuthAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Club" ADD CONSTRAINT "Club_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubAdmin" ADD CONSTRAINT "ClubAdmin_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubAdmin" ADD CONSTRAINT "ClubAdmin_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubMember" ADD CONSTRAINT "ClubMember_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubMember" ADD CONSTRAINT "ClubMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubJoinRequest" ADD CONSTRAINT "ClubJoinRequest_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubJoinRequest" ADD CONSTRAINT "ClubJoinRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PokerSession" ADD CONSTRAINT "PokerSession_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PokerSession" ADD CONSTRAINT "PokerSession_startedById_fkey" FOREIGN KEY ("startedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyInRequest" ADD CONSTRAINT "BuyInRequest_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "PokerSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyInRequest" ADD CONSTRAINT "BuyInRequest_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyInRequest" ADD CONSTRAINT "BuyInRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashOutSettlement" ADD CONSTRAINT "CashOutSettlement_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubPotLog" ADD CONSTRAINT "ClubPotLog_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HistoricalSessionRecord" ADD CONSTRAINT "HistoricalSessionRecord_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PendingChangeRequest" ADD CONSTRAINT "PendingChangeRequest_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HandHistory" ADD CONSTRAINT "HandHistory_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "PokerSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

