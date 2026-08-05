import { useNavigate, useParams } from 'react-router-dom';
import { useResource, useResourceCache } from '../lib/resource-cache';
import { useAction } from '../lib/use-action';
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { AppUser as User } from '../lib/auth-types';
import { getSocket } from '../lib/socket';
import * as clubsApi from '../lib/clubs-api';
import { ClubRosterEntry } from '../lib/clubs-api';
import * as offlineSessionsApi from '../lib/offlineSessions-api';
import type { ApiOfflineSession, ApiBuyInRequest } from '../lib/offlineSessions-api';

/**
 * The live table, as one cache entry. Session and buy-ins are fetched and
 * patched together because a buy-in approval changes both, and two entries
 * would let them disagree on screen.
 */
type SessionResource = { session: PokerSession | null; buyIns: BuyInRequest[] };
import * as clubRecordsApi from '../lib/clubRecords-api';
import { NormalizedSession, LeaderboardRow } from '../lib/clubRecords-api';
import { computeSettlement, RakeMethod, MismatchStrategy, RakeOrder, WinnerDefinition, RoundingRule, SettlementResult, SettlementSettings } from '../lib/settlementEngine';
import { SettlementPreview, SettlementConfirm } from './SettlementPreview';
import {
  Club,
  PokerSession,
  BuyInRequest,
  CashOutSettlement,
  PlayerSessionSummary,
  ClubPotLog,
  HistoricalSessionRecord,
  HistoricalPlayerStat,
  PendingChangeRequest,
  AuditLog,
  ToastMessage
} from '../types';
import {
  Crown, 
  Users, 
  ShieldCheck, 
  DollarSign, 
  History, 
  CalendarPlus,
  Trash2 as PastRowTrash,
  Trophy, 
  Sliders, 
  Plus, 
  Check, 
  X, 
  Play, 
  ArrowLeft, 
  AlertCircle, 
  CheckCircle2, 
  Clock, 
  Coins, 
  FileText, 
  Download, 
  Sparkles, 
  Settings, 
  TrendingUp, 
  TrendingDown, 
  Scale, 
  Info, 
  ChevronRight,
  ShieldAlert,
  Layers,
  Gamepad2,
  Lock,
  UserCheck,
  Link as LinkIcon,
  Pencil,
  Trash2,
  RotateCcw,
  ChevronDown,
  ChevronUp,
  FileCheck,
  ListChecks,
  FileEdit,
  UserCircle,
  Spade,
  Hand,
  LogOut
} from 'lucide-react';
import { AccountSettingsModal } from './AccountSettingsModal';
import { PokerTableRing } from './PokerTableRing';
import { ToastContainer } from './ToastContainer';
import { InfoHint } from './InfoHint';

const RAKE_METHOD_LABELS: Record<RakeMethod, (value: number) => string> = {
  PERCENT_PROFIT: (v) => `${v}% of profit`,
  PERCENT_CASHOUT: (v) => `${v}% of cash-out`,
  FIXED_PER_WINNER: (v) => `${v} flat / winner`,
  FIXED_PER_SESSION: (v) => `${v} flat / session`,
  CUSTOM: () => 'Custom',
};

const MISMATCH_STRATEGY_LABELS: Record<MismatchStrategy, string> = {
  PROPORTIONAL_WINNERS: 'Proportional from winners',
  EQUAL_WINNERS: 'Equal split among winners',
  EQUAL_ALL: 'Equal split among all players',
  SHORTFALL_TO_POT: 'Shortfall to Pot',
  EXCESS_FROM_POT: 'Excess from Pot',
  MANUAL: 'Manual adjustment required',
  CUSTOM: 'Custom',
};

interface ClubDetailViewProps {
  club: Club;
  currentUser: User;
  playerAvatarUrl: string;
  onBackToDashboard: () => void;
}

/**
 * URL slugs for the club's tabs. Hyphenated in the address bar, camelCase in
 * code — the mapping is explicit so neither side has to guess.
 */
// Mirrors the Prisma default (schema.prisma: maxBuyIn Int @default(5000)) and
// the API's `input.maxBuyIn ?? 5000`. Only used when a club predates the field
// being set; every club created through the API carries an explicit value.
// Stable empty fallbacks. A fresh [] on every render would give every derived
// useMemo and effect a new dependency identity, so a resource that has not
// loaded yet would churn the component instead of sitting still.
const EMPTY_ROSTER: Record<string, ClubRosterEntry> = {};
const EMPTY_HISTORY: NormalizedSession[] = [];
const EMPTY_LEADERBOARD: LeaderboardRow[] = [];
const EMPTY_POT_LOG: ClubPotLog[] = [];
const EMPTY_PENDING: PendingChangeRequest[] = [];
const EMPTY_AUDIT: AuditLog[] = [];
const EMPTY_DELETED: clubRecordsApi.DeletedSessionRef[] = [];
const EMPTY_BUY_INS: BuyInRequest[] = [];

const DEFAULT_MAX_BUY_IN = 5000;

type ClubTab = 'activeSession' | 'history' | 'leaderboard' | 'pot' | 'pendingApprovals' | 'auditTrail';

const TAB_TO_SLUG: Record<ClubTab, string> = {
  activeSession: 'active-session',
  history: 'history',
  leaderboard: 'leaderboard',
  pot: 'pot',
  pendingApprovals: 'pending-approvals',
  auditTrail: 'audit',
};

// Unknown or missing slugs fall back to the session tab rather than erroring:
// a stale bookmark should open the club, not a dead end.
const SLUG_TO_TAB: Record<string, ClubTab> = Object.fromEntries(
  Object.entries(TAB_TO_SLUG).map(([tab, slug]) => [slug, tab as ClubTab])
);

export const ClubDetailView: React.FC<ClubDetailViewProps> = ({
  club: initialClub,
  currentUser,
  playerAvatarUrl,
  onBackToDashboard,
}) => {
  const cache = useResourceCache();
  const clubKey = `club:${initialClub.id}`;

  /**
   * The club, read from the same cache entry ClubRoute populated.
   *
   * It used to be local useState seeded from the prop, with its own
   * fetch-and-setState refresher. That meant a second, uncached GET /clubs/:id
   * on top of the one the route had just made — and worse, two copies of the
   * club that drifted apart: every mutation below updated the local one, so the
   * cached entry stayed stale and navigating away and back showed the old name,
   * the old admin list, the old settings.
   *
   * initialClub is the fallback only until the subscription delivers, and
   * ClubRoute has already guaranteed the entry exists, so this is a cache hit
   * that issues no request.
   */
  const clubRes = useResource<Club>(clubKey, () => clubsApi.getClub(initialClub.id));
  const club = clubRes.data ?? initialClub;
  const refreshClub = clubRes.refresh;
  /** Write-through for mutations that return the updated club. */
  const setClub = useCallback(
    (updated: Club) => cache.update<Club>(clubKey, () => updated),
    [cache, clubKey]
  );



  // Whether this client is actually receiving live updates. Surfaced in the
  // header because the failure mode is silent: a dropped socket leaves the
  // table looking perfectly normal while it quietly stops changing, and an
  // admin has no way to tell they're settling against a stale view.
  const [socketLive, setSocketLive] = useState(true);
  const [browserOnline, setBrowserOnline] = useState(
    typeof navigator === 'undefined' ? true : navigator.onLine
  );
  useEffect(() => {
    const on = () => setBrowserOnline(true);
    const off = () => setBrowserOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  const connection: 'live' | 'reconnecting' | 'offline' =
    !browserOnline ? 'offline' : socketLive ? 'live' : 'reconnecting';

  // Core Scorekeeper Tabs
  /**
   * The selected tab lives in the URL, not in state.
   *
   * Each tab is addressable — /clubs/:clubId/history and so on — so a refresh
   * keeps you on the tab you were reading, the tab can be bookmarked and
   * shared, and browser Back walks tab -> tab -> club -> dashboard instead of
   * jumping straight out of the club.
   *
   * setActiveTab keeps its name and signature deliberately: every existing call
   * site works unchanged, it just pushes a history entry now instead of
   * mutating state.
   */
  const navigate = useNavigate();
  const { tab: tabSlug } = useParams<{ tab?: string }>();

  const activeTab = (SLUG_TO_TAB[tabSlug ?? ''] ?? 'activeSession') as ClubTab;

  const setActiveTab = useCallback(
    (next: ClubTab) => navigate(`/clubs/${initialClub.id}/${TAB_TO_SLUG[next]}`),
    [navigate, initialClub.id]
  );


  /**
   * The live table: the session and its buy-in requests, as ONE resource.
   *
   * They are fetched together and must never disagree — the nav bar's pending
   * badge counts from buyInRequests while the panel renders from session, so a
   * window where one is fresh and the other stale is visible to the user. Two
   * cache keys could drift; one cannot. Same reasoning as audit + deleted
   * sessions.
   *
   * This is the hot path: 7 of the 11 socket events and 9 mutation sites target
   * it (see CLUB-RESOURCE-MAP.md). Every one of those call sites still calls
   * refreshActiveSession(), which now forces a fetch through the cache rather
   * than running its own — the right primitive for a resource that is on screen.
   *
   * sessionLoaded is gone: status === 'empty' already means "never fetched",
   * which is the only condition that should render the loading skeleton.
   */
  const sessionRes = useResource<SessionResource>(
    `${clubKey}:active-session`,
    async () => {
      const session = await offlineSessionsApi.getActiveSession(initialClub.id);
      const buyIns = session
        ? await offlineSessionsApi.listBuyInRequests(initialClub.id, session.id)
        : [];
      return { session, buyIns };
    }
  );
  const activeSession = sessionRes.data?.session ?? null;
  const buyInRequests = sessionRes.data?.buyIns ?? EMPTY_BUY_INS;
  const sessionLoaded = sessionRes.status === 'ready';
  const refreshActiveSession = sessionRes.refresh;

  // Real-time data


  // Club roster (owner + admins + members) — every user this view could ever
  // need a display name for, since buy-in requesters, history players, and
  // audit log actors are always club members.

  // Link Player to Member Modal State
  const [showLinkModal, setShowLinkModal] = useState(false);
  const [linkingSession, setLinkingSession] = useState<any>(null);
  const [linkingPlayerIndex, setLinkingPlayerIndex] = useState<number>(-1);
  const [linkingPlayerName, setLinkingPlayerName] = useState<string>('');
  const [linkingSelectedUserUid, setLinkingSelectedUserUid] = useState<string>('');
  const [isSavingLink, setIsSavingLink] = useState(false);

  // Expanded History Session ID
  const [expandedSessionId, setExpandedSessionId] = useState<string | null>(null);

  // Edit Session Modal state (Admins)
  const [showEditSessionModal, setShowEditSessionModal] = useState(false);
  const [editingSession, setEditingSession] = useState<any>(null);
  const [editSessionDate, setEditSessionDate] = useState('');
  const [editSessionNotes, setEditSessionNotes] = useState('');
  // An edit re-settles the night server-side, so the admin sees the recomputed
  // result before committing rather than after — same gate as the Cashout and
  // past-night modals.
  const [editCalculated, setEditCalculated] = useState(false);
  const [editConfirming, setEditConfirming] = useState(false);
  const [editPlayerStats, setEditPlayerStats] = useState<{ name: string; buyIn: number; cashOut: number; userId?: string }[]>([]);
  const [submittingEdit, setSubmittingEdit] = useState(false);

  // Delete Session Confirmation Modal state
  const [deletingSessionTarget, setDeletingSessionTarget] = useState<any>(null);
  const [submittingDelete, setSubmittingDelete] = useState(false);

  // Mobile Floating Action Button (FAB) state
  const [mobileFabOpen, setMobileFabOpen] = useState(false);


  // Recording a night played before it was entered. Owner-only.
  const [showPastSessionModal, setShowPastSessionModal] = useState(false);
  const [pastDate, setPastDate] = useState('');
  const [pastRows, setPastRows] = useState<{ userId?: string; name: string; buyIn: number; cashOut: number }[]>([
    { name: '', buyIn: 0, cashOut: 0 },
    { name: '', buyIn: 0, cashOut: 0 },
  ]);
  const [savingPast, setSavingPast] = useState(false);
  // A back-dated night runs the same engine as a live settle and moves the
  // club pot the same way, so it gets the same calculate-then-confirm gate
  // rather than saving straight off the raw tally.
  const [pastCalculated, setPastCalculated] = useState(false);
  const [pastConfirming, setPastConfirming] = useState(false);
  const [pastMismatchAcknowledged, setPastMismatchAcknowledged] = useState(false);
  const [showStandUpModal, setShowStandUpModal] = useState(false);
  const [standUpAmount, setStandUpAmount] = useState<number>(0);
  const [showBuyInModal, setShowBuyInModal] = useState(false);
  const [buyInAmount, setBuyInAmount] = useState<number>(club.minBuyIn || 1000);
  const [buyInTargetUser, setBuyInTargetUser] = useState<string>(currentUser.uid);

  // Toasts — replaces the blocking alert() calls for buy-in feedback so the
  // over-max case can be surfaced without interrupting the flow.
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const pushToast = useCallback(
    (title: string, message: string, type: ToastMessage['type'] = 'success') => {
      const id = `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      setToasts((prev) => [...prev, { id, title, message, type }]);
      setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000);
    },
    []
  );
  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // Cash-out settlement inputs: { userId: amount }
  const [cashOutInputs, setCashOutInputs] = useState<Record<string, number>>({});
  const [buyInInputs, setBuyInInputs] = useState<Record<string, number>>({});
  const [manualWinnerInputs, setManualWinnerInputs] = useState<Record<string, boolean>>({});
  const [mismatchAcknowledged, setMismatchAcknowledged] = useState(false);
  const [settlementError, setSettlementError] = useState('');
  const [settlementSuccess, setSettlementSuccess] = useState('');
  const [showCashoutModal, setShowCashoutModal] = useState(false);
  const [cashoutCalculated, setCashoutCalculated] = useState(false);
  const [confirmingSettle, setConfirmingSettle] = useState(false);
  const [showClubInfoModal, setShowClubInfoModal] = useState(false);
  const [showProfileModal, setShowProfileModal] = useState(false);

  // User Hierarchy Role Checks (server-issued JWT claim, not a client-trust email string)
  const isSuperUser = currentUser.isSuperAdmin;

  const isOwner =
    club.ownerUid === currentUser.uid ||
    club.createdBy === currentUser.uid ||
    isSuperUser;

  const isAdmin =
    isOwner ||
    club.adminUids?.includes(currentUser.uid) ||
    isSuperUser;

  // Owner/admins always see the Leaderboard; plain players only when the
  // owner has turned it on for the club (server enforces this too). The
  // fallback is false to match the column default — if the flag is ever
  // missing from a payload, the safe assumption is "not shared".
  const canSeeLeaderboard = isAdmin || (club.leaderboardVisibleToPlayers ?? false);

  // Club Members UID list
  const allMembersList = Array.from(new Set([...(club.memberUids || []), ...(club.adminUids || []), club.ownerUid || club.createdBy])).filter(Boolean);

  // Remove Member from Club Handler
  const handleRemoveMemberFromClub = async (targetUid: string) => {
    if (!isSuperUser && !isOwner && !isAdmin) {
      alert('Only Club Admins or Super User can remove members from the club.');
      return;
    }
    const userObj = allUsers[targetUid];
    const name = userObj?.displayName || userObj?.email || `User (${targetUid.slice(0, 6)})`;
    if (confirm(`Are you sure you want to remove user "${name}" from ${club.name}?`)) {
      try {
        const updated = await clubsApi.removeMember(club.id, targetUid);
        setClub(updated);
        alert(`User "${name}" successfully removed from ${club.name}.`);
      } catch (err) {
        console.error('Failed to remove member:', err);
        alert('Failed to remove member from club.');
      }
    }
  };

  // Open Link Player Modal Handler
  const handleOpenLinkModal = (session: any, playerIdx: number, playerName: string, currentUserId?: string) => {
    setLinkingSession(session);
    setLinkingPlayerIndex(playerIdx);
    setLinkingPlayerName(playerName);
    setLinkingSelectedUserUid(currentUserId || '');
    setShowLinkModal(true);
  };

  // Save Link Player to Member
  const handleSavePlayerLink = async () => {
    if (!linkingSession || linkingPlayerIndex < 0 || !linkingSelectedUserUid) return;
    setIsSavingLink(true);
    try {
      const selectedUser = allUsers[linkingSelectedUserUid];
      await clubRecordsApi.linkHistoryPlayer(club.id, {
        recordId: linkingSession.id,
        sourceType: linkingSession.sourceType,
        playerIndex: linkingPlayerIndex,
        userId: linkingSelectedUserUid,
      });
      await refreshHistory();

      alert(`🎉 Successfully linked "${linkingPlayerName}" to ${selectedUser?.displayName || 'Member'}!`);
      setShowLinkModal(false);
    } catch (err) {
      console.error('Failed to link player:', err);
      alert('Failed to save link. Please try again.');
    } finally {
      setIsSavingLink(false);
    }
  };

  // Promote Member to Club Admin (Max 3 total admins including owner)
  const handlePromoteToAdmin = async (targetUid: string) => {
    if (!isOwner && !isSuperUser) {
      alert('Only the Club Owner or Super User can promote Club Admins.');
      return;
    }
    try {
      const updated = await clubsApi.promoteAdmin(club.id, targetUid);
      setClub(updated);
      alert('🛡️ Member promoted to Club Admin successfully!');
    } catch (err) {
      console.error('Failed to promote admin:', err);
      alert(err instanceof Error ? err.message : 'Failed to promote user to Club Admin.');
    }
  };

  // Demote Club Admin to Regular Member (Cannot demote Owner)
  const handleDemoteAdmin = async (targetUid: string) => {
    if (!isOwner && !isSuperUser) {
      alert('Only the Club Owner or Super User can demote Club Admins.');
      return;
    }
    if (targetUid === club.ownerUid || targetUid === club.createdBy) {
      alert('👑 The Club Owner cannot be demoted.');
      return;
    }
    try {
      const updated = await clubsApi.demoteAdmin(club.id, targetUid);
      setClub(updated);
      alert('Member demoted from Club Admin role.');
    } catch (err) {
      console.error('Failed to demote admin:', err);
      alert('Failed to demote admin.');
    }
  };

  // Every figure in the club UI is denominated in chips — the rupee
  // conversion (club.devaluationFactor) is deliberately not surfaced here.
  // `customClub` is kept on the signature since callers still pass it.
  // Proportional mismatch adjustments land on fractions (a 12.5% share of 300
  // is 37.50), so whole-chip rounding here would show figures that don't add
  // back up to the total buy-ins. Show up to 2dp, but only when they exist —
  // ordinary amounts stay clean.
  const chipStr = (n: number) => {
    const rounded = Math.round(n * 100) / 100;
    return Number.isInteger(rounded)
      ? rounded.toLocaleString()
      : rounded.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  const formatVal = (chips: number, _customClub?: Club) => `${chipStr(chips)} Chips`;

  const formatSignedVal = (chips: number, _customClub?: Club) => {
    const sign = chips > 0 ? '+' : chips < 0 ? '-' : '';
    return `${sign}${chipStr(Math.abs(chips))} Chips`;
  };

  const formatPts = formatVal;
  const formatSignedPts = formatSignedVal;

  // A club can declare that N chips are worth ₹1. Where that's true, past
  // results can be read either way, so History and the Leaderboard carry a
  // Chips/₹ switch. Chips are the default everywhere: they're what was
  // actually on the table, and the rupee value is a derived view of them.
  // The switch is shared by both tabs so the two never disagree, and it is
  // display-only — nothing stored or sent is ever converted.
  const rupeeFactor = (club.enableDevaluation ?? false) ? (club.devaluationFactor ?? 1) : 1;
  const canShowRupees = rupeeFactor > 1;
  const [recordsUnit, setRecordsUnit] = useState<'chips' | 'inr'>('chips');
  const activeUnit = canShowRupees ? recordsUnit : 'chips';

  const rupeeStr = (chips: number) => chipStr(chips / rupeeFactor);
  const formatUnit = (chips: number) =>
    activeUnit === 'chips' ? formatVal(chips) : `₹${rupeeStr(chips)}`;
  const formatSignedUnit = (chips: number) => {
    if (activeUnit === 'chips') return formatSignedVal(chips);
    const sign = chips > 0 ? '+' : chips < 0 ? '-' : '';
    return `${sign}₹${rupeeStr(Math.abs(chips))}`;
  };

  const currencyToggle = canShowRupees ? (
    <div className="inline-flex items-center bg-bg border border-line rounded-full p-0.5 shrink-0">
      {([['chips', 'Chips'], ['inr', '₹']] as const).map(([value, label]) => (
        <button
          key={value}
          type="button"
          onClick={() => setRecordsUnit(value)}
          aria-pressed={recordsUnit === value}
          className={`px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-wider transition-colors ${
            recordsUnit === value
              ? 'bg-accent text-accent-contrast'
              : 'text-text-muted hover:text-text'
          }`}
        >
          {label}
        </button>
      ))}
      <InfoHint>
        Your club values {rupeeFactor} Chips at ₹1. Switch to see these figures as rupees — it only
        changes how they're shown here, never what's recorded.
      </InfoHint>
    </div>
  ) : null;

  // Club Settings Modal (Admin only)
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [editClubName, setEditClubName] = useState(club.name);
  const [editBuyInMode, setEditBuyInMode] = useState<'MATCH_HIGHEST' | 'UNCAPPED'>(club.buyInMode ?? 'MATCH_HIGHEST');
  const [editMinBuyIn, setEditMinBuyIn] = useState(club.minBuyIn || 1000);
  const [editMaxBuyIn, setEditMaxBuyIn] = useState(club.maxBuyIn || 5000);
  const [editEnableDevaluation, setEditEnableDevaluation] = useState(club.enableDevaluation ?? true);
  const [editDevaluationFactor, setEditDevaluationFactor] = useState(club.devaluationFactor ?? 5);
  const [savingSettings, setSavingSettings] = useState(false);

  // Settlement Rules (config-driven Cashout Engine)
  const [editRakeEnabled, setEditRakeEnabled] = useState(club.rakeEnabled ?? true);
  const [editRakeMethod, setEditRakeMethod] = useState<RakeMethod>(club.rakeMethod ?? 'PERCENT_PROFIT');
  const [editRakeValue, setEditRakeValue] = useState(club.rakeValue ?? 5);
  const [editPotEnabled, setEditPotEnabled] = useState(club.potEnabled ?? true);
  const [editMismatchStrategy, setEditMismatchStrategy] = useState<MismatchStrategy>(club.mismatchStrategy ?? 'PROPORTIONAL_WINNERS');
  const [editRakeOrder, setEditRakeOrder] = useState<RakeOrder>(club.rakeOrder ?? 'MISMATCH_FIRST');
  const [editWinnerDefinition, setEditWinnerDefinition] = useState<WinnerDefinition>(club.winnerDefinition ?? 'PROFIT_POSITIVE');
  const [editWinnerTopN, setEditWinnerTopN] = useState(club.winnerTopN ?? 1);
  const [editRoundingRule, setEditRoundingRule] = useState<RoundingRule>(club.roundingRule ?? 'NONE');

  // Sync edit state when club prop updates
  useEffect(() => {
    setEditClubName(club.name);
    setEditBuyInMode(club.buyInMode ?? 'MATCH_HIGHEST');
    setEditMinBuyIn(club.minBuyIn || 1000);
    setEditMaxBuyIn(club.maxBuyIn || 5000);
    setEditEnableDevaluation(club.enableDevaluation ?? true);
    setEditDevaluationFactor(club.devaluationFactor ?? 5);
    setEditRakeEnabled(club.rakeEnabled ?? true);
    setEditRakeMethod(club.rakeMethod ?? 'PERCENT_PROFIT');
    setEditRakeValue(club.rakeValue ?? 5);
    setEditPotEnabled(club.potEnabled ?? true);
    setEditMismatchStrategy(club.mismatchStrategy ?? 'PROPORTIONAL_WINNERS');
    setEditRakeOrder(club.rakeOrder ?? 'MISMATCH_FIRST');
    setEditWinnerDefinition(club.winnerDefinition ?? 'PROFIT_POSITIVE');
    setEditWinnerTopN(club.winnerTopN ?? 1);
    setEditRoundingRule(club.roundingRule ?? 'NONE');
  }, [club]);

  const [editLeaderboardVisibleToPlayers, setEditLeaderboardVisibleToPlayers] = useState(club.leaderboardVisibleToPlayers ?? false);
  useEffect(() => {
    setEditLeaderboardVisibleToPlayers(club.leaderboardVisibleToPlayers ?? false);
  }, [club.leaderboardVisibleToPlayers]);

  const handleSaveClubSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isAdmin) {
      pushToast('Not allowed', 'Only a Club Admin can do this.', 'warning');
      return;
    }
    setSavingSettings(true);
    try {
      // Only the fields a club can still change after creation are sent. The
      // settlement rules are fixed at creation and the server rejects any
      // attempt to alter them — see IMMUTABLE_CLUB_RULES in clubs.service.ts.
      const updated = await clubsApi.updateClub(club.id, {
        name: editClubName.trim() || club.name,
        ...(isOwner ? { leaderboardVisibleToPlayers: editLeaderboardVisibleToPlayers } : {}),
      });
      setClub(updated);
      alert('✅ Club settings updated.');
      setShowSettingsModal(false);
    } catch (err) {
      console.error('Failed to update club settings:', err);
      alert('Failed to save club settings.');
    } finally {
      setSavingSettings(false);
    }
  };

  // Active Session Buy-Ins
  const activeSessionBuyIns = buyInRequests.filter(
    r => r.sessionId === activeSession?.id && r.status === 'approved'
  );

  // Calculate Largest Active Bank currently held by any player at the table
  const playerBanks: Record<string, number> = {};
  activeSessionBuyIns.forEach(req => {
    playerBanks[req.userId] = (playerBanks[req.userId] || 0) + req.amount;
  });

  const largestActiveBank = Object.values(playerBanks).length > 0 
    ? Math.max(...Object.values(playerBanks)) 
    : 0;

  // Buy-in ceiling. Mirrors getBuyInCeiling() on the server, which is the
  // authority — this copy only drives the input, the toast and the display.
  //   UNCAPPED      -> no ceiling, the only case shown as "No limit"
  //   MATCH_HIGHEST -> the biggest bank anyone currently holds, or the club's
  //                    configured maxBuyIn before anyone holds one
  //
  // Both branches must stay identical to the server: this number is shown to
  // players as the amount they may take, so a mismatch either promises a
  // buy-in the API will reject, or hides headroom they actually have.
  const buyInCeiling: number | null =
    (club.buyInMode ?? 'MATCH_HIGHEST') === 'UNCAPPED'
      ? null
      : largestActiveBank > 0
        ? largestActiveBank
        : club.maxBuyIn ?? DEFAULT_MAX_BUY_IN;
  // Kept for the existing UI bindings that expect a number.
  const dynamicMaxBuyIn = buyInCeiling ?? Number.MAX_SAFE_INTEGER;

  // Seating state for the current user / the admin's sit-in queue.
  // Admins triage everyone's requests; a player only ever sees their own.
  const visiblePendingBuyIns = buyInRequests.filter(
    (r) => r.status === 'pending' && (isAdmin || r.userId === currentUser.uid)
  );

  const visibleProcessedBuyIns = buyInRequests.filter(
    (r) => r.status !== 'pending' && (isAdmin || r.userId === currentUser.uid)
  );

  const pendingSitInUids = activeSession?.pendingSitInUids || [];
  const sessionCashOuts = activeSession?.cashOuts || [];
  const pendingCashOuts = sessionCashOuts.filter((c) => c.status === 'pending');
  const myCashOut = sessionCashOuts.find((c) => c.userId === currentUser.uid);

  // A player who stood up early already has an admin-confirmed cash-out. The
  // server settles on that number no matter what the settle form says, so
  // mirror it into the form and lock the field rather than implying it's
  // still editable.
  const confirmedCashOutByUid = useMemo(() => {
    const m: Record<string, number> = {};
    sessionCashOuts.forEach((c) => {
      if (c.status === 'confirmed') m[c.userId] = c.amount;
    });
    return m;
  }, [JSON.stringify(sessionCashOuts)]);

  // Standing up removes a player from activePlayerUids, but they're still part
  // of the night — the server settles the union of seated players and confirmed
  // cash-outs, so the form has to iterate the same set or it silently drops
  // them from the preview, the submit, and the "all cash-outs entered" gate.
  const settlementUids = useMemo(
    () =>
      Array.from(new Set([...(activeSession?.activePlayerUids || []), ...Object.keys(confirmedCashOutByUid)])),
    [JSON.stringify(activeSession?.activePlayerUids), confirmedCashOutByUid]
  );

  useEffect(() => {
    const locked = Object.entries(confirmedCashOutByUid);
    if (locked.length === 0) return;
    setCashOutInputs((prev) => {
      let changed = false;
      const next = { ...prev };
      locked.forEach(([uid, amt]) => {
        if (next[uid] !== amt) {
          next[uid] = amt;
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [confirmedCashOutByUid]);
  const isSeated = !!activeSession?.activePlayerUids.includes(currentUser.uid);
  const hasRequestedSitIn = pendingSitInUids.includes(currentUser.uid);

  // ---------- Data loading (REST) + live sync (Socket.IO) ----------


/**
   * Server state for this club lives in the shared cache, keyed by club id.
   *
   * Each resource keeps the refreshX name its ~30 call sites already use — the
   * function is now the cache's refresh rather than a bespoke fetch-and-setState,
   * so behaviour at the call sites is unchanged while the data itself outlives
   * this component. Re-entering a club within staleTime costs no requests at
   * all, and previously-viewed data stays on screen while it revalidates.
   *
   * Permission gates are expressed as a null key rather than an early return:
   * useResource skips a null key entirely, so a non-admin never issues the
   * request instead of issuing it and discarding the result.
   *
   * No `loaded` flags: `status === 'empty'` means never fetched, which is the
   * only condition that should render a skeleton.
   */
  const canSeeAudit = isOwner || isSuperUser;

  const rosterRes = useResource<Record<string, ClubRosterEntry>>(
    `${clubKey}:roster`,
    () => clubsApi.getClubRoster(initialClub.id)
  );
  const allUsers = rosterRes.data ?? EMPTY_ROSTER;
  const refreshRoster = rosterRes.refresh;



  const historyRes = useResource<NormalizedSession[]>(
    `${clubKey}:history`,
    () => clubRecordsApi.listHistory(initialClub.id)
  );
  const historyData = historyRes.data ?? EMPTY_HISTORY;
  const refreshHistory = historyRes.refresh;

  const leaderboardRes = useResource<LeaderboardRow[]>(
    `${clubKey}:leaderboard`,
    // Leaderboard visibility is owner-toggleable — a 403 here means this viewer
    // is not allowed to see it, not that anything failed.
    () => clubRecordsApi.getLeaderboard(initialClub.id).catch(() => [] as LeaderboardRow[])
  );
  const leaderboardData = leaderboardRes.data ?? EMPTY_LEADERBOARD;
  const refreshLeaderboard = leaderboardRes.refresh;

  const potLogRes = useResource<ClubPotLog[]>(
    isAdmin ? `${clubKey}:pot-log` : null,
    () => clubRecordsApi.listPotLog(initialClub.id)
  );
  const potLogs = potLogRes.data ?? EMPTY_POT_LOG;
  const refreshPotLog = potLogRes.refresh;

  const pendingChangesRes = useResource<PendingChangeRequest[]>(
    isAdmin ? `${clubKey}:pending-changes` : null,
    () => clubRecordsApi.listPendingChanges(initialClub.id)
  );
  const pendingChangeRequests = pendingChangesRes.data ?? EMPTY_PENDING;
  const refreshPendingChanges = pendingChangesRes.refresh;

  // Audit and deleted sessions are always fetched and displayed together, so
  // they are one resource rather than two — one key, one revalidation.
  const auditRes = useResource<{ logs: AuditLog[]; deleted: clubRecordsApi.DeletedSessionRef[] }>(
    canSeeAudit ? `${clubKey}:audit` : null,
    async () => {
      const [logs, deleted] = await Promise.all([
        clubRecordsApi.listAuditLog(initialClub.id),
        clubRecordsApi.listDeletedSessions(initialClub.id),
      ]);
      return { logs, deleted };
    }
  );
  const auditLogs = auditRes.data?.logs ?? EMPTY_AUDIT;
  const deletedSessions = auditRes.data?.deleted ?? EMPTY_DELETED;
  const refreshAuditTrail = auditRes.refresh;

  // No initial-load effect.
  //
  // There used to be one here calling refresh() on all seven resources. refresh()
  // is a *forced* fetch — it bypasses both the staleness check and the in-flight
  // dedupe — so every mount of this screen cost seven requests no matter what was
  // already cached. That defeated the cache it was sitting on top of: the whole
  // point of the layer is that re-entering a club within staleTime costs nothing,
  // and this effect made it cost full price every time.
  //
  // useResource already loads on mount when there is something to load: a miss
  // fetches, stale data revalidates behind the content, and fresh data does
  // neither. Resources gated to admins have a null key and are skipped entirely.

  // Live sync: join this club's room and refetch the affected slice on each
  // event, rather than trusting the socket payload as full state — same
  // pattern as VirtualTableView's club/session room sync.
  useEffect(() => {
    const socket = getSocket();

    // Room membership lives on the socket, so a reconnect lands in a *new*
    // socket with no rooms. Joining only on mount meant that after any drop —
    // phone backgrounding, laptop sleep, wifi change, an API restart — this
    // client silently stopped receiving updates while the UI carried on
    // looking normal. Re-join on every connect, not just the first.
    //
    // The refetch matters as much as the re-join: events that fired while we
    // were away are gone for good, so the only way back to the truth is to
    // ask for it. This is what makes the view converge after a drop rather
    // than resuming from a stale snapshot.
    const resync = () => {
      socket.emit('club:join', initialClub.id);
      refreshClub();
      refreshRoster();
      refreshActiveSession();
      refreshHistory();
      refreshLeaderboard();
      refreshPotLog();
      refreshPendingChanges();
      refreshAuditTrail();
    };

    const onConnect = () => { setSocketLive(true); resync(); };
    const onDisconnect = () => setSocketLive(false);

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);

    // Already connected when this mounted — 'connect' won't fire again.
    if (socket.connected) socket.emit('club:join', initialClub.id);
    setSocketLive(socket.connected);

    // A request that times out is auto-rejected server-side and simply
    // disappears from the table. Tell whoever it belonged to why, otherwise it
    // reads as the app losing their request.
    const notifyIfExpired = (p: { userId?: string; expired?: boolean }, what: string, retry: string) => {
      if (!p?.expired || p.userId !== currentUser.uid) return;
      pushToast(`${what} expired`, `No admin acted on it within 5 minutes. ${retry}`, 'warning');
    };

    // Events now arrive carrying the new state, so the common path is to patch
    // what is already on screen. Each helper falls back to a refetch when the
    // payload is missing — an API still running the old build, or an event
    // shape we don't recognise — so a partial deploy degrades to the previous
    // behaviour rather than to a stale table.
    const patchSession = (p: { session?: ApiOfflineSession | null }) => {
      if (!p?.session) return refreshActiveSession();
      const session = offlineSessionsApi.toPokerSession(p.session);
      cache.update<SessionResource>(`${clubKey}:active-session`, (prev) =>
        prev ? { ...prev, session } : { session, buyIns: [] }
      );
    };

    // Keyed by id and idempotent: a repeat of the same event replaces the row
    // with an identical one rather than appending a duplicate, so events
    // arriving out of order or twice cannot corrupt the list.
    const patchBuyIn = (p: { request?: ApiBuyInRequest }) => {
      if (!p?.request) return refreshActiveSession();
      const row = offlineSessionsApi.toBuyInRequest(p.request);
      cache.update<SessionResource>(`${clubKey}:active-session`, (prev) => {
        if (!prev) return { session: null, buyIns: [row] };
        const i = prev.buyIns.findIndex((b) => b.id === row.id);
        const buyIns = i === -1
          ? [...prev.buyIns, row]
          : prev.buyIns.map((b) => (b.id === row.id ? { ...b, ...row } : b));
        return { ...prev, buyIns };
      });
    };

    const onSessionStarted = (p: { session?: ApiOfflineSession | null }) => {
      // A new session means the previous night's buy-ins are no longer this
      // table's, so they are cleared rather than carried over.
      if (!p?.session) return refreshActiveSession();
      cache.update<SessionResource>(`${clubKey}:active-session`, () => ({
        session: offlineSessionsApi.toPokerSession(p.session!),
        buyIns: [],
      }));
    };
    const onBuyinRequested = (p: { request?: ApiBuyInRequest }) => patchBuyIn(p);
    const onBuyinDecided = (p: { userId?: string; expired?: boolean; request?: ApiBuyInRequest }) => {
      notifyIfExpired(p, 'Buy-in request', 'Ask for chips again.');
      // An approval also seats the player, which lives in the session's
      // engineState and is not in this payload. The row patch is what makes
      // the pending entry disappear immediately; the session catches up on the
      // next revalidation rather than on a blocking round trip.
      patchBuyIn(p);
    };
    const onSessionSettled = () => {
      refreshActiveSession();
      refreshHistory();
      refreshLeaderboard();
      refreshPotLog();
      refreshClub();
    };
    const onHistoryUpdated = () => {
      refreshHistory();
      refreshLeaderboard();
      refreshAuditTrail();
    };
    const onSitInRequested = (p: { session?: ApiOfflineSession | null }) => patchSession(p);
    const onSitInDecided = (p: { userId?: string; expired?: boolean; session?: ApiOfflineSession | null }) => {
      notifyIfExpired(p, 'Sit-in request', 'Ask again when someone is at the console.');
      patchSession(p);
    };
    const onCashOutRequested = (p: { session?: ApiOfflineSession | null }) => patchSession(p);
    const onCashOutDecided = (p: { userId?: string; expired?: boolean; session?: ApiOfflineSession | null }) => {
      notifyIfExpired(p, 'Cash-out', 'Re-count your chips and send it again.');
      patchSession(p);
    };
    const onPendingRequest = () => refreshPendingChanges();
    const onPendingRequestDecided = () => {
      refreshPendingChanges();
      refreshHistory();
      refreshLeaderboard();
      refreshAuditTrail();
    };

    socket.on('club:session-started', onSessionStarted);
    socket.on('club:buyin-requested', onBuyinRequested);
    socket.on('club:buyin-decided', onBuyinDecided);
    socket.on('club:sitin-requested', onSitInRequested);
    socket.on('club:sitin-decided', onSitInDecided);
    socket.on('club:cashout-requested', onCashOutRequested);
    socket.on('club:cashout-decided', onCashOutDecided);
    socket.on('club:session-settled', onSessionSettled);
    socket.on('club:history-updated', onHistoryUpdated);
    socket.on('club:pending-request', onPendingRequest);
    socket.on('club:pending-request-decided', onPendingRequestDecided);

    return () => {
      socket.emit('club:leave', initialClub.id);
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('club:session-started', onSessionStarted);
      socket.off('club:buyin-requested', onBuyinRequested);
      socket.off('club:buyin-decided', onBuyinDecided);
      socket.off('club:sitin-requested', onSitInRequested);
      socket.off('club:sitin-decided', onSitInDecided);
      socket.off('club:cashout-requested', onCashOutRequested);
      socket.off('club:cashout-decided', onCashOutDecided);
      socket.off('club:session-settled', onSessionSettled);
      socket.off('club:history-updated', onHistoryUpdated);
      socket.off('club:pending-request', onPendingRequest);
      socket.off('club:pending-request-decided', onPendingRequestDecided);
    };
  }, [initialClub.id, refreshActiveSession, refreshHistory, refreshLeaderboard, refreshPotLog, refreshClub, refreshRoster, refreshAuditTrail, refreshPendingChanges, pushToast, currentUser.uid, cache, clubKey]);

  // Total admins count
  const totalAdminsCount = Array.from(new Set([
    ...(club.adminUids || []),
    club.ownerUid || club.createdBy
  ])).filter(Boolean).length;

  // Server-computed, role-filtered "Day N" feed (merges historical PDF
  // imports with settled live sessions) — replaces the old client-side
  // compileNormalizedSessions() now that the API does this authoritatively.
  // Session numbers are DERIVED from date order, never stored. That's what
  // makes a back-dated night slot into the right place and renumber the rest
  // automatically — a number baked into the title could never do that.
  const sessionNumberById = (() => {
    const byDateAsc = [...historyData].sort((a, b) => {
      const ta = new Date(a.date || 0).getTime();
      const tb = new Date(b.date || 0).getTime();
      if (ta !== tb) return ta - tb;
      // Same date: fall back to insertion order so numbering stays stable.
      return String(a.id).localeCompare(String(b.id));
    });
    const map = new Map<string, number>();
    byDateAsc.forEach((sess, i) => map.set(String(sess.id), i + 1));
    return map;
  })();

  // Newest first for display.
  const normalizedSessions = [...historyData].sort((a, b) => {
    const ta = new Date(a.date || 0).getTime();
    const tb = new Date(b.date || 0).getTime();
    if (ta !== tb) return tb - ta;
    return (sessionNumberById.get(String(b.id)) ?? 0) - (sessionNumberById.get(String(a.id)) ?? 0);
  });

  // Start a New Poker Session
  const handleStartSession = async () => {
    if (!isAdmin) {
      pushToast('Not allowed', 'Only a Club Admin can do this.', 'warning');
      return;
    }
    try {
      // Date-first naming: "Day 8" tells you nothing a month later, whereas
      // the date is the thing people actually recall a night by. The running
      // count is kept as a suffix so the sequence isn't lost.
      const sessionNum = normalizedSessions.length + 1;
      const label = new Date().toLocaleDateString(undefined, {
        weekday: 'short', day: 'numeric', month: 'short',
      });
      const sessionName = `${label} · Day ${sessionNum}`;
      await offlineSessionsApi.startSession(club.id, {
        sessionType: 'OFFLINE',
        sessionName,
      });
      await refreshActiveSession();
      pushToast('Session started', `${sessionName} is live. Players can sit in and buy chips.`, 'success');
    } catch (err) {
      console.error('Failed to start session:', err);
      alert(err instanceof Error ? err.message : 'Failed to start session.');
    }
  };

  // Player Stat Edit Helpers
  const handlePlayerStatChange = (index: number, field: 'name' | 'buyIn' | 'cashOut' | 'userId', value: any) => {
    setEditPlayerStats(prev => {
      const copy = [...prev];
      copy[index] = { ...copy[index], [field]: value };
      return copy;
    });
  };

  const handleAddPlayerToEdit = () => {
    setEditPlayerStats(prev => [
      ...prev,
      { name: `Player ${prev.length + 1}`, buyIn: 1000, cashOut: 1000 }
    ]);
  };

  const handleRemovePlayerFromEdit = (index: number) => {
    if (editPlayerStats.length <= 1) {
      alert('A session must have at least one player.');
      return;
    }
    setEditPlayerStats(prev => prev.filter((_, i) => i !== index));
  };

  // Open Edit Session Modal
  const handleOpenEditSession = (session: any) => {
    if (!isAdmin) {
      pushToast('Not allowed', 'Only a Club Admin can do this.', 'warning');
      return;
    }
    setEditingSession(session);
    // Defensive slice as well as the server-side fix: <input type="date">
    // silently blanks on anything that isn't exactly YYYY-MM-DD.
    setEditSessionDate(String(session.date || '').split('T')[0] || new Date().toISOString().split('T')[0]);
    setEditSessionNotes(session.notes || '');
    setEditPlayerStats(
      (session.playerStats || []).map((p: any) => ({
        name: p.name || p.userName || p.userDisplayName || 'Player',
        buyIn: Number(p.buyIn ?? p.totalBuyIn ?? 0),
        cashOut: Number(p.cashOut ?? 0),
        userId: p.userId || ''
      }))
    );
    setShowEditSessionModal(true);
  };

  // Submit Session Edit — the server decides direct-apply vs approval-required
  // (owner/sole-admin apply immediately, otherwise it lands in Pending Approvals)
  const handleSubmitSessionEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingSession || !isAdmin) {
      pushToast('Not allowed', 'Only a Club Admin can edit a recorded session.', 'warning');
      return;
    }

    if (editPlayerStats.length === 0) {
      alert('A session must have at least one player.');
      return;
    }
    if (!editCalculated || !editPreview) {
      pushToast('Calculate first', 'Run the numbers so you can check them before updating.', 'warning');
      return;
    }
    if (editPreview.requiresManualResolution) {
      // Unlike the live-settle and past-night modals, the edit modal has no
      // acknowledgement checkbox, so there is currently no way to push a
      // mismatching edit through. Saying so is better than a dead button, but
      // the real fix is to give this flow the same acknowledgement the other
      // two have — a product decision, not a mechanical one.
      pushToast(
        'Figures do not balance',
        'Cash-outs must match buy-ins for an edited session. Adjust the numbers and calculate again.',
        'warning'
      );
      return;
    }
    // Enforced here rather than by which button is showing — see the note in
    // handleCreatePastSession about Enter and React reusing the button node.
    if (!editConfirming) { setEditConfirming(true); return; }

    setSubmittingEdit(true);

    try {
      const totalBuyIns = editPlayerStats.reduce((sum, p) => sum + (Number(p.buyIn) || 0), 0);
      const totalCashOuts = editPlayerStats.reduce((sum, p) => sum + (Number(p.cashOut) || 0), 0);

      // Only the buy-in/cash-out pairs matter here — the server re-settles the
      // night through the engine and overwrites every derived figure. The
      // profit/deduction values below are placeholders to satisfy the payload
      // shape; do not read them back or treat them as the real result, since
      // they carry no rake, winners' cut or mismatch handling.
      const updatedPlayerStatsForHist = editPlayerStats.map(p => {
        const b = Number(p.buyIn) || 0;
        const c = Number(p.cashOut) || 0;
        return {
          userName: p.name,
          userId: p.userId || undefined,
          totalBuyIn: b,
          cashOut: c,
          profit: c - b,
          timestamp: new Date().toISOString()
        };
      });

      const updatedPlayerSummariesForCashout = editPlayerStats.map(p => {
        const b = Number(p.buyIn) || 0;
        const c = Number(p.cashOut) || 0;
        const grossProfit = c - b;
        return {
          userId: p.userId || p.name.toLowerCase().replace(/\s+/g, '_'),
          userDisplayName: p.name,
          totalBuyIn: b,
          cashOut: c,
          grossProfit,
          excessDeduction: 0,
          winnersCutDeduction: 0,
          netResult: grossProfit
        };
      });

      const changes = [
        { field: 'Session Date', oldValue: editingSession.date, newValue: editSessionDate },
        { field: 'Session Notes', oldValue: editingSession.notes || '', newValue: editSessionNotes },
        { field: 'Total Buy-Ins', oldValue: String(editingSession.totalBuyIns), newValue: String(totalBuyIns) },
        { field: 'Total Cash-Outs', oldValue: String(editingSession.totalCashOuts), newValue: String(totalCashOuts) },
        { field: 'Player Count', oldValue: String(editingSession.playerStats?.length || 0), newValue: String(editPlayerStats.length) }
      ];

      const result = await clubRecordsApi.requestSessionChange(club.id, {
        sessionId: editingSession.id,
        sourceType: editingSession.sourceType,
        sessionTitle: editingSession.dayTitle,
        requestType: 'edit_session',
        changes,
        updatedDate: editSessionDate,
        updatedNotes: editSessionNotes,
        updatedPlayerStats: editingSession.sourceType === 'historical' ? updatedPlayerStatsForHist : undefined,
        updatedPlayerSummaries: editingSession.sourceType === 'cashout' ? updatedPlayerSummariesForCashout : undefined,
        updatedTotalBuyIns: totalBuyIns,
        updatedTotalCashOuts: totalCashOuts,
        reason: 'Historical session edit with player buy-in & cash-out adjustments'
      });

      if (result.status === 'pending') {
        pushToast('Edit proposal submitted', 'Your club has other admins, so another one needs to approve this before it takes effect.', 'info');
        await refreshPendingChanges();
      } else {
        await Promise.all([refreshHistory(), refreshLeaderboard(), refreshPotLog(), refreshClub(), refreshAuditTrail()]);
        pushToast('Session updated', `${editingSession.dayTitle} re-settled under the club's rules.`, 'success');
      }

      setShowEditSessionModal(false);
    } catch (err) {
      // Surface the real reason. The server rejects an edit for concrete,
      // fixable causes (zero buy-in, a mismatch needing manual reconciliation),
      // and a dead API shows up here as "Failed to fetch" — a bare "failed"
      // alert made all of those look like the button simply doing nothing.
      console.error('Failed to submit session edit:', err);
      const message = err instanceof Error ? err.message : 'Please try again.';
      pushToast(
        'Could not update session',
        /failed to fetch|networkerror/i.test(message)
          ? "Couldn't reach the server — check the API is running, then try again."
          : message,
        'warning'
      );
    } finally {
      setSubmittingEdit(false);
    }
  };

  // Trigger Delete Confirmation Modal
  const handleDeleteSessionRequest = (session: any) => {
    if (!isAdmin || !session) return;
    setDeletingSessionTarget(session);
  };

  // Perform Session Soft Deletion — server decides direct-apply vs approval-required
  const performDeleteSession = async (session: any) => {
    if (!isAdmin || !session) return;
    setSubmittingDelete(true);

    try {
      const result = await clubRecordsApi.requestSessionChange(club.id, {
        sessionId: session.id,
        sourceType: session.sourceType,
        sessionTitle: session.dayTitle || `Session (${session.date || ''})`,
        requestType: 'delete_session',
        changes: [{ field: 'Status', oldValue: 'Active Record', newValue: 'Soft Delete' }],
        reason: 'Session deletion request'
      });

      if (result.status === 'pending') {
        alert(`⚠️ Deletion Request Submitted: Because your club has other Club Admins, your request was submitted to 'Pending Approvals' for another admin to approve.`);
        await refreshPendingChanges();
      } else {
        await refreshHistory();
        await refreshLeaderboard();
        await refreshAuditTrail();
        alert(`✅ ${session.dayTitle || 'Session'} deleted successfully. Leaderboards and player statistics recalculated.`);
      }

      setDeletingSessionTarget(null);
      setShowEditSessionModal(false);
    } catch (err) {
      console.error('Failed to delete session:', err);
      alert('Failed to process deletion request.');
    } finally {
      setSubmittingDelete(false);
    }
  };

  // Approve Change Request
  const handleApproveChangeRequest = async (req: PendingChangeRequest) => {
    if (!isAdmin) {
      pushToast('Not allowed', 'Only a Club Admin can do this.', 'warning');
      return;
    }
    try {
      await clubRecordsApi.decidePendingChange(club.id, req.id, true);
      await refreshPendingChanges();
      await refreshHistory();
      await refreshLeaderboard();
      await refreshAuditTrail();
      alert(`🎉 Change request approved and applied! Statistics automatically recalculated.`);
    } catch (err) {
      console.error('Failed to approve change request:', err);
      alert(err instanceof Error ? err.message : 'Failed to approve request.');
    }
  };

  // Reject Change Request
  const handleRejectChangeRequest = async (req: PendingChangeRequest) => {
    if (!isAdmin) {
      pushToast('Not allowed', 'Only a Club Admin can do this.', 'warning');
      return;
    }
    try {
      await clubRecordsApi.decidePendingChange(club.id, req.id, false);
      await refreshPendingChanges();
      await refreshAuditTrail();
      alert('Change request rejected.');
    } catch (err) {
      console.error('Failed to reject change request:', err);
      alert(err instanceof Error ? err.message : 'Failed to reject request.');
    }
  };

  // Restore Soft-Deleted Session
  const handleRestoreSession = async (sessionId: string, sourceType: 'historical' | 'cashout', sessionTitle: string) => {
    if (!isOwner && !isSuperUser) {
      alert('Only the Club Owner or Super User can restore soft-deleted sessions.');
      return;
    }
    try {
      await clubRecordsApi.restoreSession(club.id, sessionId, sourceType, sessionTitle);
      await refreshHistory();
      await refreshLeaderboard();
      await refreshAuditTrail();
      alert(`🎉 ${sessionTitle} restored! Leaderboard and player statistics recalculated.`);
    } catch (err) {
      console.error('Failed to restore session:', err);
      pushToast('Could not restore', err instanceof Error ? err.message : 'Please try again.', 'warning');
    }
  };

  // Join Active Table
  const handleJoinTable = async () => {
    if (!activeSession) {
      pushToast('No live session', 'There is nothing running right now.', 'warning');
      return;
    }
    try {
      await offlineSessionsApi.joinSession(club.id, activeSession.id);
      await refreshActiveSession();
    } catch (err) {
      console.error('Failed to join table:', err);
      pushToast('Could not join', err instanceof Error ? err.message : 'Please try again.', 'warning');
    }
  };

  // Ask to be dealt in — goes to an admin rather than seating immediately.
  const handleRequestSitIn = async () => {
    if (!activeSession) {
      pushToast('No live session', 'There is nothing running right now.', 'warning');
      return;
    }
    try {
      await offlineSessionsApi.requestSitIn(club.id, activeSession.id);
      await refreshActiveSession();
      pushToast('Request sent', 'An admin will wave you in shortly.', 'info');
    } catch (err) {
      console.error('Sit-in request failed:', err);
      pushToast('Could not send request', err instanceof Error ? err.message : 'Please try again.', 'warning');
    }
  };

  const handleDecideSitIn = async (userId: string, approve: boolean) => {
    if (!isAdmin || !activeSession) {
      pushToast(!activeSession ? 'No live session' : 'Not allowed', !activeSession ? 'There is nothing running right now.' : 'Only a Club Admin can do this.', 'warning');
      return;
    }
    const name = allUsers[userId]?.displayName || 'Player';
    try {
      await offlineSessionsApi.decideSitIn(club.id, activeSession.id, userId, approve);
      await refreshActiveSession();
      pushToast(
        approve ? 'Player seated' : 'Request declined',
        approve ? `${name} is now at the table.` : `${name} was not seated.`,
        approve ? 'success' : 'info'
      );
    } catch (err) {
      console.error('Sit-in decision failed:', err);
      pushToast('Action failed', err instanceof Error ? err.message : 'Please try again.', 'warning');
    }
  };

  const handleCreatePastSession = async (e: React.FormEvent) => {
    e.preventDefault();
    const entries = pastRows
      .filter((r) => r.name.trim())
      .map((r) => ({
        ...(r.userId ? { userId: r.userId } : {}),
        userName: r.name.trim(),
        buyIn: Number(r.buyIn) || 0,
        cashOut: Number(r.cashOut) || 0,
      }));
    if (!pastDate) { pushToast('Pick a date', 'Choose the night this game was played.', 'warning'); return; }
    if (entries.length < 2) { pushToast('Add players', 'A session needs at least two named players.', 'warning'); return; }
    if (!pastCalculated || !pastPreview) { pushToast('Calculate first', 'Run the numbers so you can check them before recording.', 'warning'); return; }
    if (pastPreview.requiresManualResolution) return;
    // The confirm gate is enforced here rather than only by which button is
    // showing. Two submit paths bypass the buttons entirely: Enter pressed in
    // any field, and React reusing the same <button> node across the
    // review/confirm ternary — flipping its type to "submit" before the
    // browser evaluates the click's default action, which posts the form on
    // the very click that was meant to open the confirmation.
    if (!pastConfirming) { setPastConfirming(true); return; }

    setSavingPast(true);
    try {
      await clubRecordsApi.createPastSession(club.id, {
        sessionDate: pastDate,
        entries,
        mismatchAcknowledged: pastMismatchAcknowledged,
      });
      await Promise.all([refreshHistory(), refreshLeaderboard(), refreshPotLog(), refreshClub()]);
      setShowPastSessionModal(false);
      setPastRows([{ name: '', buyIn: 0, cashOut: 0 }, { name: '', buyIn: 0, cashOut: 0 }]);
      setPastDate('');
      setPastCalculated(false);
      setPastConfirming(false);
      setPastMismatchAcknowledged(false);
      pushToast('Night recorded', 'Club rules applied and history re-sorted by date.', 'success');
    } catch (err) {
      pushToast('Could not record', err instanceof Error ? err.message : 'Please try again.', 'warning');
    } finally {
      setSavingPast(false);
    }
  };

  // A player leaving early declares their chip count; an admin confirms it,
  // and the figure is locked into settlement.
  const handleStandUp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeSession) {
      pushToast('No live session', 'There is nothing running right now.', 'warning');
      return;
    }
    if (standUpAmount < 0) {
      pushToast('Enter an amount', 'Cash-out cannot be negative.', 'warning');
      return;
    }
    try {
      await offlineSessionsApi.requestCashOut(club.id, activeSession.id, Number(standUpAmount));
      await refreshActiveSession();
      setShowStandUpModal(false);
      pushToast('Cash-out sent', 'An admin will confirm your chip count.', 'info');
    } catch (err) {
      pushToast('Could not stand up', err instanceof Error ? err.message : 'Please try again.', 'warning');
    }
  };

  const handleDecideCashOut = async (userId: string, approve: boolean) => {
    if (!isAdmin || !activeSession) {
      pushToast(!activeSession ? 'No live session' : 'Not allowed', !activeSession ? 'There is nothing running right now.' : 'Only a Club Admin can do this.', 'warning');
      return;
    }
    const name = userId === currentUser.uid ? 'You' : (allUsers[userId]?.displayName || 'Player');
    try {
      await offlineSessionsApi.decideCashOut(club.id, activeSession.id, userId, approve);
      await refreshActiveSession();
      pushToast(approve ? 'Cash-out confirmed' : 'Cash-out rejected',
        approve ? `${name} has left the table. The amount is locked for settlement.`
                : `${name} can re-count and try again.`,
        approve ? 'success' : 'info');
    } catch (err) {
      pushToast('Action failed', err instanceof Error ? err.message : 'Please try again.', 'warning');
    }
  };

  // Submit Buy-In Request
  const handleRequestBuyIn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeSession) {
      pushToast('No active session', 'Nothing is running right now.', 'warning');
      return;
    }

    if (buyInAmount <= 0) {
      pushToast('Enter an amount', 'Buy-in must be more than zero.', 'warning');
      return;
    }

    if (buyInCeiling !== null && buyInAmount > buyInCeiling) {
      pushToast('Over the limit', `The most anyone can take right now is ${formatVal(buyInCeiling)} — matching the biggest bank at the table.`, 'warning');
      return;
    }

    try {
      const created = await offlineSessionsApi.requestBuyIn(
        club.id,
        activeSession.id,
        Number(buyInAmount),
        buyInTargetUser
      );

      // Write the created row straight into the cache instead of refetching.
      //
      // The old path awaited requestBuyIn, then refreshActiveSession — which
      // fetches the session and then the buy-in list, sequentially, because the
      // second needs the session id from the first. Three round trips at ~400ms
      // each before the modal closed. The POST response already contains the
      // row those two GETs were about to return.
      //
      // This is not a speculative optimistic write: it runs after the server
      // has confirmed, so there is nothing to roll back if it fails. The socket
      // event still reaches every other client, and the next revalidation
      // reconciles anything this missed.
      cache.update<SessionResource>(
        `${clubKey}:active-session`,
        (prev) =>
          prev
            ? { ...prev, buyIns: [...prev.buyIns, created] }
            : { session: activeSession, buyIns: [created] }
      );

      pushToast('Buy-in requested', 'Sent to the admins for approval.', 'success');
      setShowBuyInModal(false);
    } catch (err) {
      console.error('Buy-in request error:', err);
      pushToast('Request failed', err instanceof Error ? err.message : 'Could not submit the buy-in.', 'warning');
    }
  };

  /**
   * Approve or reject a buy-in, applied to the screen before the network.
   *
   * The decision is entirely predictable — the row goes to approved or
   * rejected and nothing else about it changes — so there is no reason to make
   * the admin watch it sit there for a round trip first. Approve and reject
   * were one refetch each on top of the POST; both are now zero.
   *
   * Rollback restores the exact entry captured before the write, not a
   * hand-rolled inverse: the server may have refused for a reason that changed
   * more than this row, and the next revalidation reconciles the rest.
   */
  const decideBuyIn = async (request: BuyInRequest, approve: boolean) => {
    const key = `${clubKey}:active-session`;
    const previous = cache.getEntry(key).data as SessionResource | undefined;
    const verb = approve ? 'approve' : 'reject';

    cache.update<SessionResource>(key, (prev) =>
      prev
        ? {
            ...prev,
            buyIns: prev.buyIns.map((b) =>
              b.id === request.id ? { ...b, status: approve ? 'approved' : 'rejected' } : b
            ),
          }
        : prev!
    );

    try {
      const session = await offlineSessionsApi.decideBuyInRequest(club.id, activeSession!.id, request.id, approve);
      // The POST already returns the updated session, including the seating
      // change an approval causes. Taking it from the response is what removes
      // the last GET from this path.
      if (session) {
        cache.update<SessionResource>(key, (prev) => (prev ? { ...prev, session } : { session, buyIns: [] }));
      }
    } catch (err) {
      // Every failure the server can return here — expired request, already
      // decided, no longer admin — reaches the user, and the optimistic row
      // goes back to exactly what it was.
      if (previous !== undefined) cache.update<SessionResource>(key, () => previous);
      console.error(`${verb} error:`, err);
      pushToast(
        approve ? 'Could not approve' : 'Could not reject',
        err instanceof Error ? err.message : `Failed to ${verb} buy-in.`,
        'warning'
      );
    }
  };

  // Approve Buy-In Request
  const handleApproveBuyIn = async (request: BuyInRequest) => {
    // Previously a bare `return`, which made a genuine problem — no live
    // session, or losing admin rights mid-view — indistinguishable from a
    // click that never registered.
    if (!isAdmin || !activeSession) {
      pushToast('Cannot approve', !activeSession ? 'There is no live session right now.' : 'Only a Club Admin can approve buy-ins.', 'warning');
      return;
    }
    await decideBuyIn(request, true);
  };

  // Reject Buy-In Request
  const handleRejectBuyIn = async (request: BuyInRequest) => {
    if (!isAdmin || !activeSession) {
      pushToast('Cannot reject', !activeSession ? 'There is no live session right now.' : 'Only a Club Admin can reject buy-ins.', 'warning');
      return;
    }
    await decideBuyIn(request, false);
  };

  // Calculate Settlement Preview for Cash-Outs
  // Delegates entirely to the config-driven engine (lib/settlementEngine.ts)
  // — no rake percentage, mismatch rule, or winner definition is hardcoded
  // here. This is only the client-side preview; the server recomputes the
  // authoritative result the same way at settle time.
  // One source of truth for the club's rules, shared by the live-settle
  // preview and the back-dated one so the two can never drift apart.
  const clubSettlementSettings: SettlementSettings = {
    sessionRakeAmount: club.sessionRakeAmount ?? 0,
    winnersCutPercent: club.winnersCutPercent ?? 0,
    rakeEnabled: club.rakeEnabled ?? true,
    rakeMethod: club.rakeMethod ?? 'PERCENT_PROFIT',
    rakeValue: club.rakeValue ?? 5,
    potEnabled: club.potEnabled ?? true,
    mismatchStrategy: club.mismatchStrategy ?? 'PROPORTIONAL_WINNERS',
    rakeOrder: club.rakeOrder ?? 'MISMATCH_FIRST',
    winnerDefinition: club.winnerDefinition ?? 'PROFIT_POSITIVE',
    winnerTopN: club.winnerTopN ?? 1,
    roundingRule: club.roundingRule ?? 'NONE',
  };

  const calculateSettlement = (): SettlementResult | null => {
    if (!activeSession) return null;

    const players = settlementUids.map(uid => ({
      userId: uid,
      userDisplayName: uid === currentUser.uid
        ? (currentUser.displayName || currentUser.email?.split('@')[0] || 'Me')
        : (allUsers[uid]?.displayName || `Player (${uid.slice(0, 5)})`),
      buyIn: Number(buyInInputs[uid] || 0),
      cashOut: Number(cashOutInputs[uid] || 0),
      manualWinner: manualWinnerInputs[uid],
    }));

    return computeSettlement(players, clubSettlementSettings, {
      currentPotBalance: club.clubPotBalance ?? 0,
      mismatchAcknowledged,
    });
  };

  // Preview of what an edited session will settle to. Mirrors what the server
  // recomputes in applySessionChange, including the synthetic id it gives a
  // guest with no account, so the two agree on who is who.
  const editHasZeroBuyIn = editPlayerStats.some((p) => (Number(p.buyIn) || 0) <= 0);
  const editPreview: SettlementResult | null =
    editPlayerStats.length >= 2 && !editHasZeroBuyIn
      ? computeSettlement(
          editPlayerStats.map((p, i) => ({
            userId: p.userId || `unlinked:${i}:${p.name}`,
            userDisplayName: p.name,
            buyIn: Number(p.buyIn) || 0,
            cashOut: Number(p.cashOut) || 0,
          })),
          clubSettlementSettings,
          { currentPotBalance: club.clubPotBalance ?? 0 }
        )
      : null;

  // Any change invalidates a calculated preview.
  useEffect(() => {
    setEditCalculated(false);
    setEditConfirming(false);
  }, [JSON.stringify(editPlayerStats), editSessionDate]);

  // A back-dated night is settled with the club's rules as they stand today.
  // Same preview the live Cashout modal shows, and the server recomputes it
  // authoritatively in createPastSession. The synthetic id for a guest with no
  // account must match the server's (`unlinked:<index>:<name>`) or the two
  // sides would disagree about who is who.
  const pastEntryRows = pastRows.filter((r) => r.name.trim());
  // A player with no buy-in didn't play — the server rejects it, so the form
  // blocks Calculate rather than letting the save fail.
  const pastHasZeroBuyIn = pastEntryRows.some((r) => (Number(r.buyIn) || 0) <= 0);
  const pastPreview: SettlementResult | null =
    pastEntryRows.length >= 2 && !pastHasZeroBuyIn
      ? computeSettlement(
          pastEntryRows.map((r, i) => ({
            userId: r.userId || `unlinked:${i}:${r.name.trim()}`,
            userDisplayName: r.name.trim(),
            buyIn: Number(r.buyIn) || 0,
            cashOut: Number(r.cashOut) || 0,
          })),
          clubSettlementSettings,
          { currentPotBalance: club.clubPotBalance ?? 0, mismatchAcknowledged: pastMismatchAcknowledged }
        )
      : null;

  // Any edit invalidates a calculated preview — the admin must re-run it
  // before the record button unlocks again.
  useEffect(() => {
    setPastCalculated(false);
    setPastConfirming(false);
  }, [JSON.stringify(pastRows), pastDate]);

  const preview = calculateSettlement();
  const allCashOutsEntered = activeSession ? settlementUids.every(uid => uid in cashOutInputs) : false;

  // Opens the Cashout table pre-populated with each player's approved
  // buy-in total (still editable from there to correct any discrepancy).
  //
  // Both maps must be keyed on settlementUids, not activePlayerUids: someone
  // who stood up has already left activePlayerUids but still settles. Seeding
  // from the smaller set left their buy-in blank, which submits as 0 — the
  // server takes the form's buy-in at face value, so their whole bank would
  // vanish and they'd be credited the profit of a player who bought in for
  // nothing. Their confirmed cash-out has to be seeded here too, since
  // resetting the map to {} drops it and the effect that injects it only
  // reruns when the cash-outs themselves change — leaving "Calculate"
  // permanently disabled on any night where someone stood up.
  const openCashoutModal = () => {
    if (!activeSession) {
      pushToast('No live session', 'There is nothing running right now.', 'warning');
      return;
    }
    const initialBuyIns: Record<string, number> = {};
    settlementUids.forEach(uid => {
      initialBuyIns[uid] = activeSessionBuyIns.filter(r => r.userId === uid).reduce((sum, r) => sum + r.amount, 0);
    });
    setBuyInInputs(initialBuyIns);
    setCashOutInputs({ ...confirmedCashOutByUid });
    setManualWinnerInputs({});
    setMismatchAcknowledged(false);
    setSettlementError('');
    setSettlementSuccess('');
    setCashoutCalculated(false); setConfirmingSettle(false);
    setShowCashoutModal(true);
  };

  // Commit Session Settlement — server recomputes the settlement math
  // authoritatively inside one transaction (this client-side `preview` is
  // just what the admin sees while entering buy-in/cash-out amounts).
  const handleSettleSession = async () => {
    // Named rather than silent. These are the last two bare returns on this
    // screen; the pass in 26f847b matched three exact patterns and this longer
    // condition was not one of them, so a stale precondition here looked exactly
    // like a dead Confirm button.
    if (!isAdmin) {
      pushToast('Not allowed', 'Only a Club Admin can settle a session.', 'warning');
      return;
    }
    if (!activeSession) {
      pushToast('No live session', 'There is nothing to settle right now.', 'warning');
      return;
    }
    // Mirrors offlineSessions.service.ts:588. The past-night modal already
    // gates this client-side; this one did not, so a single-player session
    // reached the server and came back as a generic failure.
    if (settlementUids.length < 2) {
      pushToast('Not enough players', 'A session needs at least two players to settle.', 'warning');
      return;
    }
    if (!allCashOutsEntered) {
      pushToast('Missing cash-outs', 'Enter a cash-out for every player before settling.', 'warning');
      return;
    }
    if (!cashoutCalculated || !preview) {
      pushToast('Calculate first', 'Run the numbers so you can check them before settling.', 'warning');
      return;
    }
    if (preview.requiresManualResolution) {
      pushToast(
        'Mismatch not acknowledged',
        'The cash-outs do not match the buy-ins. Tick the acknowledgement to continue.',
        'warning'
      );
      return;
    }
    setSettlementError('');
    setSettlementSuccess('');

    try {
      const entries = settlementUids.map(uid => ({
        userId: uid,
        buyIn: Number(buyInInputs[uid] || 0),
        cashOut: Number(cashOutInputs[uid] || 0),
        manualWinner: manualWinnerInputs[uid],
      }));
      await offlineSessionsApi.settleSession(club.id, activeSession.id, { entries, mismatchAcknowledged });
      await Promise.all([refreshActiveSession(), refreshHistory(), refreshLeaderboard(), refreshPotLog(), refreshClub()]);
      setSettlementSuccess('🎉 Session successfully settled! Financial transactions recorded & Club Pot updated.');
      setShowCashoutModal(false);
    } catch (err) {
      // The server's message is the useful part — "a session needs at least two
      // players", "session is already settled", "acknowledge the mismatch". The
      // old generic string threw all of that away and sent the admin looking at
      // figures that were fine.
      console.error('Failed to settle session:', err);
      setSettlementError(err instanceof Error ? err.message : 'Failed to settle session. Please check your inputs.');
    }
  };

  // Compile Comprehensive Leaderboard Data (From Settled Cashouts + Historical Paper Records)
  // leaderboardData now comes straight from the server (clubRecordsApi.getLeaderboard),
  // pre-aggregated and access-controlled — see refreshLeaderboard() above.

  /**
   * The club's primary navigation, defined once and rendered in two layouts:
   * a sticky bottom bar below `md`, and a horizontal strip at `md` and above.
   *
   * Previously the bottom bar was the only definition and the whole thing sat
   * inside a `md:hidden` wrapper, so every tab switcher disappeared at 768px.
   * Desktop users could reach Session, History, Ranks and Approvals through no
   * control at all — the tabs rendered, but nothing could select them.
   *
   * Keeping one array means the two layouts cannot drift: a tab added here
   * appears in both, with the same visibility rule and the same badge count.
   */

  /**
   * Double-submit guards for every mutation on this screen.
   *
   * Wrapped by reference rather than by editing each handler, so the bodies are
   * untouched and the diff stays reviewable. useAction keeps the function in a
   * ref, so re-created handler identities do not matter.
   *
   * Actions whose first argument is an id are keyed by it, so approving one
   * player's buy-in does not disable the buttons on everyone else's row.
   */
  const settleAction = useAction(handleSettleSession);
  const startSessionAction = useAction(handleStartSession);
  const joinTableAction = useAction(handleJoinTable);
  const requestSitInAction = useAction(handleRequestSitIn);
  const requestBuyInAction = useAction(handleRequestBuyIn);
  const standUpAction = useAction(handleStandUp);
  const decideSitInAction = useAction(handleDecideSitIn);
  const decideCashOutAction = useAction(handleDecideCashOut);
  const approveBuyInAction = useAction(handleApproveBuyIn);
  const rejectBuyInAction = useAction(handleRejectBuyIn);
  const approveChangeAction = useAction(handleApproveChangeRequest);
  const rejectChangeAction = useAction(handleRejectChangeRequest);
  const restoreSessionAction = useAction(handleRestoreSession);
  const removeMemberAction = useAction(handleRemoveMemberFromClub);
  const promoteAdminAction = useAction(handlePromoteToAdmin);
  const demoteAdminAction = useAction(handleDemoteAdmin);
  const createPastSessionAction = useAction(handleCreatePastSession);

  const pendingBuyInCount = buyInRequests.filter(r => r.status === 'pending').length;
  const pendingApprovalCount =
    pendingBuyInCount + pendingChangeRequests.filter(r => r.status === 'pending').length;

  const navItems = useMemo(
    () =>
      [
        {
          key: 'activeSession',
          label: 'Session',
          desktopLabel: 'Active Session',
          Icon: Play,
          iconClass: 'fill-current',
          badge: pendingBuyInCount,
          visible: true,
          onSelect: () => setActiveTab('activeSession'),
        },
        {
          key: 'history',
          label: 'History',
          desktopLabel: 'History',
          Icon: History,
          badge: 0,
          visible: true,
          onSelect: () => setActiveTab('history'),
        },
        {
          key: 'leaderboard',
          label: 'Ranks',
          desktopLabel: 'Leaderboard',
          Icon: Trophy,
          badge: 0,
          visible: canSeeLeaderboard,
          onSelect: () => setActiveTab('leaderboard'),
        },
        {
          key: 'pendingApprovals',
          label: 'Approve',
          desktopLabel: 'Approvals',
          Icon: ListChecks,
          badge: pendingApprovalCount,
          visible: isAdmin,
          onSelect: () => setActiveTab('pendingApprovals'),
        },
        // Actions rather than tabs — they open a modal, so they never read as
        // selected. Kept in the same array so both layouts stay in step.
        {
          key: 'cashout',
          label: 'Cashout',
          desktopLabel: 'Cash Out',
          Icon: Sliders,
          badge: 0,
          visible: isAdmin && !!activeSession,
          isAction: true,
          onSelect: openCashoutModal,
        },
        {
          key: 'profile',
          label: 'Profile',
          desktopLabel: 'Profile',
          Icon: UserCircle,
          badge: 0,
          visible: true,
          isAction: true,
          onSelect: () => setShowProfileModal(true),
        },
      ].filter(item => item.visible),
    [
      pendingBuyInCount,
      pendingApprovalCount,
      canSeeLeaderboard,
      isAdmin,
      activeSession,
      openCashoutModal,
    ]
  );

  return (
    <div className="min-h-screen bg-bg text-text font-sans flex flex-col">
      
      {/* Top Header */}
      <header className="bg-bg/95 border-b border-line sticky top-0 z-50 backdrop-blur-md px-4 py-3">
        <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-4">
          
          <div className="flex items-center gap-3">
            <button
              onClick={onBackToDashboard}
              className="p-2 bg-surface hover:bg-surface-alt border border-line rounded-xl text-text-muted hover:text-text transition-all cursor-pointer"
              title="Back to Clubs List"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>

            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-base md:text-lg font-black tracking-wider text-text uppercase">
                  {club.name}
                </h1>
                <span className="px-2 py-0.5 bg-surface border border-line text-accent font-mono font-black text-[11px] rounded-lg">
                  Code: #{club.code || (club.name.toLowerCase().includes('texas holdem') ? '0007' : '0007')}
                </span>
                {isAdmin && (
                  <span className="px-2 py-0.5 bg-accent/10 border border-accent text-accent font-extrabold text-[10px] uppercase rounded-full flex items-center gap-1">
                    <ShieldCheck className="w-3 h-3" /> Admin
                  </span>
                )}
                {/* Only shown when something is wrong. A permanent green badge
                    becomes furniture people stop reading; an indicator that
                    appears only on trouble keeps its meaning. */}
                {connection !== 'live' && (
                  <span
                    title={
                      connection === 'offline'
                        ? 'This device is offline — figures may be out of date.'
                        : 'Reconnecting — figures may be out of date until this clears.'
                    }
                    className={`px-2 py-0.5 border font-extrabold text-[10px] uppercase rounded-full flex items-center gap-1.5 ${
                      connection === 'offline'
                        ? 'bg-danger/10 border-danger text-danger'
                        : 'bg-warning/10 border-warning text-warning'
                    }`}
                  >
                    <span className={`w-1.5 h-1.5 rounded-full ${connection === 'offline' ? 'bg-danger' : 'bg-warning animate-pulse'}`} />
                    {connection === 'offline' ? 'Offline' : 'Reconnecting'}
                  </span>
                )}
                {/* Balances display in Chips everywhere, so the cash rate has
                    to be discoverable somewhere or players can't value their
                    stack. Only shown when it isn't the trivial 1:1. */}
                {(club.enableDevaluation ?? false) && (club.devaluationFactor ?? 1) > 1 && (
                  <span className="px-2 py-0.5 bg-surface border border-line text-text-muted font-mono text-[10px] rounded-lg">
                    {club.devaluationFactor} Chips = ₹1
                  </span>
                )}
                <button
                  onClick={() => setShowClubInfoModal(true)}
                  className="p-1 text-text-muted hover:text-accent transition-colors cursor-pointer"
                  title="Club Rules & Info"
                >
                  <Info className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>

          {/* Club Pot Balance & Actions — the pot is club-level bookkeeping, so
              it stays out of the way while a game is actually being played.
              Cashout lives below the Approvals list during a session. */}
          {isAdmin && (!activeSession || club.potEnabled) && (
            <div className="flex flex-wrap items-center gap-3">
              {!activeSession && club.potEnabled && (
                <button
                  onClick={() => setActiveTab('pot')}
                  className="bg-warning/15 hover:bg-warning/25 border border-accent px-3.5 py-1.5 rounded-2xl flex items-center gap-2 transition-colors cursor-pointer"
                  title="View Club Pot Ledger"
                >
                  <Coins className="w-5 h-5 text-accent" />
                  <div className="text-left">
                    <div className="text-[9px] uppercase tracking-widest text-accent font-black">CLUB POT BALANCE</div>
                    <div className="text-xs font-mono font-black text-text">
                      {formatVal(club.clubPotBalance || 0)}
                    </div>
                  </div>
                </button>
              )}

              {!activeSession && (
                <button
                  onClick={() => startSessionAction.run()}
                  disabled={startSessionAction.pending}
                  className="bg-accent hover:bg-accent text-accent-contrast font-black px-3.5 py-2 rounded-xl text-xs uppercase tracking-wider transition-all cursor-pointer flex items-center gap-1.5 shadow"
                >
                  <Plus className="w-4 h-4" /> Start New Session
                </button>
              )}
            </div>
          )}

        </div>
      </header>

      {/* Main Container */}
      {/* pb-40 clears the FAB, which is fixed 80-136px off the bottom — with
          less padding the last control can never be scrolled out from under it. */}
      <main className="flex-grow max-w-7xl w-full mx-auto p-4 md:p-8 space-y-6 pb-40 md:pb-8">

        {/* Desktop navigation. The bottom bar below is hidden at md and up, so
            without this there is no control that can change tabs on a desktop. */}
        <nav className="hidden md:flex items-center gap-1 border-b border-line overflow-x-auto">
          {navItems.map(item => {
            const isSelected = !item.isAction && activeTab === item.key;
            return (
              <button
                key={item.key}
                onClick={item.onSelect}
                aria-current={isSelected ? 'page' : undefined}
                className={`relative flex items-center gap-2 px-4 py-3 text-xs font-bold uppercase tracking-wider whitespace-nowrap transition-colors cursor-pointer border-b-2 -mb-px ${
                  isSelected
                    ? 'text-accent border-accent'
                    : 'text-text-muted border-transparent hover:text-text'
                }`}
              >
                <item.Icon className={`w-4 h-4 ${item.iconClass ?? ''}`} />
                {item.desktopLabel}
                {item.badge > 0 && (
                  <span className="bg-danger text-white font-black text-[10px] min-w-[18px] h-[18px] px-1 rounded-full flex items-center justify-center">
                    {item.badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        <div className="space-y-6">
            

            {/* TAB: MERGED ACTIVE SESSION & BUY-INS */}
            {activeTab === 'activeSession' && (
              <div className="space-y-6">
                {!sessionLoaded ? (
                  <div
                    className="p-8 bg-surface border border-line rounded-3xl space-y-4 shadow-xl animate-pulse"
                    aria-busy="true"
                    aria-label="Loading table"
                  >
                    <div className="h-12 w-12 bg-surface-alt rounded-full mx-auto" />
                    <div className="h-5 w-56 bg-surface-alt rounded mx-auto" />
                    <div className="h-3 w-72 bg-surface-alt rounded mx-auto" />
                    <div className="h-10 w-40 bg-surface-alt rounded-2xl mx-auto mt-2" />
                  </div>
                ) : !activeSession ? (
                  <div className="p-8 bg-surface border border-line rounded-3xl text-center space-y-4 shadow-xl">
                    <Clock className="w-12 h-12 text-text-muted mx-auto opacity-60" />
                    <h3 className="text-lg font-bold text-text uppercase tracking-wide">
                      No Active Poker Session
                    </h3>
                    <p className="text-xs text-text-muted max-w-md mx-auto leading-relaxed">
                      Start a live session to track player banks for this table.
                    </p>
                    {isAdmin ? (
                      <div className="flex items-center justify-center pt-2">
                        <button
                          onClick={() => startSessionAction.run()}
                          disabled={startSessionAction.pending}
                          className="bg-accent hover:bg-accent text-accent-contrast font-black px-5 py-3 rounded-xl text-xs uppercase tracking-widest cursor-pointer shadow-lg transition-all"
                        >
                          Start New Session
                        </button>
                      </div>
                    ) : (
                      <div className="p-3 bg-bg border border-line rounded-2xl text-xs text-warning font-mono inline-block">
                        Waiting for Club Admin to start session...
                      </div>
                    )}
                  </div>
                ) : (
                  <>
                    {/* Active Session Card Header */}
                    <div className="bg-surface border border-line p-6 rounded-3xl space-y-6 shadow-xl">
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-line pb-4">
                        <div>
                          <span className="px-2.5 py-0.5 bg-accent/15 border border-accent/50 text-accent font-bold text-[10px] uppercase rounded-full animate-pulse">
                            ● SESSION ACTIVE
                          </span>
                          <h2 className="text-xl font-black text-text uppercase mt-1">
                            {activeSession.sessionName}
                          </h2>
                        </div>

                        <div className="flex items-center gap-2">
                          {isSeated && !myCashOut && (
                            <button
                              onClick={() => { setStandUpAmount(0); setShowStandUpModal(true); }}
                              className="bg-surface-alt hover:bg-line-strong border border-line-strong text-text font-bold px-4 py-2.5 rounded-xl text-xs uppercase cursor-pointer flex items-center gap-1.5"
                            >
                              <LogOut className="w-4 h-4" /> Stand Up
                            </button>
                          )}
                          {myCashOut?.status === 'pending' && (
                            <span className="border border-dashed border-line-strong text-text-muted font-bold px-4 py-2.5 rounded-xl text-xs uppercase">
                              Cash-out pending…
                            </span>
                          )}
                          {!isSeated && (
                            hasRequestedSitIn ? (
                              <span className="border border-dashed border-line-strong text-text-muted font-bold px-4 py-2.5 rounded-xl text-xs uppercase">
                                Sit-in requested…
                              </span>
                            ) : isAdmin ? (
                              <button
                                onClick={() => joinTableAction.run()}
                                disabled={joinTableAction.pending}
                                className="bg-surface-alt hover:bg-line-strong border border-line-strong text-text font-bold px-4 py-2.5 rounded-xl text-xs uppercase cursor-pointer"
                              >
                                Sit In
                              </button>
                            ) : (
                              <button
                                onClick={() => requestSitInAction.run()}
                                disabled={requestSitInAction.pending}
                                className="bg-accent text-accent-contrast font-black px-4 py-2.5 rounded-xl text-xs uppercase tracking-wider cursor-pointer shadow flex items-center gap-1.5"
                              >
                                <Hand className="w-4 h-4" /> Request to Sit In
                              </button>
                            )
                          )}
                        </div>
                      </div>

                      {/* Players seated around the table */}
                      <div className="space-y-3">
                        <h3 className="text-xs font-bold text-text-muted uppercase tracking-wider flex items-center gap-2">
                          <Users className="w-4 h-4 text-accent" /> Active Players at Table ({activeSession.activePlayerUids.length})
                        </h3>

                        {/* The ceiling moves as the table plays, so it has to be
                            on the table itself — everyone needs to know what
                            they can take without opening the buy-in form. */}
                        <div className="flex items-center justify-between gap-3 px-3.5 py-2.5 bg-bg border border-line rounded-2xl">
                          <span className="text-[10px] font-bold text-text-muted uppercase tracking-wider flex items-center gap-1.5">
                            <Coins className="w-3.5 h-3.5 text-accent" /> Max buy-in
                            <InfoHint>
                              {(club.buyInMode ?? 'MATCH_HIGHEST') === 'UNCAPPED'
                                ? 'This club sets no ceiling — players agree limits between themselves.'
                                : 'You can take up to the biggest bank at the table. Taking the maximum makes your bank the new reference.'}
                            </InfoHint>
                          </span>
                          <span className="text-sm font-mono font-black text-accent whitespace-nowrap">
                            {buyInCeiling === null ? 'No limit' : formatVal(buyInCeiling)}
                          </span>
                        </div>

                        {activeSession.activePlayerUids.length === 0 && pendingSitInUids.length === 0 ? (
                          <p className="text-xs text-text-muted py-2">No players have joined the table yet.</p>
                        ) : (
                          <PokerTableRing
                            players={[
                              ...activeSession.activePlayerUids.map(uid => ({
                                uid,
                                name: uid === currentUser.uid
                                  ? 'Me'
                                  : (allUsers[uid]?.displayName || `Player (${uid.slice(0, 5)})`),
                                bank: activeSessionBuyIns
                                  .filter(r => r.userId === uid)
                                  .reduce((sum, r) => sum + r.amount, 0),
                              })),
                              ...pendingSitInUids.map(uid => ({
                                uid,
                                name: uid === currentUser.uid
                                  ? 'Me'
                                  : (allUsers[uid]?.displayName || `Player (${uid.slice(0, 5)})`),
                                bank: 0,
                                pending: true,
                              })),
                            ]}
                            formatBank={formatVal}
                            onRequestBankFor={(uid) => {
                              setBuyInTargetUser(uid);
                              setBuyInAmount(club.minBuyIn || 1000);
                              setShowBuyInModal(true);
                            }}
                          />
                        )}
                      </div>

                      {isAdmin && pendingCashOuts.length > 0 && (
                        <div className="space-y-2 border-t border-line pt-4">
                          <h3 className="text-xs font-bold text-text uppercase tracking-wider">
                            Cash-outs to Confirm ({pendingCashOuts.length})
                          </h3>
                          {pendingCashOuts.map((c) => (
                            <div key={c.userId} className="p-3 bg-bg border border-line rounded-2xl space-y-2">
                              <div className="text-xs text-text">
                                <span className="font-bold">
                                  {c.userId === currentUser.uid ? 'You' : (allUsers[c.userId]?.displayName || 'Player')}
                                </span>
                                <span className="text-text-muted"> is standing up with </span>
                                <span className="font-mono font-black text-accent">{formatVal(c.amount)}</span>
                              </div>
                              <p className="text-[10px] text-text-muted">
                                Count their chips before confirming — this figure is locked into the settlement.
                              </p>
                              <div className="flex items-center gap-2">
                                <button
                                  onClick={() => decideCashOutAction.run(c.userId, true)}
                                  disabled={decideCashOutAction.isPending(c.userId)}
                                  className="flex-1 px-3 py-1.5 rounded-xl text-xs font-bold uppercase tracking-wider bg-accent text-accent-contrast cursor-pointer flex items-center justify-center gap-1"
                                >
                                  <Check className="w-3 h-3" /> Confirm
                                </button>
                                <button
                                  onClick={() => decideCashOutAction.run(c.userId, false)}
                                  disabled={decideCashOutAction.isPending(c.userId)}
                                  className="flex-1 px-3 py-1.5 rounded-xl text-xs font-bold uppercase tracking-wider bg-danger/15 border border-danger/40 text-danger cursor-pointer flex items-center justify-center gap-1"
                                >
                                  <X className="w-3 h-3" /> Reject
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Sit-in requests waiting on an admin */}
                      {isAdmin && pendingSitInUids.length > 0 && (
                        <div className="space-y-2 border-t border-line pt-4">
                          <h3 className="text-xs font-bold text-text uppercase tracking-wider">
                            Sit-in Requests ({pendingSitInUids.length})
                          </h3>
                          {pendingSitInUids.map(uid => (
                            <div key={uid} className="p-3 bg-bg border border-line rounded-2xl flex items-center justify-between gap-3">
                              <span className="text-xs font-bold text-text">
                                {allUsers[uid]?.displayName || `Player (${uid.slice(0, 6)})`}
                                <span className="text-text-muted font-normal ml-2">wants to be dealt in</span>
                              </span>
                              <div className="flex items-center gap-2 shrink-0">
                                <button
                                  onClick={() => decideSitInAction.run(uid, true)}
                                  disabled={decideSitInAction.isPending(uid)}
                                  className="px-3 py-1.5 rounded-xl text-xs font-bold uppercase tracking-wider bg-accent text-accent-contrast cursor-pointer flex items-center gap-1"
                                >
                                  <Check className="w-3 h-3" /> Seat
                                </button>
                                <button
                                  onClick={() => decideSitInAction.run(uid, false)}
                                  disabled={decideSitInAction.isPending(uid)}
                                  className="px-3 py-1.5 rounded-xl text-xs font-bold uppercase tracking-wider bg-danger/15 border border-danger/40 text-danger cursor-pointer flex items-center gap-1"
                                >
                                  <X className="w-3 h-3" /> Decline
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Integrated Buy-ins Dashboard (ONLY SHOWN WHEN SESSION IS ACTIVE) */}
                    <div className="bg-surface border border-line p-6 rounded-3xl space-y-4 shadow-xl">
                      <div className="flex items-center justify-between border-b border-line pb-3">
                        <div>
                          <h2 className="text-base font-bold text-text uppercase tracking-wider flex items-center gap-2">
                            <DollarSign className="w-5 h-5 text-accent" /> {isAdmin ? 'Approvals' : 'My Buy-ins'}
                            <InfoHint>
                              {isAdmin
                                ? 'Buy-ins waiting on you. Chips only count toward a player&apos;s stack once approved.'
                                : 'Your buy-in requests. Chips only count toward your stack once an admin approves them.'}
                            </InfoHint>
                          </h2>
                        </div>
                      </div>

                      {/* Pending Requests List */}
                      <div className="space-y-3">
                        <h3 className="text-xs font-bold text-text uppercase tracking-wider">
                          {isAdmin ? 'Pending Approvals' : 'Awaiting Approval'} ({visiblePendingBuyIns.length})
                        </h3>

                        {visiblePendingBuyIns.length === 0 ? (
                          <p className="text-xs text-text-muted py-2">
                            {isAdmin ? 'Nothing waiting on you right now.' : "You have no buy-ins waiting. Use the + button to ask for chips."}
                          </p>
                        ) : (
                          <div className="space-y-2">
                            {visiblePendingBuyIns.map(req => {
                              const isSelfRequest = req.requestedBy === currentUser.uid;
                              const otherAdmins = (club.adminUids || []).filter(u => u !== currentUser.uid && u !== club.ownerUid && u !== club.createdBy);
                              const hasOtherAdmins = otherAdmins.length > 0;
                              const cannotSelfApprove = isSelfRequest && !isOwner && !isSuperUser && hasOtherAdmins;

                              return (
                                <div key={req.id} className="p-4 bg-bg border border-line rounded-2xl flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                                  <div>
                                    <div className="text-xs font-bold text-text flex items-center gap-2">
                                      {allUsers[req.userId]?.displayName || 'Player'}
                                      <span className="text-warning font-mono text-sm">
                                        {formatVal(req.amount)}
                                      </span>
                                    </div>
                                    <div className="text-[10px] text-text-muted">
                                      Requested at: {new Date(req.createdAt).toLocaleTimeString()}
                                    </div>

                                    {/* ADMIN SELF-APPROVAL WARNING BADGE */}
                                    {cannotSelfApprove && (
                                      <span className="mt-1 inline-flex items-center gap-1 text-[10px] font-bold text-warning bg-warning/80 border border-warning/40 px-2 py-0.5 rounded-full">
                                        <ShieldAlert className="w-3 h-3" /> Multi-Admin rule: Requires another Admin to approve
                                      </span>
                                    )}
                                  </div>

                                  {isAdmin && (
                                    <div className="flex items-center gap-2">
                                      <button
                                        onClick={() => approveBuyInAction.run(req)}
                                        disabled={cannotSelfApprove || approveBuyInAction.pending}
                                        className={`px-3 py-1.5 rounded-xl text-xs font-bold uppercase tracking-wider transition-all flex items-center gap-1 ${
                                          cannotSelfApprove 
                                            ? 'bg-surface-alt text-text-faint cursor-not-allowed border border-line-strong'
                                            : 'bg-accent hover:bg-accent text-accent-contrast cursor-pointer shadow'
                                        }`}
                                        title={cannotSelfApprove ? "Another Club Admin must approve your request" : "Approve Bank"}
                                      >
                                        <Check className="w-3.5 h-3.5" /> Approve
                                      </button>

                                      <button
                                        onClick={() => rejectBuyInAction.run(req)}
                                        disabled={rejectBuyInAction.pending}
                                        className="bg-danger/15 hover:bg-danger/25 border border-danger/40 text-danger font-bold px-3 py-1.5 rounded-xl text-xs uppercase cursor-pointer flex items-center gap-1"
                                      >
                                        <X className="w-3.5 h-3.5" /> Reject
                                      </button>
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>

                      {/* Approved / Rejected History */}
                      <div className="pt-4 border-t border-line space-y-3">
                        <h3 className="text-xs font-bold text-text uppercase tracking-wider">
                          {isAdmin ? 'Processed Buy-ins History' : 'My Past Buy-ins'}
                        </h3>

                        {visibleProcessedBuyIns.length === 0 && (
                          <p className="text-xs text-text-muted py-1">
                            {isAdmin ? 'Nothing decided yet this session.' : 'None yet this session.'}
                          </p>
                        )}

                        <div className="space-y-2">
                          {visibleProcessedBuyIns.slice(0, 10).map(req => (
                            <div key={req.id} className="p-3 bg-bg border border-line rounded-xl flex items-center justify-between text-xs font-mono">
                              <div>
                                <span className="font-bold text-text">{allUsers[req.userId]?.displayName || 'Player'}</span>
                                <span className="text-text-muted ml-2">{formatVal(req.amount)}</span>
                              </div>
                              <div>
                                {req.status === 'approved' ? (
                                  <span className="text-accent font-bold">Approved</span>
                                ) : (
                                  <span className="text-danger font-bold">Rejected</span>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>

                    {/* Settling up closes out the night, so it sits at the very
                        bottom — after everything that happens during play. */}
                    {isAdmin && (
                      <button
                        onClick={openCashoutModal}
                        className="w-full bg-accent text-accent-contrast font-black px-4 py-4 rounded-3xl text-sm uppercase tracking-wider transition-all cursor-pointer flex items-center justify-center gap-2 shadow-xl"
                      >
                        <Sliders className="w-5 h-5" /> Cashout
                      </button>
                    )}
                  </>
                )}
              </div>
            )}


            {/* GAME HISTORY */}
            {activeTab === 'history' && (
              <div className="space-y-6">
                {/* Historical Sessions (Chronological Day Sessions) */}
                <div className="bg-bg/80 border border-line/80 p-4 sm:p-6 rounded-3xl space-y-4 shadow-2xl backdrop-blur-sm">
                  <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line/60 pb-3">
                    <div>
                      <h2 className="text-base sm:text-lg font-bold text-text uppercase tracking-wider flex items-center gap-2">
                        <History className="w-5 h-5 text-accent" /> Session History
                        <InfoHint>
                          Every settled night, locked once it's been cashed out. Tap a row to see who played and what they made.
                        </InfoHint>
                      </h2>
                    </div>

                    <div className="flex items-center gap-2">
                      {currencyToggle}
                      {(isOwner || isSuperUser) && (
                        <button
                          onClick={() => setShowPastSessionModal(true)}
                          className="text-xs font-bold bg-accent/15 text-accent border border-accent/40 px-3 py-1.5 rounded-xl hover:bg-accent/25 transition-colors flex items-center gap-1.5"
                        >
                          <CalendarPlus className="w-3.5 h-3.5" /> Record a past night
                        </button>
                      )}
                      <div className="text-xs text-text-muted font-mono font-bold bg-bg border border-line/60 px-3 py-1.5 rounded-xl">
                        Completed Sessions: <span className="text-accent">{normalizedSessions.length}</span>
                      </div>
                    </div>
                  </div>

                  {normalizedSessions.length === 0 ? (
                    <div className="text-center py-10 space-y-2">
                      <p className="text-xs text-text-muted">No completed poker sessions recorded in this club yet.</p>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      {normalizedSessions.map((session, index) => {
                        // Every row starts collapsed — no auto-expanded first
                        // entry, so the list reads as a scannable summary.
                        const isExpanded = expandedSessionId === session.id;

                        return (
                          <div key={session.id} className="bg-surface border border-line/70 rounded-2xl overflow-hidden transition-all shadow-md">
                            {/* Card Header */}
                            <div
                              onClick={() => setExpandedSessionId(isExpanded ? null : session.id)}
                              className="p-4 sm:p-5 flex items-center justify-between gap-3 cursor-pointer hover:bg-surface transition-colors"
                            >
                              <div className="space-y-0.5 min-w-0">
                                <div className="text-xs text-text-muted font-sans">
                                  {session.date ? new Date(session.date).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : '—'}
                                </div>
                                <span className="font-extrabold text-text text-base sm:text-lg font-mono tracking-wide">
                                  Session {sessionNumberById.get(String(session.id)) ?? '?'}
                                </span>
                                {session.dayTitle && (
                                  <div className="text-[10px] text-text-faint truncate">{session.dayTitle}</div>
                                )}
                                {/* Progressive disclosure: collapsed shows the
                                    viewer their own result for the night, and
                                    expanding trades it for the per-player
                                    breakdown plus the edit/delete controls.
                                    Nothing is shown for a night you sat out. */}
                                {!isExpanded && (() => {
                                  const mine = session.playerStats.find((p) => p.userId === currentUser.uid);
                                  if (!mine) return null;
                                  return (
                                    <div className={`text-[11px] font-mono font-bold pt-0.5 ${
                                      mine.profit >= 0 ? 'text-accent' : 'text-danger'
                                    }`}>
                                      {formatSignedUnit(mine.profit)}
                                    </div>
                                  );
                                })()}
                              </div>

                              <div className="flex items-center gap-1 shrink-0" onClick={e => e.stopPropagation()}>
                                {isAdmin && isExpanded && (
                                  <>
                                    <button
                                      type="button"
                                      onClick={() => handleOpenEditSession(session)}
                                      className="p-1.5 bg-surface hover:bg-surface-alt border border-line text-text-muted hover:text-accent rounded-lg cursor-pointer transition-colors"
                                      title="Edit Session Date / Notes / Player Stats"
                                    >
                                      <Pencil className="w-3.5 h-3.5" />
                                    </button>

                                    <button
                                      type="button"
                                      onClick={() => handleDeleteSessionRequest(session)}
                                      className="p-1.5 bg-surface hover:bg-surface-alt border border-line text-text-muted hover:text-danger rounded-lg cursor-pointer transition-colors"
                                      title="Delete Session Record"
                                    >
                                      <Trash2 className="w-3.5 h-3.5" />
                                    </button>
                                  </>
                                )}

                                <button
                                  type="button"
                                  onClick={() => setExpandedSessionId(isExpanded ? null : session.id)}
                                  className="p-1.5 text-text-muted hover:text-text transition-colors"
                                >
                                  {isExpanded ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
                                </button>
                              </div>
                            </div>

                            {/* Player Breakdown */}
                            {isExpanded && (
                              <div className="border-t border-line/60 bg-surface px-4 sm:px-6 py-2">
                                {!isAdmin && session.playerStats.length === 0 ? (
                                  <p className="py-4 text-xs text-text-muted text-center font-sans">You didn't play this session.</p>
                                ) : (
                                <div className="divide-y divide-line/40">
                                  {session.playerStats.map((ps, idx) => (
                                    <div key={idx} className="py-3 space-y-1.5 text-xs sm:text-sm">
                                      <div className="flex items-center justify-between">
                                        <div className="font-bold text-text text-sm sm:text-base font-sans">{ps.name}</div>
                                        <div className={`font-mono font-black text-sm sm:text-base tracking-tight ${
                                          ps.profit >= 0 ? 'text-accent' : 'text-danger'
                                        }`}>
                                          {formatSignedUnit(ps.profit)}
                                        </div>
                                      </div>
                                      <div className="flex items-center justify-between font-mono">
                                        <div>
                                          <div className="text-[9px] uppercase tracking-wider text-text-faint">Bank</div>
                                          <div className="text-[11px] sm:text-xs text-text-muted">{formatUnit(ps.buyIn)}</div>
                                        </div>
                                        <div className="text-right">
                                          <div className="text-[9px] uppercase tracking-wider text-text-faint">Cashout</div>
                                          <div className="text-[11px] sm:text-xs text-text-muted">{formatUnit(ps.cashOut)}</div>
                                        </div>
                                      </div>
                                    </div>
                                  ))}
                                </div>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* PENDING APPROVALS SCREEN (ADMIN ONLY) */}
            {activeTab === 'pendingApprovals' && isAdmin && (
              <div className="space-y-6">
                <div className="bg-surface border border-line p-6 rounded-3xl space-y-6 shadow-xl">
                  <div className="border-b border-line pb-4 flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h2 className="text-lg font-black text-accent uppercase flex items-center gap-2">
                        <ListChecks className="w-5 h-5" /> Approvals
                        <InfoHint>
                          Buy-ins and session edits waiting on an admin. In clubs with two or more admins, you can't approve your own request — someone else has to.
                        </InfoHint>
                      </h2>
                    </div>

                    <div className="px-3 py-1 bg-bg border border-line text-warning text-xs font-mono font-bold rounded-xl flex items-center gap-1.5">
                      <ShieldCheck className="w-4 h-4 text-accent" /> Total Club Admins: {totalAdminsCount}
                    </div>
                  </div>

                  {/* SECTION 1: PENDING BANK BUY-INS */}
                  <div className="space-y-3">
                    <h3 className="text-xs font-bold text-text uppercase tracking-wider flex items-center gap-2">
                      <Coins className="w-4 h-4 text-warning" /> Pending Buy-Ins ({buyInRequests.filter(r => r.status === 'pending').length})
                    </h3>

                    {buyInRequests.filter(r => r.status === 'pending').length === 0 ? (
                      <p className="text-xs text-text-muted py-2 bg-bg p-4 rounded-2xl border border-line/60">
                        No pending player buy-in requests currently.
                      </p>
                    ) : (
                      <div className="space-y-2">
                        {buyInRequests.filter(r => r.status === 'pending').map(req => {
                          const isSelfRequest = req.requestedBy === currentUser.uid;
                          const otherAdmins = (club.adminUids || []).filter(u => u !== currentUser.uid && u !== club.ownerUid && u !== club.createdBy);
                          const hasOtherAdmins = otherAdmins.length > 0;
                          const cannotSelfApprove = isSelfRequest && !isOwner && !isSuperUser && hasOtherAdmins;

                          return (
                            <div key={req.id} className="p-4 bg-bg border border-line rounded-2xl flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                              <div>
                                <div className="text-xs font-bold text-text flex items-center gap-2">
                                  {allUsers[req.userId]?.displayName || 'Player'}
                                  <span className="text-warning font-mono text-sm">
                                    {formatVal(req.amount)}
                                  </span>
                                </div>
                                <div className="text-[10px] text-text-muted font-mono mt-0.5">
                                  Requested at: {new Date(req.createdAt).toLocaleTimeString()}
                                </div>

                                {cannotSelfApprove && (
                                  <span className="mt-1 inline-flex items-center gap-1 text-[10px] font-bold text-warning bg-warning/80 border border-warning/40 px-2 py-0.5 rounded-full">
                                    <ShieldAlert className="w-3 h-3" /> Requires another Admin to approve (Cannot self-approve)
                                  </span>
                                )}
                              </div>

                              <div className="flex items-center gap-2">
                                <button
                                  onClick={() => approveBuyInAction.run(req)}
                                  disabled={cannotSelfApprove || approveBuyInAction.pending}
                                  className={`px-3.5 py-2 rounded-xl text-xs font-bold uppercase tracking-wider transition-all flex items-center gap-1 ${
                                    cannotSelfApprove
                                      ? 'bg-surface-alt text-text-faint cursor-not-allowed border border-line-strong'
                                      : 'bg-accent hover:bg-accent text-accent-contrast cursor-pointer shadow'
                                  }`}
                                >
                                  <Check className="w-3.5 h-3.5" /> Approve
                                </button>

                                <button
                                  onClick={() => rejectBuyInAction.run(req)}
                                  disabled={rejectBuyInAction.pending}
                                  className="bg-danger/15 hover:bg-danger/25 border border-danger/40 text-danger font-bold px-3 py-2 rounded-xl text-xs uppercase cursor-pointer flex items-center gap-1"
                                >
                                  <X className="w-3.5 h-3.5" /> Reject
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* SECTION 2: PENDING SESSION EDITS & DELETIONS */}
                  <div className="space-y-3 pt-4 border-t border-line">
                    <h3 className="text-xs font-bold text-text uppercase tracking-wider flex items-center gap-2">
                      <FileEdit className="w-4 h-4 text-accent" /> Pending Session Edits & Deletions ({pendingChangeRequests.filter(r => r.status === 'pending').length})
                    </h3>

                    {pendingChangeRequests.filter(r => r.status === 'pending').length === 0 ? (
                      <p className="text-xs text-text-muted py-2 bg-bg p-4 rounded-2xl border border-line/60">
                        No pending session change proposals awaiting approval.
                      </p>
                    ) : (
                      <div className="space-y-3">
                        {pendingChangeRequests.filter(r => r.status === 'pending').map(req => {
                          const isSelfRequest = req.requestedBy === currentUser.uid;
                          const otherAdmins = (club.adminUids || []).filter(u => u !== currentUser.uid && u !== club.ownerUid && u !== club.createdBy);
                          const hasOtherAdmins = otherAdmins.length > 0;
                          const cannotSelfApprove = isSelfRequest && !isOwner && !isSuperUser && hasOtherAdmins;

                          return (
                            <div key={req.id} className="p-4 bg-bg border border-line rounded-2xl space-y-3">
                              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-line/60 pb-2">
                                <div>
                                  <div className="flex items-center gap-2">
                                    <span className="text-sm font-black text-text font-mono">{req.sessionTitle}</span>
                                    <span className={`px-2 py-0.5 font-bold text-[10px] uppercase rounded-full ${
                                      req.requestType === 'delete_session' 
                                        ? 'bg-danger/15 text-danger border border-danger/40' 
                                        : 'bg-warning/15 text-warning border border-warning/40'
                                    }`}>
                                      {req.requestType === 'delete_session' ? 'Deletion Request' : 'Edit Request'}
                                    </span>
                                  </div>
                                  <p className="text-[11px] text-text-muted mt-0.5">
                                    Requested by: <strong className="text-text">{req.requestedByName}</strong> on {new Date(req.requestedAt).toLocaleString()}
                                  </p>
                                </div>

                                <div className="flex items-center gap-2">
                                  <button
                                    onClick={() => approveChangeAction.run(req)}
                                    disabled={cannotSelfApprove || approveChangeAction.pending}
                                    className={`px-3.5 py-2 rounded-xl text-xs font-bold uppercase tracking-wider transition-all flex items-center gap-1 ${
                                      cannotSelfApprove
                                        ? 'bg-surface-alt text-text-faint cursor-not-allowed border border-line-strong'
                                        : 'bg-accent hover:bg-accent text-accent-contrast cursor-pointer shadow'
                                    }`}
                                    title={cannotSelfApprove ? "Another Club Admin must approve your proposal" : "Approve Proposal"}
                                  >
                                    <Check className="w-3.5 h-3.5" /> Approve
                                  </button>

                                  <button
                                    onClick={() => rejectChangeAction.run(req)}
                                    disabled={rejectChangeAction.pending}
                                    className="bg-danger/15 hover:bg-danger/25 border border-danger/40 text-danger font-bold px-3.5 py-2 rounded-xl text-xs uppercase cursor-pointer flex items-center gap-1"
                                  >
                                    <X className="w-3.5 h-3.5" /> Reject
                                  </button>
                                </div>
                              </div>

                              {/* Changes Breakdown */}
                              {req.changes && req.changes.length > 0 && (
                                <div className="bg-surface p-3 rounded-xl space-y-1 font-mono text-xs">
                                  <div className="text-[10px] text-text-muted uppercase font-bold">Proposed Modifications:</div>
                                  {req.changes.map((c, idx) => (
                                    <div key={idx} className="flex items-center gap-2 text-text-muted">
                                      <span className="text-accent">{c.field}:</span>
                                      <span className="line-through text-text-faint">{c.oldValue || 'None'}</span>
                                      <span>➜</span>
                                      <span className="text-accent font-bold">{c.newValue}</span>
                                    </div>
                                  ))}
                                </div>
                              )}

                              {cannotSelfApprove && (
                                <p className="text-[10px] text-warning font-bold flex items-center gap-1">
                                  <ShieldAlert className="w-3 h-3" /> Multi-Admin Policy: Your proposal requires confirmation from a different Club Admin.
                                </p>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* AUDIT TRAIL & SYSTEM LOGS (OWNER & SUPER USER ONLY) */}
            {activeTab === 'auditTrail' && (isOwner || isSuperUser) && (
              <div className="space-y-6">
                <div className="bg-surface border border-line p-6 rounded-3xl space-y-6 shadow-xl">
                  <div className="border-b border-line pb-4 flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h2 className="text-lg font-black text-text uppercase flex items-center gap-2">
                        <FileCheck className="w-5 h-5 text-accent" /> Audit Trail & Security Logs
                      </h2>
                      <p className="text-xs text-text-muted mt-1">
                        Permanent immutable log of historical session edits, approvals, rejections, soft deletions, and session restorations.
                      </p>
                    </div>

                    <span className="px-3 py-1 bg-warning/80 border border-warning/40 text-warning font-bold text-xs rounded-xl flex items-center gap-1">
                      <Lock className="w-3.5 h-3.5 text-warning" /> Restrict Access: Owner & Super User
                    </span>
                  </div>

                  {/* SOFT-DELETED SESSIONS RECOVERY */}
                  <div className="space-y-3">
                    <h3 className="text-xs font-bold text-text uppercase tracking-wider flex items-center gap-2">
                      <RotateCcw className="w-4 h-4 text-warning" /> Soft-Deleted Sessions ({deletedSessions.length})
                    </h3>

                    {deletedSessions.length === 0 ? (
                      <p className="text-xs text-text-muted bg-bg p-4 rounded-2xl border border-line">
                        No soft-deleted sessions found in archive.
                      </p>
                    ) : (
                      <div className="space-y-2 font-mono">
                        {deletedSessions.map(item => (
                          <div key={item.id} className="p-3.5 bg-bg border border-line rounded-2xl flex items-center justify-between text-xs">
                            <div>
                              <span className="font-bold text-danger line-through">{item.title}</span>
                            </div>

                            <button
                              onClick={() => restoreSessionAction.run(item.id, item.sourceType, item.title)}
                              disabled={restoreSessionAction.isPending(item.id)}
                              className="px-3 py-1.5 bg-accent hover:bg-accent text-accent-contrast font-sans font-bold text-xs uppercase rounded-xl cursor-pointer flex items-center gap-1 shadow"
                            >
                              <RotateCcw className="w-3.5 h-3.5" /> Restore Session
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* AUDIT LOG FEED */}
                  <div className="space-y-3 pt-4 border-t border-line">
                    <h3 className="text-xs font-bold text-text uppercase tracking-wider">
                      Immutable Log History ({auditLogs.length})
                    </h3>

                    {auditLogs.length === 0 ? (
                      <p className="text-xs text-text-muted bg-bg p-4 rounded-2xl border border-line">
                        No audit log entries logged yet.
                      </p>
                    ) : (
                      <div className="space-y-2 font-mono max-h-96 overflow-y-auto pr-1">
                        {auditLogs.map(log => (
                          <div key={log.id} className="p-3.5 bg-bg border border-line rounded-2xl space-y-1 text-xs">
                            <div className="flex flex-wrap items-center justify-between text-[11px] text-text-muted">
                              <span className="font-bold text-accent uppercase">{log.action}</span>
                              <span>{new Date(log.createdAt).toLocaleString()}</span>
                            </div>
                            <div className="text-text font-bold">{log.sessionTitle}</div>
                            <div className="text-[10px] text-text-muted">
                              Actor: {log.changedByName} {log.approvedByName ? `| Approved by: ${log.approvedByName}` : ''}
                            </div>
                            {log.details && (
                              <div className="text-[11px] text-text-muted italic font-sans">{log.details}</div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* LEADERBOARD & HISTORICAL PAPER RECORDS */}
            {activeTab === 'leaderboard' && canSeeLeaderboard && (
              <div className="space-y-6">
                <div className="bg-surface border border-line p-6 md:p-8 rounded-3xl space-y-6 shadow-xl">
                  
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-line pb-4">
                    <div>
                      <h2 className="text-lg font-black text-text uppercase flex items-center gap-2">
                        <Trophy className="w-5 h-5 text-accent" /> Club Leaderboard & Historical Statistics
                      </h2>
                      <p className="text-xs text-text-muted">
                        Overall standings compiled from settled sessions and historical player records.
                      </p>
                    </div>
                    {currencyToggle}
                  </div>

                  {/* Leaderboard Mobile Cards (< sm) */}
                  <div className="sm:hidden space-y-3 font-mono">
                    {leaderboardData.map((player, idx) => {
                      const isTop3 = idx < 3;
                      const crownBadge = idx === 0 ? '🥇 1st' : idx === 1 ? '🥈 2nd' : idx === 2 ? '🥉 3rd' : `#${idx + 1}`;
                      
                      return (
                        <div 
                          key={player.name} 
                          className={`p-4 bg-bg border rounded-2xl space-y-3 ${
                            isTop3 ? 'border-accent/80 bg-surface' : 'border-line'
                          }`}
                        >
                          <div className="flex items-center justify-between border-b border-line/60 pb-2">
                            <div className="flex items-center gap-2">
                              <span className={`px-2.5 py-0.5 rounded-full text-xs font-black uppercase tracking-wider ${
                                idx === 0 ? 'bg-warning/20 text-accent border border-accent' :
                                idx === 1 ? 'bg-line-strong/20 text-text-muted border border-line-strong' :
                                idx === 2 ? 'bg-warning/20 text-warning border border-warning/50' :
                                'bg-surface text-text-muted'
                              }`}>
                                {crownBadge}
                              </span>
                              <span className="font-bold text-text text-sm">{player.name}</span>
                            </div>

                            <div className={`text-sm font-black ${player.netProfit >= 0 ? 'text-accent' : 'text-danger'}`}>
                              {formatSignedUnit(player.netProfit)}
                            </div>
                          </div>

                          {/* Rank and profit/loss only — the leaderboard is a
                              standings board, not a disclosure of how much
                              everyone else puts on the table. */}
                        </div>
                      );
                    })}
                  </div>

                  {/* Leaderboard Desktop Table (>= sm) */}
                  <div className="hidden sm:block overflow-x-auto">
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="border-b border-line text-text-muted uppercase font-mono text-[10px]">
                          <th className="py-3 px-2">Rank</th>
                          <th className="py-3 px-2">Player</th>
                          <th className="py-3 px-2">Profit / Loss</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-line font-mono">
                        {leaderboardData.map((player, idx) => (
                          <tr key={player.name} className="hover:bg-bg/50 transition-colors">
                            <td className="py-3.5 px-2 font-black text-accent">
                              #{idx + 1}
                            </td>
                            <td className="py-3.5 px-2 font-bold text-text">
                              {player.name}
                            </td>
                            <td className={`py-3.5 px-2 font-black text-xs ${player.netProfit >= 0 ? 'text-accent' : 'text-danger'}`}>
                              {formatSignedUnit(player.netProfit)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                </div>
              </div>
            )}

            {/* TAB: CLUB POT LEDGER (ADMIN ONLY) */}
            {activeTab === 'pot' && isAdmin && club.potEnabled && (
              <div className="space-y-6">
                <div className="bg-surface border border-line p-6 rounded-3xl space-y-4 shadow-xl">
                  <div className="border-b border-line pb-3">
                    <h2 className="text-base font-bold text-text uppercase tracking-wider flex items-center gap-2">
                      <Coins className="w-5 h-5 text-accent" /> Club Pot Ledger & Transactions (Admin Only)
                    </h2>
                    <p className="text-xs text-text-muted">
                      Accumulated from fixed rake (₹1,000/game), 5% winner's cut, and buy-in excess leftovers.
                    </p>
                  </div>

                  <div className="space-y-2">
                    {potLogs.map(log => (
                      <div key={log.id} className="p-3 bg-bg border border-line rounded-xl flex items-center justify-between text-xs font-mono">
                        <div>
                          <div className="font-bold text-text">{log.note}</div>
                          <div className="text-[10px] text-text-muted">{new Date(log.createdAt).toLocaleString()}</div>
                        </div>
                        <div className="text-warning font-bold text-sm">
                          +{formatVal(log.amount)}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

        </div>

      </main>

      {/* MODAL 1: REQUEST BANK (BUY-IN) — circular table, tap whoever needs chips */}
      {showBuyInModal && (() => {
        const ringPlayers = Array.from(new Set([currentUser.uid, ...(activeSession?.activePlayerUids || [])]));
        const targetName = buyInTargetUser === currentUser.uid
          ? 'Me'
          : (allUsers[buyInTargetUser]?.displayName || `Player (${buyInTargetUser.slice(0, 5)})`);
        const quickAmounts = Array.from(new Set([
          club.minBuyIn || 1000,
          (club.minBuyIn || 1000) * 2,
          (club.minBuyIn || 1000) * 3,
          club.maxBuyIn || 5000,
        ])).filter(a => a <= dynamicMaxBuyIn).sort((a, b) => a - b);

        return (
          <div
            className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-0 sm:p-4"
            onClick={() => setShowBuyInModal(false)}
          >
            <div
              className="bg-surface border border-line w-full sm:max-w-md max-h-[92vh] overflow-y-auto rounded-t-3xl sm:rounded-3xl shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="sticky top-0 bg-surface border-b border-line px-5 py-4 flex items-center justify-between z-10">
                <div>
                  <h3 className="text-sm font-black text-accent uppercase tracking-wider">Buy In</h3>
                  <p className="text-[11px] text-text-muted mt-0.5">Tap whoever needs chips</p>
                </div>
                {/* Bordered rather than a bare glyph — as a faint muted icon
                    this was the only exit and easy to miss entirely. */}
                <button
                  type="button"
                  onClick={() => setShowBuyInModal(false)}
                  aria-label="Close"
                  className="shrink-0 w-9 h-9 rounded-xl border border-line text-text-muted hover:text-text hover:border-line-strong transition-colors flex items-center justify-center cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <form onSubmit={(e) => requestBuyInAction.run(e)} className="p-5 space-y-5">
                {/* Poker table — tap a seat to pick who the chips are for */}
                <PokerTableRing
                  players={ringPlayers.map(uid => ({
                    uid,
                    name: uid === currentUser.uid
                      ? 'Me'
                      : (allUsers[uid]?.displayName || `Player (${uid.slice(0, 5)})`),
                    bank: activeSessionBuyIns
                      .filter(r => r.userId === uid)
                      .reduce((sum, r) => sum + r.amount, 0),
                  }))}
                  formatBank={formatPts}
                  selectedUid={buyInTargetUser}
                  onSelect={setBuyInTargetUser}
                />

                {/* Chip amount picker */}
                <div className="space-y-2">
                  <label className="text-[11px] font-bold text-text-muted uppercase">Amount</label>
                  <div className="flex flex-wrap gap-2">
                    {quickAmounts.map(amt => (
                      <button
                        key={amt}
                        type="button"
                        onClick={() => setBuyInAmount(amt)}
                        className={`px-3.5 py-2 rounded-full text-xs font-mono font-black cursor-pointer transition-all border ${
                          buyInAmount === amt
                            ? 'bg-accent border-accent text-accent-contrast'
                            : 'bg-bg border-line text-text hover:border-line-strong'
                        }`}
                      >
                        {formatPts(amt)}
                      </button>
                    ))}
                  </div>
                  {/* No min/max attributes on purpose — the browser's native
                      validation bubble would pre-empt the toast that tells the
                      player what the current cap actually is. */}
                  <input
                    type="number"
                    required
                    step={100}
                    value={buyInAmount}
                    onChange={(e) => setBuyInAmount(Number(e.target.value))}
                    className="w-full bg-bg border border-line rounded-xl px-4 py-3 text-lg font-mono font-black text-accent focus:border-accent outline-none"
                  />
                  <p className="text-[11px] text-accent font-mono font-bold">
                    Equivalent Real Bank Cash: ₹{Math.round(buyInAmount / ((club.enableDevaluation ?? true) ? (club.devaluationFactor ?? 5) : 1)).toLocaleString()} INR
                  </p>
                </div>

                {/* Min/max are enforced on submit via a toast rather than
                    spelled out up front — see handleRequestBuyIn. */}
                {isAdmin && buyInTargetUser === currentUser.uid && (
                  <p className="text-[11px] text-warning font-bold">
                    ⚠️ As an Admin, another Admin must approve your request.
                  </p>
                )}

                <button
                  type="submit"
                        disabled={requestBuyInAction.pending}
                  className="w-full bg-accent hover:bg-accent text-accent-contrast font-black py-3.5 rounded-xl text-xs uppercase tracking-widest cursor-pointer shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
                >
                        {requestBuyInAction.pending ? 'Sending…' : <>Buy in {formatPts(buyInAmount)} for {targetName}</>}
                </button>

                <button
                  type="button"
                  onClick={() => setShowBuyInModal(false)}
                  className="w-full text-center text-xs font-bold text-text-muted hover:text-text transition-colors cursor-pointer py-1"
                >
                  Cancel
                </button>
              </form>
            </div>
          </div>
        );
      })()}

      {showPastSessionModal && (
        <div
          className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-0 sm:p-4"
          onClick={() => setShowPastSessionModal(false)}
        >
          <form
            onSubmit={(e) => createPastSessionAction.run(e)}
            className="bg-surface border border-line w-full sm:max-w-lg rounded-t-3xl sm:rounded-3xl shadow-2xl max-h-[92vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-5 border-b border-line/60 flex items-center justify-between sticky top-0 bg-surface rounded-t-3xl">
              <h3 className="font-bold text-text flex items-center gap-2">
                <CalendarPlus className="w-4 h-4 text-accent" /> Record a past night
                <InfoHint>
                  For a game played before it was entered here. Today's club rules (rake, winners' cut, mismatch handling)
                  are applied, and the night slots into history by its date — session numbers re-order themselves.
                </InfoHint>
              </h3>
              <button type="button" onClick={() => setShowPastSessionModal(false)} className="text-text-muted hover:text-text">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-5 space-y-5">
              <div>
                <label className="text-xs font-bold text-text-muted uppercase tracking-wider">Date played</label>
                <input
                  type="date"
                  value={pastDate}
                  max={new Date().toISOString().slice(0, 10)}
                  onChange={(e) => setPastDate(e.target.value)}
                  className="mt-1.5 w-full bg-bg border border-line rounded-xl px-3 py-2.5 text-sm text-text focus:border-accent outline-none"
                />
              </div>

              {(() => {
                const memberName = (uid: string) =>
                  uid === currentUser.uid
                    ? currentUser.displayName || 'You'
                    : allUsers[uid]?.displayName || allUsers[uid]?.email || `Member (${uid.slice(0, 6)})`;
                const addMember = (uid: string) =>
                  setPastRows((rows) => {
                    if (rows.some((r) => r.userId === uid)) return rows;
                    const row = { userId: uid, name: memberName(uid), buyIn: 0, cashOut: 0 };
                    // Reuse the first untouched blank row so tapping a member
                    // doesn't leave an empty line stranded above them.
                    const blank = rows.findIndex((r) => !r.userId && !r.name.trim() && !r.buyIn && !r.cashOut);
                    return blank === -1 ? [...rows, row] : rows.map((r, j) => (j === blank ? row : r));
                  });
                const unseated = allMembersList.filter((uid) => !pastRows.some((r) => r.userId === uid));
                if (allMembersList.length === 0) return null;
                return (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-bold text-text-muted uppercase tracking-wider">
                        Who played
                      </span>
                      {unseated.length > 0 && (
                        <button
                          type="button"
                          onClick={() => unseated.forEach(addMember)}
                          className="text-[11px] font-bold text-accent hover:underline"
                        >
                          Add everyone
                        </button>
                      )}
                    </div>
                    {unseated.length === 0 ? (
                      <p className="text-[11px] text-text-muted">All club members added.</p>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        {unseated.map((uid) => (
                          <button
                            key={uid}
                            type="button"
                            onClick={() => addMember(uid)}
                            className="flex items-center gap-1.5 bg-bg border border-line/70 hover:border-accent/60 hover:text-accent text-text-muted text-xs font-bold pl-1.5 pr-2.5 py-1 rounded-full transition-colors"
                          >
                            <span className="w-5 h-5 rounded-full bg-surface-alt border border-line/60 flex items-center justify-center text-[10px] text-text">
                              {memberName(uid)[0]?.toUpperCase() || 'M'}
                            </span>
                            {memberName(uid)}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })()}

              <div className="space-y-2">
                <div className="grid grid-cols-[1fr_5rem_5rem_1.75rem] gap-2 px-1">
                  <span className="text-[10px] font-bold text-text-muted uppercase tracking-wider">Player</span>
                  <span className="text-[10px] font-bold text-text-muted uppercase tracking-wider text-right">Buy-in</span>
                  <span className="text-[10px] font-bold text-text-muted uppercase tracking-wider text-right">Cash-out</span>
                  <span />
                </div>
                {pastRows.map((row, i) => (
                  <div key={i} className="grid grid-cols-[1fr_5rem_5rem_1.75rem] gap-2 items-center">
                    {row.userId ? (
                      <div className="flex items-center gap-1.5 bg-accent/10 border border-accent/30 rounded-xl px-2 py-2 min-w-0">
                        <span className="w-5 h-5 shrink-0 rounded-full bg-surface-alt border border-line/60 flex items-center justify-center text-[10px] text-text">
                          {row.name[0]?.toUpperCase() || 'M'}
                        </span>
                        <span className="text-sm text-text font-bold truncate">{row.name}</span>
                      </div>
                    ) : (
                      <input
                        value={row.name}
                        placeholder="Guest name"
                        onChange={(e) =>
                          setPastRows((rows) => rows.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)))
                        }
                        className="bg-bg border border-line rounded-xl px-3 py-2 text-sm text-text focus:border-accent outline-none min-w-0"
                      />
                    )}
                    <input
                      type="number"
                      min={0}
                      value={row.buyIn || ''}
                      placeholder="0"
                      onChange={(e) =>
                        setPastRows((rows) => rows.map((r, j) => (j === i ? { ...r, buyIn: Number(e.target.value) } : r)))
                      }
                      className="bg-bg border border-line rounded-xl px-2 py-2 text-sm text-text text-right font-mono focus:border-accent outline-none min-w-0"
                    />
                    <input
                      type="number"
                      min={0}
                      value={row.cashOut || ''}
                      placeholder="0"
                      onChange={(e) =>
                        setPastRows((rows) => rows.map((r, j) => (j === i ? { ...r, cashOut: Number(e.target.value) } : r)))
                      }
                      className="bg-bg border border-line rounded-xl px-2 py-2 text-sm text-text text-right font-mono focus:border-accent outline-none min-w-0"
                    />
                    <button
                      type="button"
                      onClick={() => setPastRows((rows) => (rows.length > 2 ? rows.filter((_, j) => j !== i) : rows))}
                      disabled={pastRows.length <= 2}
                      className="text-text-muted hover:text-danger disabled:opacity-25 disabled:hover:text-text-muted"
                    >
                      <PastRowTrash className="w-4 h-4" />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => setPastRows((rows) => [...rows, { name: '', buyIn: 0, cashOut: 0 }])}
                  className="w-full border border-dashed border-line/70 text-text-muted text-xs font-bold py-2 rounded-xl hover:border-accent/50 hover:text-accent transition-colors"
                >
                  + Add a guest
                </button>
              </div>

              {(() => {
                const inSum = pastRows.reduce((t, r) => t + (Number(r.buyIn) || 0), 0);
                const outSum = pastRows.reduce((t, r) => t + (Number(r.cashOut) || 0), 0);
                const diff = Math.round((inSum - outSum) * 100) / 100;
                return (
                  <div className="bg-bg/70 border border-line/60 rounded-2xl p-3 space-y-1.5 text-xs font-mono tabular-nums">
                    <div className="flex items-baseline gap-3 text-text-muted">
                      <span className="flex-1 min-w-0 truncate">Total buy-ins</span>
                      <span className="shrink-0 text-right text-text">{formatVal(inSum)}</span>
                    </div>
                    <div className="flex items-baseline gap-3 text-text-muted">
                      <span className="flex-1 min-w-0 truncate">Total cash-outs</span>
                      <span className="shrink-0 text-right text-text">{formatVal(outSum)}</span>
                    </div>
                    <div className="flex items-baseline gap-3 border-t border-line/50 pt-1.5">
                      <span className="flex-1 min-w-0 truncate text-text-muted">Difference</span>
                      <span className={`shrink-0 text-right ${diff === 0 ? 'text-accent' : 'text-warning'}`}>
                        {diff === 0 ? 'Balanced' : formatSignedVal(-diff)}
                      </span>
                    </div>
                  </div>
                );
              })()}

              <p className="text-[11px] text-text-muted leading-relaxed">
                Rake, winners' cut and any mismatch are calculated using the club's rules as they stand today.
              </p>

              <button
                type="button"
                onClick={() => { setPastCalculated(true); setPastConfirming(false); }}
                disabled={!pastDate || pastEntryRows.length < 2 || pastHasZeroBuyIn}
                className="w-full flex items-center justify-center gap-2 border border-accent/40 text-accent font-black py-3 rounded-xl text-xs uppercase tracking-widest disabled:opacity-40 disabled:cursor-not-allowed hover:bg-accent/10 transition-colors"
              >
                <Scale className="w-4 h-4" /> Calculate
              </button>
              {(!pastDate || pastEntryRows.length < 2 || pastHasZeroBuyIn) && (
                <p className="text-[11px] text-warning text-center">
                  {pastHasZeroBuyIn
                    ? 'Every player needs a buy-in greater than zero.'
                    : 'Pick a date and name at least two players to calculate.'}
                </p>
              )}

              {pastCalculated && pastPreview && (
                <SettlementPreview
                  result={pastPreview}
                  club={club}
                  formatAmount={formatVal}
                  formatSigned={formatSignedVal}
                  mismatchAcknowledgement={{
                    checked: pastMismatchAcknowledged,
                    onChange: (checked) => { setPastMismatchAcknowledged(checked); setPastConfirming(false); },
                  }}
                />
              )}
            </div>

            {/* Recording rewrites lifetime standings and moves the club pot, so
                it takes the same deliberate second tap as a live settle. */}
            <div className="p-5 pt-0 space-y-2">
              {pastConfirming && pastPreview && (
                <SettlementConfirm
                  result={pastPreview}
                  title="Record this night?"
                  warning="This rewrites lifetime standings for everyone listed and cannot be undone."
                  formatSigned={formatSignedVal}
                />
              )}

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => (pastConfirming ? setPastConfirming(false) : setShowPastSessionModal(false))}
                  className="flex-1 border border-line text-text-muted font-bold py-3 rounded-xl hover:text-text transition-colors"
                >
                  {pastConfirming ? 'Back' : 'Cancel'}
                </button>
                {/* Distinct keys so React swaps the element instead of
                    patching one button's type in place — see the note in
                    handleCreatePastSession. */}
                {!pastConfirming ? (
                  <button
                    key="past-review"
                    type="button"
                    onClick={() => setPastConfirming(true)}
                    disabled={!pastCalculated || !pastPreview || pastPreview.requiresManualResolution}
                    className="flex-1 bg-accent text-accent-contrast font-bold py-3 rounded-xl disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Record night
                  </button>
                ) : (
                  <button
                    key="past-confirm"
                    type="submit"
                    disabled={savingPast}
                    className="flex-1 bg-warning text-accent-contrast font-black py-3 rounded-xl disabled:opacity-50 uppercase tracking-wide text-xs"
                  >
                    {savingPast ? 'Saving…' : 'Yes, record it'}
                  </button>
                )}
              </div>
            </div>
          </form>
        </div>
      )}

      {showStandUpModal && activeSession && (
        <div
          className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-0 sm:p-4"
          onClick={() => setShowStandUpModal(false)}
        >
          <div
            className="bg-surface border border-line w-full sm:max-w-sm rounded-t-3xl sm:rounded-3xl shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="border-b border-line px-5 py-4 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-black text-accent uppercase tracking-wider">Stand Up</h3>
                <p className="text-[11px] text-text-muted mt-0.5">Count your chips and cash out</p>
              </div>
              <button
                type="button"
                onClick={() => setShowStandUpModal(false)}
                aria-label="Close"
                className="shrink-0 w-9 h-9 rounded-xl border border-line text-text-muted hover:text-text hover:border-line-strong transition-colors flex items-center justify-center cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={(e) => standUpAction.run(e)} className="p-5 space-y-4">
              <div className="p-3 bg-bg border border-line rounded-xl text-[11px] text-text-muted">
                You bought in for{' '}
                <strong className="text-text font-mono">
                  {formatVal(activeSessionBuyIns.filter((r) => r.userId === currentUser.uid).reduce((sum, r) => sum + r.amount, 0))}
                </strong>
                . Enter the chips you are leaving with — an admin confirms it before it counts.
              </div>

              <div className="space-y-1.5">
                <label className="text-[10px] font-bold text-text-muted uppercase">Chips you are cashing out</label>
                <input
                  type="number"
                  required
                  min={0}
                  step={100}
                  value={standUpAmount}
                  onChange={(e) => setStandUpAmount(Math.max(0, Number(e.target.value)))}
                  className="w-full bg-bg border border-line rounded-xl px-4 py-3 text-lg font-mono font-black text-accent focus:border-accent outline-none"
                />
              </div>

              <button
                type="submit"
                      disabled={standUpAction.pending}
                className="w-full bg-accent text-accent-contrast font-black py-3.5 rounded-xl text-xs uppercase tracking-widest cursor-pointer shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
              >
                      {standUpAction.pending ? 'Sending…' : <>Cash out {formatVal(standUpAmount)}</>}
              </button>
              <button
                type="button"
                onClick={() => setShowStandUpModal(false)}
                className="w-full text-center text-xs font-bold text-text-muted hover:text-text transition-colors cursor-pointer py-1"
              >
                Cancel
              </button>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: CASHOUT & END-OF-SESSION SETTLEMENT (ADMIN ONLY) */}
      {showCashoutModal && isAdmin && activeSession && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="bg-surface border border-line w-full sm:max-w-lg max-h-[92vh] overflow-y-auto rounded-t-3xl sm:rounded-3xl shadow-2xl">
            <div className="sticky top-0 bg-surface border-b border-line px-5 py-4 flex items-center justify-between z-10">
              <div>
                <h3 className="text-sm font-black text-accent uppercase tracking-wider flex items-center gap-2">
                  <Sliders className="w-4 h-4" /> Cashout
                </h3>
                <p className="text-[11px] text-text-muted mt-0.5">{activeSession.sessionName}</p>
              </div>
              <button
                type="button"
                onClick={() => setShowCashoutModal(false)}
                aria-label="Close"
                className="shrink-0 w-9 h-9 rounded-xl border border-line text-text-muted hover:text-text hover:border-line-strong transition-colors flex items-center justify-center cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 space-y-4">
              {settlementError && (
                <div className="p-3 rounded-xl bg-danger/10 border border-danger/30 text-danger text-xs text-center">
                  {settlementError}
                </div>
              )}

              {/* Player Rows: Buy-in (editable) / Cash-out (editable) */}
              <div className="space-y-3">
                {settlementUids.map(uid => {
                  const summary = cashoutCalculated ? preview?.players.find(p => p.userId === uid) : undefined;
                  return (
                    <div key={uid} className="p-3.5 bg-bg border border-line rounded-2xl space-y-2.5">
                      <div className="flex items-center justify-between">
                        <div className="text-xs font-bold text-text">
                          {uid === currentUser.uid ? 'You' : (allUsers[uid]?.displayName || `Player (${uid.slice(0, 6)})`)}
                        </div>
                        {club.winnerDefinition === 'MANUAL' ? (
                          <label className="flex items-center gap-1.5 text-[10px] font-bold text-text-muted uppercase cursor-pointer">
                            <input
                              type="checkbox"
                              checked={!!manualWinnerInputs[uid]}
                              onChange={(e) => { setManualWinnerInputs({ ...manualWinnerInputs, [uid]: e.target.checked }); setCashoutCalculated(false); setConfirmingSettle(false); }}
                              className="w-3.5 h-3.5 accent-accent rounded cursor-pointer"
                            />
                            Winner
                          </label>
                        ) : summary?.isWinner ? (
                          <span className="px-2 py-0.5 bg-accent/15 border border-accent/40 text-accent text-[9px] font-black uppercase rounded-full">Winner</span>
                        ) : null}
                      </div>
                      <div className="grid grid-cols-2 gap-2.5">
                        <div className="space-y-1">
                          <label className="text-[10px] font-bold text-text-muted uppercase">Buy-in</label>
                          <input
                            type="number"
                            min={0}
                            value={buyInInputs[uid] ?? ''}
                            onChange={(e) => { setBuyInInputs({ ...buyInInputs, [uid]: Number(e.target.value) }); setCashoutCalculated(false); setConfirmingSettle(false); }}
                            className="w-full bg-surface border border-line rounded-xl px-3 py-2 text-xs font-mono font-bold text-text focus:border-accent outline-none"
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="text-[10px] font-bold text-text-muted uppercase flex items-center gap-1">
                            Cash-out
                            {uid in confirmedCashOutByUid && (
                              <InfoHint>
                                This player stood up early and their chip count was already confirmed by an admin. It's
                                locked here because that's the number the settlement uses.
                              </InfoHint>
                            )}
                          </label>
                          {uid in confirmedCashOutByUid ? (
                            <div className="w-full bg-surface/60 border border-accent/30 rounded-xl px-3 py-2 flex items-center justify-between gap-2">
                              <span className="text-xs font-mono font-bold text-text">
                                {confirmedCashOutByUid[uid].toLocaleString()}
                              </span>
                              <span className="flex items-center gap-1 text-[9px] font-black uppercase text-accent">
                                <Lock className="w-2.5 h-2.5" /> Stood up
                              </span>
                            </div>
                          ) : (
                            <input
                              type="number"
                              min={0}
                              value={cashOutInputs[uid] ?? ''}
                              onChange={(e) => { setCashOutInputs({ ...cashOutInputs, [uid]: Number(e.target.value) }); setCashoutCalculated(false); setConfirmingSettle(false); }}
                              placeholder="Enter cash-out"
                              className="w-full bg-surface border border-line rounded-xl px-3 py-2 text-xs font-mono font-bold text-text focus:border-accent outline-none"
                            />
                          )}
                        </div>
                      </div>
                      {/* Results live in the shared preview below, the same as
                          the past-night and edit flows — repeating them under
                          each input made this modal the odd one out. */}
                    </div>
                  );
                })}
              </div>

              {!allCashOutsEntered && (
                <p className="text-[11px] text-text-muted text-center">
                  Enter a cash-out for every player before calculating.
                </p>
              )}

              <button
                onClick={() => { setCashoutCalculated(true); setConfirmingSettle(false); }}
                disabled={!allCashOutsEntered}
                className="w-full flex items-center justify-center gap-2 border border-accent/40 text-accent font-black py-3 rounded-xl text-xs uppercase tracking-widest disabled:opacity-40 disabled:cursor-not-allowed hover:bg-accent/10 transition-colors"
              >
                <Scale className="w-4 h-4" /> Calculate
              </button>

              {/* Settlement Summary — only revealed after Calculate */}
              {cashoutCalculated && preview && (
                <SettlementPreview
                  result={preview}
                  club={club}
                  formatAmount={formatVal}
                  formatSigned={formatSignedVal}
                  mismatchAcknowledgement={{
                    checked: mismatchAcknowledged,
                    // Deliberately does NOT reset cashoutCalculated, which is what the
                      // past-night flow above already gets right. The acknowledgement is an
                      // input to computeSettlement, and `preview` is recomputed on every
                      // render — so ticking the box updates the figures and clears
                      // requiresManualResolution live. Resetting it unmounted the block this
                      // checkbox lives inside, so the preview vanished the instant it was
                      // ticked and Settle stayed disabled with no visible way forward.
                      //
                      // confirmingSettle IS reset: the figures just changed, so an already
                      // armed confirmation must be re-armed against the new numbers.
                      onChange: (checked) => { setMismatchAcknowledged(checked); setConfirmingSettle(false); },
                  }}
                />
              )}

              {/* Settling is irreversible and moves real money, so it takes a
                  deliberate second tap that restates the final figures. */}
              {!confirmingSettle ? (
                <button
                  onClick={() => setConfirmingSettle(true)}
                  disabled={!cashoutCalculated || !allCashOutsEntered || (preview?.requiresManualResolution ?? false)}
                  className="w-full bg-accent hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed text-accent-contrast font-black py-3.5 rounded-xl text-xs uppercase tracking-widest cursor-pointer shadow-lg"
                >
                  Settle Session
                </button>
              ) : (
                <div className="space-y-3">
                  <SettlementConfirm
                    result={preview!}
                    title="Settle this session?"
                    warning="This locks the results permanently and cannot be undone."
                    formatSigned={formatSignedVal}
                  />

                  <div className="flex gap-2 pt-1">
                    <button
                      onClick={() => setConfirmingSettle(false)}
                      className="flex-1 bg-surface-alt border border-line-strong text-text font-bold py-3 rounded-xl text-xs uppercase tracking-wider cursor-pointer"
                    >
                      Go Back
                    </button>
                    <button
                        onClick={() => { setConfirmingSettle(false); settleAction.run(); }}
                        disabled={settleAction.pending}
                      className="flex-1 bg-accent text-accent-contrast font-black py-3 rounded-xl text-xs uppercase tracking-wider cursor-pointer shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        {settleAction.pending ? 'Settling…' : 'Confirm & Settle'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* MODAL: CLUB RULES & INFO */}
      {showClubInfoModal && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="bg-surface border border-line w-full sm:max-w-sm max-h-[85vh] overflow-y-auto rounded-t-3xl sm:rounded-3xl shadow-2xl">
            <div className="sticky top-0 bg-surface border-b border-line px-5 py-4 flex items-center justify-between z-10">
              <h3 className="text-sm font-black text-accent uppercase tracking-wider flex items-center gap-2">
                <Info className="w-4 h-4" /> Club Rules & Info
              </h3>
              <button onClick={() => setShowClubInfoModal(false)} className="text-text-muted hover:text-text cursor-pointer">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-5 space-y-2 text-xs font-mono">
              <div className="flex items-center justify-between py-2 border-b border-line/60">
                <span className="text-text-muted">Min Buy-in</span>
                <strong className="text-text">{formatVal(club.minBuyIn || 1000)}</strong>
              </div>
              <div className="flex items-center justify-between py-2 border-b border-line/60">
                <span className="text-text-muted">Max Buy-in</span>
                <strong className="text-text">{formatVal(club.maxBuyIn || 5000)}</strong>
              </div>
              <div className="flex items-center justify-between py-2 border-b border-line/60">
                <span className="text-text-muted">Rake</span>
                <strong className="text-warning">{club.rakeEnabled ? RAKE_METHOD_LABELS[club.rakeMethod ?? 'PERCENT_PROFIT'](club.rakeValue ?? 5) : 'Disabled'}</strong>
              </div>
              <div className="flex items-center justify-between py-2 border-b border-line/60">
                <span className="text-text-muted">Club Pot</span>
                <strong className="text-warning">{club.potEnabled ? 'Enabled' : 'Disabled'}</strong>
              </div>
              <div className="flex items-center justify-between py-2 border-b border-line/60">
                <span className="text-text-muted">Mismatch Handling</span>
                <strong className="text-warning">{MISMATCH_STRATEGY_LABELS[club.mismatchStrategy ?? 'PROPORTIONAL_WINNERS']}</strong>
              </div>
              <div className="flex items-center justify-between py-2 border-b border-line/60">
                <span className="text-text-muted">Ratio</span>
                <strong className="text-accent">
                  {(club.enableDevaluation ?? true) ? `${club.devaluationFactor ?? 5} Chips = ₹1 INR` : '1 Chip = ₹1 INR'}
                </strong>
              </div>

              {activeSession && (
                <>
                  <div className="flex items-center justify-between py-2 border-b border-line/60">
                    <span className="text-text-muted">Largest Bank at Table</span>
                    <strong className="text-warning">{formatVal(largestActiveBank)}</strong>
                  </div>
                  <div className="flex items-center justify-between py-2">
                    <span className="text-text-muted">Current Allowed Max</span>
                    <strong className="text-accent">{formatVal(dynamicMaxBuyIn)}</strong>
                  </div>
                  <p className="text-[10px] text-text-muted font-sans pt-1">
                    No player may buy in for more than the largest active bank currently held at the table.
                  </p>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* MODAL: PROFILE (USER DETAIL, THEME, CLUB SETTINGS FOR ADMINS) */}
      {showProfileModal && (
        <AccountSettingsModal
          onClose={() => setShowProfileModal(false)}
          club={club}
          isClubAdmin={isAdmin}
          onOpenClubSettings={() => { setShowProfileModal(false); setShowSettingsModal(true); }}
        />
      )}

      {/* MODAL 2: CLUB SETTINGS & DEVALUATION RATIO (ADMIN ONLY) */}
      {showSettingsModal && isAdmin && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-surface border border-line w-full max-w-lg p-6 rounded-3xl shadow-2xl space-y-5 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-line pb-3">
              <h3 className="text-base font-bold text-text uppercase tracking-wider flex items-center gap-2">
                <Settings className="w-5 h-5 text-accent" /> Club Rules & Devaluation Settings
              </h3>
              <button onClick={() => setShowSettingsModal(false)} className="text-text-muted hover:text-text cursor-pointer">
                <X className="w-5 h-5" />
              </button>
            </div>

            {(isOwner || isSuperUser) && (
              <button
                onClick={() => { setActiveTab('auditTrail'); setShowSettingsModal(false); }}
                className="w-full flex items-center justify-between p-3 bg-bg border border-line rounded-xl text-xs font-bold text-text-muted hover:text-text transition-colors cursor-pointer"
              >
                <span className="flex items-center gap-2"><FileCheck className="w-4 h-4 text-accent" /> Audit Trail & System Logs</span>
                <ChevronRight className="w-4 h-4" />
              </button>
            )}

            <form onSubmit={handleSaveClubSettings} className="space-y-4">
              <div className="space-y-1">
                <label className="text-[11px] font-bold text-text-muted uppercase">Club Name</label>
                <input
                  type="text"
                  required
                  value={editClubName}
                  onChange={(e) => setEditClubName(e.target.value)}
                  className="w-full bg-bg border border-line rounded-xl px-3.5 py-2.5 text-xs text-text font-bold focus:border-accent outline-none"
                />
              </div>

              {/* Everything from here to the end of the devaluation block is
                  fixed at creation. `disabled` on the fieldset cascades to
                  every control inside it, so the form shows the club's rules
                  without implying they can be edited. The server rejects any
                  change regardless — see IMMUTABLE_CLUB_RULES. */}
              <div className="p-3 bg-bg border border-line/60 rounded-xl flex items-start gap-2">
                <Lock className="w-3.5 h-3.5 text-text-muted shrink-0 mt-0.5" />
                <p className="text-[11px] text-text-muted leading-relaxed">
                  These rules were fixed when the club was created and can't be changed — every
                  night, past and future, settles by them. Start a new club to play differently.
                </p>
              </div>

              <fieldset disabled className="space-y-5 opacity-60">
              <div className="grid grid-cols-2 gap-3">
                {/* Min/Max are no longer consulted for buy-ins — the ceiling
                    comes from buyInMode. Showing them would imply a limit that
                    isn't enforced. */}
                <div className="col-span-2 space-y-2">
                  <label className="text-[11px] font-bold text-text-muted uppercase flex items-center gap-1">
                    Buy-in Limit
                    <InfoHint>
                      How much a player may take in one go. The first buy-in of a session is never capped — it sets the reference the rest match.
                    </InfoHint>
                  </label>
                  {([
                    ['MATCH_HIGHEST', 'Match the biggest bank',
                     'Up to whatever the deepest player currently holds.'],
                    ['UNCAPPED', 'No limit',
                     'No ceiling from the app at all.'],
                  ] as const).map(([value, label, blurb]) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setEditBuyInMode(value)}
                      className={`w-full text-left p-2.5 rounded-xl border transition-colors cursor-pointer ${
                        editBuyInMode === value ? 'border-accent bg-accent/10' : 'border-line hover:border-line-strong'
                      }`}
                    >
                      <span className={`block text-xs font-bold ${editBuyInMode === value ? 'text-accent' : 'text-text'}`}>{label}</span>
                      <span className="block text-[10px] text-text-muted mt-0.5">{blurb}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Settlement Rules — everything the Cashout Engine reads at settle time */}
              <div className="p-4 bg-bg border border-line rounded-2xl space-y-4">
                <h4 className="text-xs font-black text-accent uppercase tracking-wider">Settlement Rules</h4>

                <div className="flex items-center justify-between">
                  <label className="text-xs font-bold text-text flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={editRakeEnabled}
                      onChange={(e) => setEditRakeEnabled(e.target.checked)}
                      className="w-4 h-4 accent-accent rounded cursor-pointer"
                    />
                    Rake Enabled
                  </label>
                </div>

                {editRakeEnabled && (
                  <div className="grid grid-cols-2 gap-3 pl-6">
                    <div className="space-y-1">
                      <label className="text-[10px] font-bold text-text-muted uppercase">Rake Method</label>
                      <select
                        value={editRakeMethod}
                        onChange={(e) => setEditRakeMethod(e.target.value as RakeMethod)}
                        className="w-full bg-surface border border-line rounded-xl px-2.5 py-2 text-xs font-bold text-text focus:border-accent outline-none"
                      >
                        <option value="PERCENT_PROFIT">% of Winner's Profit</option>
                        <option value="PERCENT_CASHOUT">% of Cashout</option>
                        <option value="FIXED_PER_WINNER">Fixed Amount / Winner</option>
                        <option value="FIXED_PER_SESSION">Fixed Amount / Session</option>
                        <option value="CUSTOM">Custom (coming soon)</option>
                      </select>
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] font-bold text-text-muted uppercase">
                        Rake Value {editRakeMethod === 'PERCENT_PROFIT' || editRakeMethod === 'PERCENT_CASHOUT' ? '(%)' : '(Chips)'}
                      </label>
                      <input
                        type="number"
                        min={0}
                        value={editRakeValue}
                        onChange={(e) => setEditRakeValue(Number(e.target.value))}
                        className="w-full bg-surface border border-line rounded-xl px-3 py-2 text-xs font-mono font-bold text-warning focus:border-accent outline-none"
                      />
                    </div>
                    <div className="space-y-1 col-span-2">
                      <label className="text-[10px] font-bold text-text-muted uppercase">Rake Collection Order</label>
                      <select
                        value={editRakeOrder}
                        onChange={(e) => setEditRakeOrder(e.target.value as RakeOrder)}
                        className="w-full bg-surface border border-line rounded-xl px-2.5 py-2 text-xs font-bold text-text focus:border-accent outline-none"
                      >
                        <option value="MISMATCH_FIRST">Resolve mismatch first, then rake</option>
                        <option value="RAKE_FIRST">Rake first, then resolve mismatch</option>
                      </select>
                    </div>
                  </div>
                )}

                <div className="flex items-center justify-between pt-2 border-t border-line/60">
                  <label className="text-xs font-bold text-text flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={editPotEnabled}
                      onChange={(e) => setEditPotEnabled(e.target.checked)}
                      className="w-4 h-4 accent-accent rounded cursor-pointer"
                    />
                    Club Pot Enabled
                  </label>
                </div>

                <div className="space-y-1 pt-2 border-t border-line/60">
                  <label className="text-[10px] font-bold text-text-muted uppercase">Mismatch Handling Strategy</label>
                  <select
                    value={editMismatchStrategy}
                    onChange={(e) => setEditMismatchStrategy(e.target.value as MismatchStrategy)}
                    className="w-full bg-surface border border-line rounded-xl px-2.5 py-2 text-xs font-bold text-text focus:border-accent outline-none"
                  >
                    <option value="PROPORTIONAL_WINNERS">Deduct from winners proportionally to profit</option>
                    <option value="EQUAL_WINNERS">Deduct equally from winners</option>
                    <option value="EQUAL_ALL">Deduct equally from all players</option>
                    <option value="SHORTFALL_TO_POT">Add shortfall to Pot</option>
                    <option value="EXCESS_FROM_POT">Take excess from Pot</option>
                    <option value="MANUAL">Manual adjustment required</option>
                    <option value="CUSTOM">Custom (coming soon)</option>
                  </select>
                  <p className="text-[10px] text-text-muted">
                    Buy-ins left unclaimed always go to the Pot regardless of this setting.
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-3 pt-2 border-t border-line/60">
                  <div className="space-y-1">
                    <label className="text-[10px] font-bold text-text-muted uppercase">Winner Definition</label>
                    <select
                      value={editWinnerDefinition}
                      onChange={(e) => setEditWinnerDefinition(e.target.value as WinnerDefinition)}
                      className="w-full bg-surface border border-line rounded-xl px-2.5 py-2 text-xs font-bold text-text focus:border-accent outline-none"
                    >
                      <option value="PROFIT_POSITIVE">Profit greater than zero</option>
                      <option value="TOP_N">Top N finishers</option>
                      <option value="MANUAL">Manual selection</option>
                      <option value="CUSTOM">Custom (coming soon)</option>
                    </select>
                  </div>
                  {editWinnerDefinition === 'TOP_N' && (
                    <div className="space-y-1">
                      <label className="text-[10px] font-bold text-text-muted uppercase">Top N</label>
                      <input
                        type="number"
                        min={1}
                        value={editWinnerTopN}
                        onChange={(e) => setEditWinnerTopN(Math.max(1, Number(e.target.value)))}
                        className="w-full bg-surface border border-line rounded-xl px-3 py-2 text-xs font-mono font-bold text-text focus:border-accent outline-none"
                      />
                    </div>
                  )}
                </div>

                <div className="space-y-1 pt-2 border-t border-line/60">
                  <label className="text-[10px] font-bold text-text-muted uppercase">Rounding Rule</label>
                  <select
                    value={editRoundingRule}
                    onChange={(e) => setEditRoundingRule(e.target.value as RoundingRule)}
                    className="w-full bg-surface border border-line rounded-xl px-2.5 py-2 text-xs font-bold text-text focus:border-accent outline-none"
                  >
                    <option value="NONE">No rounding (nearest point)</option>
                    <option value="NEAREST_1">Round to nearest ₹1</option>
                    <option value="NEAREST_5">Round to nearest ₹5</option>
                    <option value="NEAREST_10">Round to nearest ₹10</option>
                  </select>
                </div>
              </div>

              {/* Currency Devaluation Controls */}
              <div className="p-4 bg-bg border border-line rounded-2xl space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <label className="text-xs font-bold text-text flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={editEnableDevaluation}
                        onChange={(e) => setEditEnableDevaluation(e.target.checked)}
                        className="w-4 h-4 accent-accent rounded cursor-pointer"
                      />
                      Enable Currency Devaluation (e.g. 5 Chips = ₹1 INR Cash)
                    </label>
                    <p className="text-[10px] text-text-muted mt-1 pl-6">
                      Devaluing currency allows players to buy in with points while converting to real bank cash on reports.
                    </p>
                  </div>
                </div>

                {editEnableDevaluation && (
                  <div className="pt-2 border-t border-line/60 flex flex-wrap items-center gap-3 pl-6">
                    <label className="text-[11px] font-bold text-text-muted">
                      Devaluation Ratio:
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        min={1}
                        max={100}
                        value={editDevaluationFactor}
                        onChange={(e) => setEditDevaluationFactor(Math.max(1, parseInt(e.target.value) || 1))}
                        className="w-20 bg-surface border border-line rounded-lg px-2.5 py-1.5 text-xs text-accent font-mono font-bold outline-none focus:border-accent"
                      />
                      <span className="text-xs text-text font-mono font-bold">
                        Chips = ₹1 Cash
                      </span>
                    </div>
                    <div className="text-[11px] text-accent font-mono font-bold bg-surface border border-line px-3 py-1 rounded-lg w-full">
                      Preview: 1,000 Chips = ₹{Math.round(1000 / (editDevaluationFactor || 1))} INR Real Cash Bank
                    </div>
                  </div>
                )}
              </div>
              </fieldset>

              {/* Leaderboard Visibility (Owner Only) — a visibility preference,
                  not a rule, so it stays outside the frozen fieldset. */}
              {(isOwner || isSuperUser) && (
                <div className="p-4 bg-bg border border-line rounded-2xl">
                  <label className="text-xs font-bold text-text flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={editLeaderboardVisibleToPlayers}
                      onChange={(e) => setEditLeaderboardVisibleToPlayers(e.target.checked)}
                      className="w-4 h-4 accent-accent rounded cursor-pointer"
                    />
                    Show Leaderboard to Players
                  </label>
                  <p className="text-[10px] text-text-muted mt-1 pl-6">
                    When off, only you and Club Admins can view the Leaderboard tab. History stays visible to everyone (players only see their own numbers).
                  </p>
                </div>
              )}

              {/* Club Admin Management (Owner or Super User Only) */}
              {(isOwner || isSuperUser) && (
                <div className="p-4 bg-bg border border-line rounded-2xl space-y-3">
                  <div className="flex items-center justify-between border-b border-line/60 pb-2">
                    <div>
                      <h4 className="text-xs font-bold text-text uppercase tracking-wider flex items-center gap-1.5">
                        <ShieldCheck className="w-4 h-4 text-accent" /> Club Admin Management ({club.adminUids?.length || 1}/3 Admins)
                      </h4>
                      <p className="text-[10px] text-text-muted mt-0.5">
                        1 Owner + up to 2 assigned Club Admins (Max 3 total). Admins can start sessions, approve buy-ins, and enter cash-outs.
                      </p>
                    </div>
                  </div>

                  <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                    {Array.from(new Set([...(club.memberUids || []), ...(club.adminUids || []), club.ownerUid || club.createdBy])).filter(Boolean).map(mUid => {
                      const isThisOwner = mUid === club.ownerUid || mUid === club.createdBy;
                      const isThisAdmin = club.adminUids?.includes(mUid) || isThisOwner;

                      return (
                        <div key={mUid} className="p-2.5 bg-surface border border-line rounded-xl flex items-center justify-between flex-wrap gap-y-2 text-xs">
                          <div className="flex items-center gap-2 flex-wrap">
                            <div className="w-6 h-6 rounded-full bg-bg text-accent text-[10px] font-bold flex items-center justify-center border border-line">
                              {mUid === currentUser.uid ? 'Me' : (allUsers[mUid]?.displayName ? allUsers[mUid].displayName[0].toUpperCase() : 'M')}
                            </div>
                            <span className="font-bold text-text">
                              {mUid === currentUser.uid ? (currentUser.displayName || 'You') : (allUsers[mUid]?.displayName || allUsers[mUid]?.email || `Member (${mUid.slice(0, 6)})`)}
                            </span>
                            {isThisOwner && (
                              <span className="px-2 py-0.5 bg-warning/15 border border-warning/50 text-warning font-bold text-[9px] uppercase rounded-full">
                                👑 Club Owner
                              </span>
                            )}
                            {!isThisOwner && isThisAdmin && (
                              <span className="px-2 py-0.5 bg-accent/15 border border-accent/50 text-accent font-bold text-[9px] uppercase rounded-full">
                                🛡️ Club Admin
                              </span>
                            )}
                          </div>

                          {!isThisOwner && (
                            <div className="flex items-center gap-1.5 flex-wrap">
                              {isThisAdmin ? (
                                <button
                                  type="button"
                                  onClick={() => demoteAdminAction.run(mUid)}
                                  disabled={demoteAdminAction.isPending(mUid)}
                                  className="px-2.5 py-1 bg-warning/80 hover:bg-warning/25 border border-warning/40 text-warning text-[10px] font-bold uppercase rounded-lg cursor-pointer transition-colors"
                                >
                                  Demote Admin
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => promoteAdminAction.run(mUid)}
                                  disabled={(club.adminUids?.length || 0) >= 3 || promoteAdminAction.pending}
                                  className={`px-2.5 py-1 text-[10px] font-bold uppercase rounded-lg transition-all ${
                                    (club.adminUids?.length || 0) >= 3
                                      ? 'bg-surface-alt text-text-faint cursor-not-allowed border border-line-strong'
                                      : 'bg-accent hover:bg-accent text-accent-contrast cursor-pointer shadow'
                                  }`}
                                  title={(club.adminUids?.length || 0) >= 3 ? "Max 3 admins reached (1 Owner + 2 Admins)" : "Promote to Admin"}
                                >
                                  + Assign Admin
                                </button>
                              )}

                              <button
                                type="button"
                                onClick={() => removeMemberAction.run(mUid)}
                                disabled={removeMemberAction.isPending(mUid)}
                                className="px-2 py-1 bg-danger/15 hover:bg-danger/25 border border-danger/40 text-danger text-[10px] font-bold uppercase rounded-lg cursor-pointer transition-colors"
                                title="Delete / Remove user from club"
                              >
                                Delete User
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              <button
                type="submit"
                disabled={savingSettings}
                className="w-full bg-accent hover:bg-accent text-accent-contrast font-black py-3 rounded-xl text-xs uppercase tracking-widest cursor-pointer shadow-lg disabled:opacity-50"
              >
                {savingSettings ? 'SAVING SETTINGS...' : 'UPDATE CLUB SETTINGS'}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* MODAL 3: EDIT HISTORICAL SESSION */}
      {showEditSessionModal && editingSession && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-surface border border-line w-full max-w-xl p-6 rounded-3xl shadow-2xl space-y-5 my-8">
            <div className="flex items-center justify-between border-b border-line pb-3">
              <h3 className="text-base font-bold text-text uppercase tracking-wider flex items-center gap-2">
                <FileEdit className="w-5 h-5 text-accent" /> Edit Session ({editingSession.dayTitle})
              </h3>
              <button onClick={() => setShowEditSessionModal(false)} className="text-text-muted hover:text-text cursor-pointer">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSubmitSessionEdit} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-[11px] font-bold text-text-muted uppercase">Session Date</label>
                  <input
                    type="date"
                    required
                    value={editSessionDate}
                    onChange={(e) => setEditSessionDate(e.target.value)}
                    className="w-full bg-bg border border-line rounded-xl px-3.5 py-2.5 text-xs text-text font-bold focus:border-accent outline-none font-mono"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-[11px] font-bold text-text-muted uppercase">Session Notes</label>
                  <input
                    type="text"
                    value={editSessionNotes}
                    onChange={(e) => setEditSessionNotes(e.target.value)}
                    placeholder="Optional notes..."
                    className="w-full bg-bg border border-line rounded-xl px-3.5 py-2.5 text-xs text-text focus:border-accent outline-none"
                  />
                </div>
              </div>

              {/* PLAYER FINANCIALS EDITOR */}
              <div className="p-4 bg-bg border border-line rounded-2xl space-y-3">
                <div className="flex items-center justify-between border-b border-line/60 pb-2">
                  <h4 className="text-xs font-bold text-text uppercase tracking-wider flex items-center gap-1.5">
                    <Users className="w-4 h-4 text-accent" /> Individual Player Buy-Ins & Cash-Outs
                  </h4>
                  <button
                    type="button"
                    onClick={handleAddPlayerToEdit}
                    className="px-2.5 py-1 bg-surface hover:bg-surface-alt border border-line text-accent text-[10px] font-bold uppercase rounded-lg cursor-pointer"
                  >
                    + Add Player
                  </button>
                </div>

                <div className="space-y-2.5 max-h-60 overflow-y-auto pr-1">
                  {editPlayerStats.map((p, idx) => {
                    const profit = (Number(p.cashOut) || 0) - (Number(p.buyIn) || 0);
                    return (
                      <div key={idx} className="p-3 bg-surface border border-line rounded-xl space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <input
                            type="text"
                            required
                            placeholder="Player Name"
                            value={p.name}
                            onChange={(e) => handlePlayerStatChange(idx, 'name', e.target.value)}
                            className="bg-bg border border-line rounded-lg px-2.5 py-1.5 text-xs text-text font-bold focus:border-accent outline-none flex-1"
                          />
                          {/* Gross cash-out minus buy-in, before the club's
                              rules are applied — Calculate below shows the
                              settled figure. */}
                          <span className={`text-xs font-mono font-bold tabular-nums ${profit >= 0 ? 'text-accent' : 'text-danger'}`}>
                            {formatSignedVal(profit)}
                          </span>
                          <button
                            type="button"
                            onClick={() => handleRemovePlayerFromEdit(idx)}
                            className="text-text-faint hover:text-danger text-xs p-1 cursor-pointer"
                            title="Remove player"
                          >
                            <X className="w-4 h-4" />
                          </button>
                        </div>

                        <div className="grid grid-cols-2 gap-2 text-xs">
                          <div>
                            <label className="text-[10px] text-text-muted font-bold block mb-0.5">Buy-In (Chips)</label>
                            <input
                              type="number"
                              min={0}
                              required
                              value={p.buyIn}
                              onChange={(e) => handlePlayerStatChange(idx, 'buyIn', Number(e.target.value))}
                              className="w-full bg-bg border border-line rounded-lg px-2.5 py-1 text-xs text-text font-mono font-bold focus:border-accent outline-none"
                            />
                          </div>
                          <div>
                            <label className="text-[10px] text-text-muted font-bold block mb-0.5">Cash-Out (Chips)</label>
                            <input
                              type="number"
                              min={0}
                              required
                              value={p.cashOut}
                              onChange={(e) => handlePlayerStatChange(idx, 'cashOut', Number(e.target.value))}
                              className="w-full bg-bg border border-line rounded-lg px-2.5 py-1 text-xs text-text font-mono font-bold focus:border-accent outline-none"
                            />
                          </div>
                        </div>

                        {/* Link to Club Member Dropdown */}
                        <div className="pt-1 flex items-center gap-2">
                          <label className="text-[10px] text-text-muted font-bold shrink-0">Link Account:</label>
                          <select
                            value={p.userId || ''}
                            onChange={(e) => {
                              const selectedUid = e.target.value;
                              const selectedUser = allUsers[selectedUid];
                              handlePlayerStatChange(idx, 'userId', selectedUid);
                              if (selectedUser?.displayName) {
                                handlePlayerStatChange(idx, 'name', selectedUser.displayName);
                              }
                            }}
                            className="bg-bg border border-line rounded-lg px-2 py-1 text-[11px] text-text font-mono focus:border-accent outline-none flex-1"
                          >
                            <option value="">-- Unlinked Account --</option>
                            {allMembersList.map(mUid => {
                              const u = allUsers[mUid];
                              const name = u?.displayName ? `${u.displayName} (${u.email || mUid.slice(0, 6)})` : `Member (${mUid.slice(0, 6)})`;
                              return (
                                <option key={mUid} value={mUid}>{name}</option>
                              );
                            })}
                          </select>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {(() => {
                  // Same running tally as the past-night flow — both are
                  // hand-entry, and a typo is easiest to spot before you
                  // calculate rather than after.
                  const inSum = editPlayerStats.reduce((t, p) => t + (Number(p.buyIn) || 0), 0);
                  const outSum = editPlayerStats.reduce((t, p) => t + (Number(p.cashOut) || 0), 0);
                  const diff = Math.round((inSum - outSum) * 100) / 100;
                  return (
                    <div className="bg-bg/70 border border-line/60 rounded-2xl p-3 space-y-1.5 text-xs font-mono tabular-nums">
                      <div className="flex items-baseline gap-3 text-text-muted">
                        <span className="flex-1 min-w-0 truncate">Total buy-ins</span>
                        <span className="shrink-0 text-right text-text">{formatVal(inSum)}</span>
                      </div>
                      <div className="flex items-baseline gap-3 text-text-muted">
                        <span className="flex-1 min-w-0 truncate">Total cash-outs</span>
                        <span className="shrink-0 text-right text-text">{formatVal(outSum)}</span>
                      </div>
                      <div className="flex items-baseline gap-3 border-t border-line/50 pt-1.5">
                        <span className="flex-1 min-w-0 truncate text-text-muted">Difference</span>
                        <span className={`shrink-0 text-right ${diff === 0 ? 'text-accent' : 'text-warning'}`}>
                          {diff === 0 ? 'Balanced' : formatSignedVal(-diff)}
                        </span>
                      </div>
                    </div>
                  );
                })()}
              </div>

              {/* Editing re-runs the club's settlement rules, so the recomputed
                  result is shown before it is committed — the raw buy-in and
                  cash-out figures above are inputs, not the outcome. */}
              <button
                type="button"
                onClick={() => setEditCalculated(true)}
                disabled={!editPreview}
                className="w-full flex items-center justify-center gap-2 border border-accent/40 text-accent font-black py-3 rounded-xl text-xs uppercase tracking-widest disabled:opacity-40 disabled:cursor-not-allowed hover:bg-accent/10 transition-colors"
              >
                <Scale className="w-4 h-4" /> Calculate
              </button>
              {!editPreview && (
                <p className="text-[11px] text-warning text-center">
                  {editHasZeroBuyIn
                    ? 'Every player needs a buy-in greater than zero.'
                    : 'A session needs at least two players to recalculate.'}
                </p>
              )}

              {editCalculated && editPreview && (
                <SettlementPreview
                  result={editPreview}
                  club={club}
                  formatAmount={formatVal}
                  formatSigned={formatSignedVal}
                  potDisplay="share"
                />
              )}

              {editConfirming && editPreview && (
                <SettlementConfirm
                  result={editPreview}
                  title="Update this session?"
                  warning="This re-settles the night under the club's rules and rewrites everyone's standings."
                  formatSigned={formatSignedVal}
                />
              )}

              {/* Deleting lives on the History row's own bin icon, not in here
                  — editing and destroying a night are different intents and
                  shouldn't sit a mis-tap apart. */}
              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => (editConfirming ? setEditConfirming(false) : setShowEditSessionModal(false))}
                  className="flex-1 border border-line text-text-muted font-bold py-3 rounded-xl hover:text-text transition-colors text-xs uppercase tracking-wider"
                >
                  {editConfirming ? 'Back' : 'Cancel'}
                </button>
                <button
                  type="submit"
                  disabled={submittingEdit || !editCalculated || !editPreview || editPreview.requiresManualResolution}
                  className={`flex-1 font-black py-3 rounded-xl text-xs uppercase tracking-widest cursor-pointer shadow-lg disabled:opacity-40 disabled:cursor-not-allowed ${editConfirming ? 'bg-warning text-accent-contrast' : 'bg-accent text-accent-contrast'}`}
                >
                  {submittingEdit
                    ? 'Saving…'
                    : editConfirming
                      ? 'Yes, update it'
                      : ((!isOwner && !isSuperUser && (club.adminUids || []).filter(u => u !== currentUser.uid && u !== club.ownerUid && u !== club.createdBy).length > 0)
                          ? 'Submit edit proposal'
                          : 'Update session')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: DELETE SESSION CONFIRMATION */}
      {deletingSessionTarget && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[60] flex items-center justify-center p-4">
          <div className="bg-surface border border-danger/80 w-full max-w-md p-6 rounded-3xl shadow-2xl space-y-5">
            <div className="flex items-center justify-between border-b border-line pb-3">
              <h3 className="text-base font-bold text-danger uppercase tracking-wider flex items-center gap-2">
                <Trash2 className="w-5 h-5 text-danger" /> Delete Session Record
              </h3>
              <button
                type="button"
                onClick={() => setDeletingSessionTarget(null)}
                className="text-text-muted hover:text-text cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-3 text-xs text-text font-sans">
              <p>
                Are you sure you want to delete <strong className="text-danger font-bold font-mono">{deletingSessionTarget.dayTitle || 'this session'}</strong> ({deletingSessionTarget.date})?
              </p>

              <div className="p-3 bg-bg border border-danger/60 rounded-xl space-y-1.5 font-mono text-[11px]">
                <div className="text-text-muted">Players: <span className="text-text font-bold">{deletingSessionTarget.playersCount}</span></div>
                <div className="text-text-muted">Total Buy-Ins: <span className="text-warning font-bold">{formatVal(deletingSessionTarget.totalBuyIns)}</span></div>
              </div>

              <p className="text-[11px] text-text-muted">
                ⚠️ This will soft-delete the session record and automatically recalculate player leaderboards and overall stats. You can restore this session anytime from the Audit Trail.
              </p>

              {(!isOwner && !isSuperUser && (club.adminUids || []).filter(u => u !== currentUser.uid && u !== club.ownerUid && u !== club.createdBy).length > 0) && (
                <div className="p-3 bg-warning/60 border border-warning/40 rounded-xl text-[11px] text-warning space-y-1">
                  <p className="font-bold flex items-center gap-1">
                    <ShieldAlert className="w-3.5 h-3.5 text-warning" /> Multi-Admin Governance
                  </p>
                  <p>
                    Submitting this deletion will create a proposal under 'Pending Approvals' for another Club Admin to review.
                  </p>
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-3 pt-2 border-t border-line">
              <button
                type="button"
                onClick={() => setDeletingSessionTarget(null)}
                className="px-4 py-2.5 bg-bg hover:bg-surface-alt border border-line text-text-muted font-bold rounded-xl text-xs uppercase cursor-pointer"
              >
                Cancel
              </button>

              <button
                type="button"
                disabled={submittingDelete}
                onClick={() => performDeleteSession(deletingSessionTarget)}
                className="px-5 py-2.5 bg-danger hover:bg-danger text-white font-black rounded-xl text-xs uppercase tracking-wider cursor-pointer shadow-lg disabled:opacity-50 flex items-center gap-1.5"
              >
                {submittingDelete ? 'Deleting...' : 'Confirm Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MOBILE FLOATING ACTION BUTTON (FAB) & STICKY BOTTOM NAVIGATION BAR */}
      <div className="md:hidden">
        {/* Quick Action Overlay Sheet */}
        {mobileFabOpen && (
          <div 
            className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex flex-col justify-end p-4 animate-in fade-in duration-200"
            onClick={() => setMobileFabOpen(false)}
          >
            <div 
              className="bg-surface border border-line rounded-3xl p-5 space-y-3 shadow-2xl mb-16"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between border-b border-line pb-3">
                <span className="text-xs font-black uppercase text-accent tracking-wider">
                  ⚡ Quick Actions
                </span>
                <button 
                  onClick={() => setMobileFabOpen(false)}
                  className="p-1 text-text-muted hover:text-text cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="space-y-2">
                <button
                  onClick={() => {
                    setMobileFabOpen(false);
                    setBuyInTargetUser(currentUser.uid);
                    setShowBuyInModal(true);
                  }}
                  className="w-full bg-accent hover:bg-accent text-accent-contrast font-black p-3.5 rounded-2xl text-xs uppercase tracking-wider flex items-center justify-center gap-2 shadow-lg cursor-pointer min-h-[48px]"
                >
                  <Plus className="w-4 h-4 stroke-[3]" /> Buy In
                </button>

                {/* Cashout is deliberately absent here — it has its own button
                    below the Approvals list. Only Start New Session, which has
                    no other home once a session has ended. */}
                {isAdmin && !activeSession && (
                  <button
                    onClick={() => {
                      setMobileFabOpen(false);
                      handleStartSession();
                    }}
                    className="w-full bg-surface-alt hover:bg-line-strong border border-line-strong text-text font-bold p-3.5 rounded-2xl text-xs uppercase tracking-wider flex items-center justify-center gap-2 cursor-pointer min-h-[48px]"
                  >
                    <Play className="w-4 h-4 text-accent" /> Start New Session
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Floating Action Button (FAB) */}
        <button
          onClick={() => setMobileFabOpen(!mobileFabOpen)}
          className="fixed bottom-20 right-4 z-40 w-14 h-14 bg-accent text-accent-contrast font-black rounded-full shadow-2xl flex items-center justify-center border-2 border-warning transition-transform active:scale-90 cursor-pointer"
          title="Quick Action Menu"
        >
          {mobileFabOpen ? <X className="w-6 h-6 stroke-[3]" /> : <Plus className="w-7 h-7 stroke-[3]" />}
        </button>

        {/* Sticky Bottom Navigation Bar */}
          <nav className="fixed bottom-0 left-0 right-0 z-40 bg-bg/95 backdrop-blur-xl border-t border-line py-2 px-1 flex items-center shadow-2xl">
            {navItems.map(item => {
              const isSelected = !item.isAction && activeTab === item.key;
              return (
                <button
                  key={item.key}
                  onClick={item.onSelect}
                  aria-current={isSelected ? 'page' : undefined}
                  className={`flex-1 min-w-0 flex flex-col items-center gap-1 px-0.5 py-1 rounded-xl transition-all cursor-pointer min-h-[48px] justify-center ${
                    isSelected ? 'text-accent' : 'text-text-muted hover:text-text'
                  }`}
                >
                  <div className="relative">
                    <item.Icon className={`w-5 h-5 ${item.iconClass ?? ''}`} />
                    {item.badge > 0 && (
                      <span className="absolute -top-1 -right-1.5 bg-danger text-white font-black text-[8px] w-3.5 h-3.5 rounded-full flex items-center justify-center">
                        {item.badge}
                      </span>
                    )}
                  </div>
                  <span className="text-[8px] font-bold uppercase tracking-tight font-sans leading-tight truncate max-w-full">
                    {item.label}
                  </span>
                </button>
              );
            })}
          </nav>
      </div>

      {/* QUICK LINK PLAYER TO REGISTERED MEMBER MODAL */}
      {showLinkModal && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-surface border border-line w-full max-w-md p-6 rounded-3xl shadow-2xl space-y-5">
            <div className="flex items-center justify-between border-b border-line pb-3">
              <h3 className="text-base font-bold text-text uppercase tracking-wider flex items-center gap-2">
                <LinkIcon className="w-5 h-5 text-accent" /> Link Player to Member
              </h3>
              <button onClick={() => setShowLinkModal(false)} className="text-text-muted hover:text-text cursor-pointer">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-4">
              <div className="p-3 bg-bg border border-line rounded-xl space-y-1 text-xs">
                <div className="text-[10px] text-text-muted font-bold uppercase">Ledger Player Entry:</div>
                <div className="text-text font-bold text-sm font-mono">{linkingPlayerName}</div>
                <div className="text-[10px] text-text-muted">Session: {linkingSession?.dayTitle || linkingSession?.sessionDate || 'Historical Session'}</div>
              </div>

              <div className="space-y-1.5">
                <label className="text-[11px] font-bold text-text-muted uppercase block">
                  Select Registered Club Member to Link:
                </label>
                <select
                  value={linkingSelectedUserUid}
                  onChange={(e) => setLinkingSelectedUserUid(e.target.value)}
                  className="w-full bg-bg border border-line rounded-xl p-3 text-xs text-text font-mono font-bold focus:border-accent outline-none"
                >
                  <option value="">-- Select Member Account --</option>
                  {allMembersList.map((mUid) => {
                    const u = allUsers[mUid];
                    const label = u?.displayName ? `${u.displayName} (${u.email || mUid.slice(0, 6)})` : `Member (${mUid.slice(0, 6)})`;
                    return (
                      <option key={mUid} value={mUid}>{label}</option>
                    );
                  })}
                </select>
                <p className="text-[10px] text-text-muted">
                  Linking this entry will connect the player's historical stats and earnings directly to their member profile.
                </p>
              </div>

              <div className="flex items-center gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowLinkModal(false)}
                  className="flex-1 py-2.5 bg-bg hover:bg-surface border border-line text-text-muted font-bold rounded-xl text-xs uppercase"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={!linkingSelectedUserUid || isSavingLink}
                  onClick={handleSavePlayerLink}
                  className="flex-1 py-2.5 bg-accent hover:bg-accent text-accent-contrast font-black rounded-xl text-xs uppercase cursor-pointer disabled:opacity-50 shadow-lg"
                >
                  {isSavingLink ? 'LINKING...' : 'SAVE PLAYER LINK'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <ToastContainer toasts={toasts} onDismiss={dismissToast} />

    </div>
  );
};
