import { useNavigate, useParams } from 'react-router-dom';
import { LiveSession } from './session/LiveSession';
import { deriveNight } from '../lib/night-state';
import { useResource, useResourceCache } from '../lib/resource-cache';
import { useConfirm } from './ui/ConfirmDialog';
import { type WaitingRow } from './session/WaitingForYou';
import { PlayerSheet } from './session/PlayerSheet';
import { AddPlayerSheet } from './session/AddPlayerSheet';
import { OpenTableSheet } from './session/OpenTableSheet';
import { ExtendSessionSheet } from './session/ExtendSessionSheet';
import { deriveFeed } from '../lib/night-feed';
import { selfApprovalBlock, WhoIsHere } from '../lib/approval-rules';
import { Button } from './ui/Button';
import { Sheet } from './ui/Sheet';
import { useAction } from '../lib/use-action';
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { AppUser as User } from '../lib/auth-types';
import { JoinRequestList } from './JoinRequestList';
import { getSocket } from '../lib/socket';
import { useSocketConnection } from '../lib/socket-connection';
import { useForegroundRecovery } from '../lib/use-foreground-recovery';
import * as clubsApi from '../lib/clubs-api';
import { ClubRosterEntry } from '../lib/clubs-api';
import { JOIN_REQUESTS_KEY } from '../lib/clubs-api';
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
import { SettlementPreview, SettlementConfirm, describeMismatch } from './SettlementPreview';
import { computeSummaryOffset } from '../lib/summary-offset';
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
  ToastMessage, ClubJoinRequest } from '../types';
import {
  Crown, 
  Users, 
  ShieldCheck, 
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
/**
 * Events whose whole meaning is "the session changed, and here it is".
 *
 * Every one carries the new session in its payload, so every one is handled the
 * same way: patch what is on screen. They are a LIST rather than eleven
 * hand-written pairs because the bug this fixes was a missing subscription —
 * PR #3 added seven emits on the server and zero listeners here, so starting a
 * night, extending the clock, freezing the table for settlement and four other
 * actions reached nobody else's phone until they reloaded.
 *
 * Registering and tearing down by iterating this list makes "every on has an
 * off" structural instead of something to remember, and gives
 * ClubDetailView.realtime.test.tsx something to check the server against.
 */
export const SESSION_PATCH_EVENTS = [
  'club:sitin-requested',
  'club:sitin-decided',
  'club:cashout-requested',
  'club:cashout-decided',
  'club:session-started-playing',
  'club:session-extended',
  'club:session-time-limit-lifted',
  'club:settling-started',
  'club:settling-cancelled',
  'club:cashout-amended',
  'club:lobby-player-removed',
  // Setting a night's rake or winners' cut decides what every player's chips
  // are worth at the end. Nobody should learn that by refreshing.
  'club:settlement-rules-set',
] as const;

/**
 * Settlement amount fields must render at 16px or larger.
 *
 * MEASURED on an iPhone, not inferred. With a 12px input focused, iOS Safari
 * zooms the page to 1.3333 — exactly 16/12 — to bring the text to its
 * readability threshold. That shrinks the visual viewport from 402 to 302 CSS
 * px, and Safari then scrolls fully right: offsetLeft 100, which is precisely
 * the 402 − 302 difference. The left column of the count disappears.
 *
 * There is no horizontal overflow to blame. With the keyboard down the same
 * device reports scale 1, viewport 402, and scrollWidth === innerWidth === 402.
 *
 * 16px is a threshold, not a preference: 14px still zooms, at 16/14 = 1.1428.
 * Only the two fields in the count are raised — the other twelve-pixel inputs
 * belong to club settings and the past-session form, which were not measured.
 */
const SETTLEMENT_AMOUNT_INPUT =
  'w-full furniture rounded-xl px-3 py-2 text-base font-mono font-medium text-text focus:border-accent outline-none';

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
  /** Captured per render: writes from this render belong to this identity. */
  const write = cache.beginWrite();
  const clubKey = `club:${initialClub.id}`;
  // Destructive actions ask in a bottom sheet rather than a browser dialog.
  const confirmAction = useConfirm();

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
  /**
   * Write-through for the five endpoints that answer with the whole session.
   *
   * Not optimistic: it runs after the server has confirmed, so there is nothing
   * to roll back. It exists because every one of these paths used to discard
   * the response and then immediately GET the same session back.
   */
  const applySession = useCallback(
    (session: PokerSession) =>
      cache.update<SessionResource>(`club:${initialClub.id}:active-session`, (prev) =>
        prev ? { ...prev, session } : { session, buyIns: [] }
      ,
      write),
    [cache, initialClub.id]
  );

  /** Write-through for mutations that return the updated club. */
  const setClub = useCallback(
    (updated: Club) => cache.update<Club>(clubKey, () => updated, write),
    [cache, clubKey]
  );



  // Whether this client is actually receiving live updates. Surfaced in the
  // header because the failure mode is silent: a dropped socket leaves the
  // table looking perfectly normal while it quietly stops changing, and an
  // admin has no way to tell they're settling against a stale view.
  //
  // Read from the socket rather than assumed. This used to be a boolean
  // initialised to `true`, so a socket that had never connected once still
  // displayed as live — the exact case the badge exists to catch.
  const socketConnection = useSocketConnection(getSocket());
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
  const connection: 'live' | 'reconnecting' | 'offline' | 'auth-error' = !browserOnline
    ? 'offline'
    : socketConnection.state === 'auth-error'
      ? 'auth-error'
      : socketConnection.state === 'connected'
        ? 'live'
        : 'reconnecting';

  /**
   * The badge's copy, decided here rather than in three parallel ternaries in
   * the markup.
   *
   * `auth-error` reads as danger rather than warning because nothing is going to
   * retry it: socket.io-client destroys a socket whose handshake the server
   * refused. "Reconnecting" would promise a recovery that is never coming. The
   * server's own wording stays in the tooltip — it names the cause precisely
   * (missing token versus expired one) and that is worth keeping reachable —
   * but it is not what a player reads first.
   */
  const connectionBadge =
    connection === 'offline'
      ? {
          label: 'Offline',
          tone: 'danger' as const,
          title: 'This device is offline — figures may be out of date.',
        }
      : connection === 'auth-error'
        ? {
            label: 'Session expired',
            tone: 'danger' as const,
            title: `Live updates have stopped and will not resume on their own. Sign in again to restore them.${
              socketConnection.message ? ` (${socketConnection.message})` : ''
            }`,
          }
        : {
            label: 'Reconnecting',
            tone: 'warning' as const,
            title: 'Reconnecting — figures may be out of date until this clears.',
          };

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
  /*
   * The RAW text of each field, not a number.
   *
   * These held numbers and coerced on every keystroke, which breaks a
   * controlled numeric input in two ways a host hits while counting chips.
   * Clearing a field gave Number('') === 0, so the box refilled itself with a
   * zero that could not be deleted — and then typing 5000 in front of it read
   * back as 50000, a tenfold error in a figure nobody would look at twice.
   * Typing after it showed 05000.
   *
   * Worse, that phantom zero counted as an entered cash-out: `uid in
   * cashOutInputs` was true, so Auto Calculate unlocked and would settle a
   * player at nothing they had agreed to.
   *
   * Text in, coerced once where the arithmetic happens. An empty string stays
   * empty, and "not filled in yet" stays distinguishable from "zero".
   */
  const [cashOutInputs, setCashOutInputs] = useState<Record<string, string>>({});
  const [buyInInputs, setBuyInInputs] = useState<Record<string, string>>({});
  const [manualWinnerInputs, setManualWinnerInputs] = useState<Record<string, boolean>>({});
  /*
   * An acknowledgement belongs to the figures it was made against.
   *
   * It is a bare boolean, and it used to be cleared in exactly one place —
   * openCashoutModal. The checkbox that sets it lives INSIDE the preview
   * panel, and ticking it makes the engine return requiresManualResolution
   * false, which unmounts the block and takes the ticked box off screen. So:
   * acknowledge a 300 shortfall, notice a typo, correct a cash-out from 2,000
   * to 32,000, re-calculate — the night now carries a 30,000 mismatch, no
   * warning renders because the flag is still true, and Settle is enabled. The
   * admin acknowledged a different number.
   *
   * Every path that moves a figure now clears it, which is precisely what
   * cashoutCalculated already did. That is the coherent rule rather than the
   * convenient one: the acknowledgement is made by reading the preview, so it
   * cannot outlive the preview.
   *
   * Binding it to the mismatch AMOUNT instead was considered and rejected as
   * machinery for a case that does not arise — no single edit leaves the
   * acknowledged state materially unchanged. Any buy-in or cash-out edit moves
   * mismatchAmount by construction (settlementEngine: totalCashOuts −
   * totalBuyIns), and the winner checkbox changes who an excess is charged to
   * (applyExcessToWinners), which is the other half of what was acknowledged.
   */
  const [mismatchAcknowledged, setMismatchAcknowledged] = useState(false);
  /** A remote change invalidated what this admin was in the middle of reviewing. */
  const [remoteFiguresMoved, setRemoteFiguresMoved] = useState(false);
  const [settlementError, setSettlementError] = useState('');
  const [showCashoutModal, setShowCashoutModal] = useState(false);
  /**
   * The recovery path for a night with no rules of its own.
   *
   * The server has refused to settle such nights since rule-snapshotting
   * shipped, and refused correctly — but the endpoint that gives a night its
   * rules (initSettlementRules) had no caller anywhere in the client, so the
   * refusal was a dead end: the settlement sheet told the host "somebody"
   * must set the rake and cut, and the product contained no way for anybody
   * to do it. Every pre-snapshot night was permanently unsettleable.
   *
   * The ask happens BEFORE the freeze, not inside the settlement sheet,
   * because the server accepts the rules only while the night is `playing` —
   * a form inside the sheet (which exists only once the night is `settling`)
   * would be a control that can never succeed.
   */
  const [showNightRulesSheet, setShowNightRulesSheet] = useState(false);
  const [nightRakeInput, setNightRakeInput] = useState('');
  const [nightCutInput, setNightCutInput] = useState('');
  const [nightRulesError, setNightRulesError] = useState('');
  const [nightRulesSaving, setNightRulesSaving] = useState(false);
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
    confirmAction({
      title: `Remove ${name}?`,
      description: `They lose access to ${club.name} and its history. Past results stay on the leaderboard.`,
      confirmLabel: 'Remove',
      onConfirm: async () => {
        try {
          const updated = await clubsApi.removeMember(club.id, targetUid);
          setClub(updated);
          pushToast('Member removed', `${name} no longer has access to ${club.name}.`, 'success');
        } catch (err) {
          console.error('Failed to remove member:', err);
          pushToast('Could not remove member', err instanceof Error ? err.message : 'Please try again.', 'warning');
        }
      },
    });
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
          className={`px-3 py-1 rounded-full text-[10px] font-semibold uppercase tracking-wider transition-colors ${
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

  // What is actually on the table right now: everything bought in, less
  // anything an admin has already confirmed out. Buy-ins alone would keep
  // counting chips that have left with the player who cashed them.

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


  const sessionCashOuts = activeSession?.cashOuts || [];

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
        // Compared as text, because that is what the field holds now. An
        // admin amending a confirmed count mid-settlement lands here, and the
        // locked figure is the authority over anything typed.
        const asText = String(amt);
        if (next[uid] !== asText) {
          next[uid] = asText;
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [confirmedCashOutByUid]);

  /*
   * A confirmed cash-out arriving or being amended is a figure change too.
   *
   * The effect above mirrors it into the form — deliberately, because the
   * server settles on that number whatever the field says. But it is not the
   * admin typing: it comes from somebody else's phone, through the socket,
   * while this screen is open. So none of the three onChange handlers run, and
   * before this nothing was invalidated at all: not the preview, and not an
   * acknowledgement made against it.
   *
   * That is the same defect as the typed paths and strictly harder to notice,
   * because the admin did not do anything.
   *
   * Keyed on the memo, which is itself keyed on JSON.stringify(sessionCashOuts)
   * — so this fires when a cash-out genuinely changes and not on every render.
   * Clearing on mount is harmless: openCashoutModal resets all three anyway.
   */
  const confirmingRef = useRef(false);
  const acknowledgedRef = useRef(false);
  useEffect(() => { confirmingRef.current = confirmingSettle; }, [confirmingSettle]);
  useEffect(() => { acknowledgedRef.current = mismatchAcknowledged; }, [mismatchAcknowledged]);

  useEffect(() => {
    /*
      Clearing both is right — the figures moved, so neither an acknowledgement
      nor an armed confirmation can stand against them. Doing it in SILENCE was
      the problem: this admin did nothing, and the screen simply stopped
      offering to settle. An unexplained refusal on a money screen reads as a
      bug, and the reflex is to press the button again.

      The refs exist because this effect keys on the cash-outs alone. Putting
      the two states in its deps would re-run it on every acknowledgement and
      clear the thing that had just been set.
    */
    if (confirmingRef.current || acknowledgedRef.current) setRemoteFiguresMoved(true);
    setMismatchAcknowledged(false);
    setConfirmingSettle(false);
  }, [confirmedCashOutByUid]);

  /*
    Keep IN / OUT / DIFF on screen while the keyboard is up.

    Measured on an iPhone: with the numeric keyboard open, visualViewport.height
    went 656 → 356 and offsetTop 0 → 263. Safari shifts the VISUAL viewport to
    keep the focused field in view, which carries the top of the panel — header
    and this summary — out of the visible band. dvh does not help; it tracks the
    layout viewport, which did not move. Sticky does not help either; it sticks
    to the scroller, and the scroller is what left.

    So the bar is translated back down into the band, by transform rather than
    top: visualViewport fires continuously through the keyboard animation, and
    anything that triggers layout chases the keyboard instead of tracking it.

    The base position is read with the transform removed, because the element's
    own rect includes whatever was applied last — measuring without clearing it
    first feeds the offset back into itself.
  */
  const summaryRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const vv = window.visualViewport;
    const el = summaryRef.current;
    if (!vv || !el || !showCashoutModal) return;

    let frame = 0;
    const apply = () => {
      frame = 0;
      const node = summaryRef.current;
      if (!node) return;

      node.style.transform = '';
      const rect = node.getBoundingClientRect();

      const active = document.activeElement as HTMLElement | null;
      const focusedTop =
        active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')
          ? active.getBoundingClientRect().top
          : null;

      const offset = computeSummaryOffset({
        summaryBaseTop: rect.top,
        summaryHeight: rect.height,
        viewportOffsetTop: vv.offsetTop,
        focusedTop,
      });
      node.style.transform = offset > 0 ? `translateY(${offset}px)` : '';
    };

    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(apply);
    };

    apply();
    vv.addEventListener('resize', schedule);
    vv.addEventListener('scroll', schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      vv.removeEventListener('resize', schedule);
      vv.removeEventListener('scroll', schedule);
      const node = summaryRef.current;
      if (node) node.style.transform = '';
    };
  }, [showCashoutModal]);

  // The redesigned screen derives everything it needs from one place, rather
  // than from the two dozen inline computations above that it will replace.
  const night = useMemo(
    () =>
      deriveNight({
        session: activeSession ?? null,
        buyIns: buyInRequests,
        currentUserId: currentUser.uid,
        isAdmin,
      }),
    [activeSession, buyInRequests, currentUser.uid, isAdmin]
  );


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

  // Comes with the club record now, on the same payload the ids come from, so
  // there is no second request and nothing separate to refresh: whatever
  // refreshes the club refreshes the roster with it.
  const allUsers = club.roster ?? EMPTY_ROSTER;

  /*
   * Requests to join THIS club.
   *
   * The endpoint is the same one the dashboard uses — it already returns only
   * what this user may see (their own outgoing requests, plus incoming ones
   * for clubs they admin), so the filtering here is about scope, not secrecy.
   * A null key for a non-admin means the request is never issued at all.
   */
  /**
   * Shared with the dashboard rather than club-scoped.
   *
   * The endpoint returns every request this user can see, so a club-specific
   * key was a second copy of one payload — and because the cache single-flights
   * per key, opening a club refetched what the dashboard had just fetched. One
   * key means one request, and the dashboard's poll keeps this fresh too.
   */
  const joinRequestsRes = useResource<ClubJoinRequest[]>(
    isAdmin ? JOIN_REQUESTS_KEY : null,
    () => clubsApi.listJoinRequests()
  );
  const refreshJoinRequests = joinRequestsRes.refresh;
  const clubJoinRequests = useMemo(
    () => (joinRequestsRes.data ?? []).filter((r) => r.clubId === initialClub.id && r.status === 'pending'),
    [joinRequestsRes.data, initialClub.id]
  );

  /*
   * Throws on failure, which is the contract JoinRequestList relies on to tell
   * "someone else decided this" apart from "this genuinely broke".
   *
   * Accepting changes the roster and the member list. Both now travel on the
   * club record, so refreshing the club refreshes the roster with it; rejecting
   * changes neither and costs one request.
   */
  const decideJoinRequest = useCallback(
    async (request: ClubJoinRequest, accept: boolean) => {
      await clubsApi.decideJoinRequest(request.clubId, request.id, accept);
      await joinRequestsRes.refresh();
      if (accept) {
        await refreshClub();
      }
    },
    [joinRequestsRes, refreshClub]
  );



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

  /**
   * Re-join this club's room and refetch everything the room could have changed.
   *
   * Lifted to component scope because two separate paths need it and must stay
   * identical: a socket `connect`, and the user returning to the app. Defining
   * it twice would let them drift.
   */
  const resync = useCallback(() => {
    const socket = getSocket();
    socket.emit('club:join', initialClub.id);
    refreshClub();
    refreshActiveSession();
    refreshHistory();
    refreshLeaderboard();
    refreshPotLog();
    refreshPendingChanges();
    refreshAuditTrail();
    // Join requests arrive from people outside the room, so no club event
    // announces them. Without this they were the one resource on this screen a
    // reconnect or a foreground resume left stale.
    refreshJoinRequests();
  }, [
    initialClub.id,
    refreshClub,
    refreshActiveSession,
    refreshHistory,
    refreshLeaderboard,
    refreshPotLog,
    refreshPendingChanges,
    refreshAuditTrail,
    refreshJoinRequests,
  ]);

  /**
   * Coming back to the app makes the data current again.
   *
   * This screen has no polling and no timer, so without this its only route to
   * fresh data is the socket — and the failure being fixed is a socket that has
   * died silently while the tab was backgrounded, still reporting `connected`.
   * The refetch therefore runs on every resume regardless of that flag; see
   * use-foreground-recovery.ts for why trusting it is the bug.
   */
  useForegroundRecovery({
    socket: getSocket(),
    authFailed: socketConnection.state === 'auth-error',
    onResume: resync,
  });

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
    // Connection state is tracked by useSocketConnection; this listener exists
    // only for the re-join and refetch. `resync` is shared with the foreground
    // recovery path above so the two cannot diverge.
    const onConnect = () => { resync(); };

    socket.on('connect', onConnect);

    // Already connected when this mounted — 'connect' won't fire again.
    if (socket.connected) socket.emit('club:join', initialClub.id);

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
      ,
      write);
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
      },
      write);
    };

    const onSessionStarted = (p: { session?: ApiOfflineSession | null }) => {
      // A new session means the previous night's buy-ins are no longer this
      // table's, so they are cleared rather than carried over.
      if (!p?.session) return refreshActiveSession();
      cache.update<SessionResource>(`${clubKey}:active-session`, () => ({
        session: offlineSessionsApi.toPokerSession(p.session!),
        buyIns: [],
      }),
      write);
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
    /*
     * One handler for every event that just carries the new session.
     *
     * The two that also have something to SAY still say it — an expired request
     * vanishing without explanation reads as the app losing it — but the state
     * they all produce is the same patch, so it is written once.
     */
    const onSessionEvent = (
      p: { userId?: string; expired?: boolean; session?: ApiOfflineSession | null },
      event?: string
    ) => {
      if (event === 'club:sitin-decided') {
        notifyIfExpired(p, 'Sit-in request', 'Ask again when someone is at the console.');
      }
      if (event === 'club:cashout-decided') {
        notifyIfExpired(p, 'Cash-out', 'Re-count your chips and send it again.');
      }
      patchSession(p);
    };
    const sessionHandlers = SESSION_PATCH_EVENTS.map(
      (event) => [event, (p: Parameters<typeof onSessionEvent>[0]) => onSessionEvent(p, event)] as const
    );
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
    for (const [event, handler] of sessionHandlers) socket.on(event, handler);
    socket.on('club:session-settled', onSessionSettled);
    socket.on('club:history-updated', onHistoryUpdated);
    socket.on('club:pending-request', onPendingRequest);
    socket.on('club:pending-request-decided', onPendingRequestDecided);

    return () => {
      socket.emit('club:leave', initialClub.id);
      socket.off('connect', onConnect);
      socket.off('club:session-started', onSessionStarted);
      socket.off('club:buyin-requested', onBuyinRequested);
      socket.off('club:buyin-decided', onBuyinDecided);
      for (const [event, handler] of sessionHandlers) socket.off(event, handler);
      socket.off('club:session-settled', onSessionSettled);
      socket.off('club:history-updated', onHistoryUpdated);
      socket.off('club:pending-request', onPendingRequest);
      socket.off('club:pending-request-decided', onPendingRequestDecided);
    };
  }, [initialClub.id, resync, refreshActiveSession, refreshHistory, refreshLeaderboard, refreshPotLog, refreshClub, refreshAuditTrail, refreshPendingChanges, pushToast, currentUser.uid, cache, clubKey]);

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
  const handleStartSession = async (options: { durationMinutes?: number } = {}) => {
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
      const started = await offlineSessionsApi.startSession(club.id, {
        sessionType: 'OFFLINE',
        sessionName,
        durationMinutes: options.durationMinutes,
      });
      // A new session starts with no buy-ins, so the previous night's are
      // cleared rather than carried across.
      cache.update<SessionResource>(`${clubKey}:active-session`, () => ({ session: started, buyIns: [] }), write);
      // "Open", not "started". The table is open for people to gather; the
      // night itself has not begun and will not until the host says so.
      pushToast('Table open', `${sessionName}. People can join and buy in — start the game when you're ready.`, 'success');
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

  // Ask to be dealt in — goes to an admin rather than seating immediately.

  const handleDecideSitIn = async (userId: string, approve: boolean) => {
    if (!isAdmin || !activeSession) {
      pushToast(!activeSession ? 'No live session' : 'Not allowed', !activeSession ? 'There is nothing running right now.' : 'Only a Club Admin can do this.', 'warning');
      return;
    }
    const name = allUsers[userId]?.displayName || 'Player';
    try {
      applySession(await offlineSessionsApi.decideSitIn(club.id, activeSession.id, userId, approve));
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
      applySession(await offlineSessionsApi.requestCashOut(club.id, activeSession.id, Number(standUpAmount)));
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
      applySession(await offlineSessionsApi.decideCashOut(club.id, activeSession.id, userId, approve));
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
      ,
      write);

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
    // Both taken before the request goes out: the snapshot for the rollback, the
    // token so the write-through below can prove which identity authorised it.
    // Reading either after the await would read the new user's answer.
    const previous = cache.snapshot<SessionResource>(key);
    const verb = approve ? 'approve' : 'reject';

    cache.update<SessionResource>(key, (prev) =>
      prev
        ? {
            ...prev,
            buyIns: prev.buyIns.map((b) =>
              b.id === request.id ? { ...b, status: approve ? 'approved' : 'rejected' } : b
            ),
          }
        : prev!,
      write
    );

    try {
      const session = await offlineSessionsApi.decideBuyInRequest(club.id, activeSession!.id, request.id, approve);
      // The POST already returns the updated session, including the seating
      // change an approval causes. Taking it from the response is what removes
      // the last GET from this path.
      if (session) {
        cache.update<SessionResource>(key, (prev) => (prev ? { ...prev, session } : { session, buyIns: [] }), write);
      }
    } catch (err) {
      // Every failure the server can return here — expired request, already
      // decided, no longer admin — reaches the user, and the optimistic row
      // goes back to exactly what it was.
      cache.restore(key, previous);
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
  /**
   * The club's rules — for a night that has not started, and for back-dated
   * records, which genuinely have no session to take rules from.
   */
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

  /**
   * What the LIVE night settles by — its own snapshot, never the club.
   *
   * The preview an admin approves has to be computed from the same rules the
   * server will use, or they sign off on figures that are not the ones
   * committed. Reading the club here would put that disagreement back exactly
   * where the snapshot removed it: a settings change between kick-off and
   * Confirm would show one set of numbers and write another.
   *
   * Null when the night has no rules yet. The screen says so and holds the
   * Calculate button rather than quietly substituting the club's.
   */
  const sessionSettlementRules = activeSession?.settlementRules ?? null;
  const liveSettlementSettings: SettlementSettings | null = sessionSettlementRules
    ? {
        sessionRakeAmount: sessionSettlementRules.sessionRakeAmount,
        winnersCutPercent: sessionSettlementRules.winnersCutPercent,
        rakeEnabled: sessionSettlementRules.rakeEnabled,
        rakeMethod: sessionSettlementRules.rakeMethod as SettlementSettings['rakeMethod'],
        rakeValue: sessionSettlementRules.rakeValue,
        potEnabled: sessionSettlementRules.potEnabled,
        mismatchStrategy: sessionSettlementRules.mismatchStrategy as SettlementSettings['mismatchStrategy'],
        rakeOrder: sessionSettlementRules.rakeOrder as SettlementSettings['rakeOrder'],
        winnerDefinition: sessionSettlementRules.winnerDefinition as SettlementSettings['winnerDefinition'],
        winnerTopN: sessionSettlementRules.winnerTopN,
        roundingRule: sessionSettlementRules.roundingRule as SettlementSettings['roundingRule'],
      }
    : null;

  const calculateSettlement = (): SettlementResult | null => {
    if (!activeSession) return null;
    // No rules, no preview. Falling back to the club here would show the admin
    // figures the server is going to refuse to commit.
    if (!liveSettlementSettings) return null;

    const players = settlementUids.map(uid => ({
      userId: uid,
      userDisplayName: uid === currentUser.uid
        ? (currentUser.displayName || currentUser.email?.split('@')[0] || 'Me')
        : (allUsers[uid]?.displayName || `Player (${uid.slice(0, 5)})`),
      buyIn: Number(buyInInputs[uid] || 0),
      cashOut: Number(cashOutInputs[uid] || 0),
      manualWinner: manualWinnerInputs[uid],
    }));

    return computeSettlement(players, liveSettlementSettings, {
      // The pot as it stands NOW — a balance, not a rule, and deliberately not
      // part of the night's snapshot.
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
  // before the record button unlocks again — and with it any acknowledgement
  // made by reading that preview. See the note on the live flow's own
  // invalidation: an acknowledgement that outlives its figures is an
  // acknowledgement of a different night.
  useEffect(() => {
    setPastCalculated(false);
    setPastConfirming(false);
    setPastMismatchAcknowledged(false);
  }, [JSON.stringify(pastRows), pastDate]);

  const preview = calculateSettlement();
  /**
   * Every player has a figure — a real one, not a blank box.
   *
   * `uid in cashOutInputs` was the whole test, so a field the host had cleared
   * still counted: the key was there holding a coerced 0. Auto Calculate
   * unlocked and settled somebody at zero they never agreed to. A blank is
   * "not counted yet" and must hold the gate shut.
   */
  const enteredAmount = (v: string | undefined) =>
    v !== undefined && v.trim() !== '' && Number.isFinite(Number(v));
  const allCashOutsEntered = activeSession
    ? settlementUids.every(uid => enteredAmount(cashOutInputs[uid]))
    : false;

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
    const initialBuyIns: Record<string, string> = {};
    settlementUids.forEach(uid => {
      initialBuyIns[uid] = String(
        activeSessionBuyIns.filter(r => r.userId === uid).reduce((sum, r) => sum + r.amount, 0)
      );
    });
    setBuyInInputs(initialBuyIns);
    setCashOutInputs(
      Object.fromEntries(Object.entries(confirmedCashOutByUid).map(([uid, amount]) => [uid, String(amount)]))
    );
    setManualWinnerInputs({});
    setMismatchAcknowledged(false);
    setSettlementError('');
    setConfirmingSettle(false);
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
    // `preview` is null when the night has no rules of its own, which is the
    // one case the count being complete does not cover.
    if (!preview) {
      pushToast('No rules for this night', 'It cannot be settled until somebody sets its rake and winners\' cut.', 'warning');
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

    /*
     * Captured BEFORE the awaits, because they are gone afterwards.
     *
     * Settling ends the night: refreshActiveSession then resolves to no active
     * session, and `preview` recomputes from a form that is about to unmount.
     * The toast has to describe the night that was just committed, not whatever
     * the screen holds a tick later.
     *
     * Both are non-null here — every guard above returns rather than falling
     * through.
     */
    const settledNight = activeSession.sessionName;
    const settled = preview;

    try {
      const entries = settlementUids.map(uid => ({
        userId: uid,
        buyIn: Number(buyInInputs[uid] || 0),
        cashOut: Number(cashOutInputs[uid] || 0),
        manualWinner: manualWinnerInputs[uid],
      }));
      await offlineSessionsApi.settleSession(club.id, activeSession.id, { entries, mismatchAcknowledged });
      await Promise.all([refreshActiveSession(), refreshHistory(), refreshLeaderboard(), refreshPotLog(), refreshClub()]);
      /*
       * The most irreversible act in the product used to say nothing at all.
       *
       * This message was written to `settlementSuccess`, a state with no render
       * site anywhere in the file — so the modal simply vanished. On a money
       * screen "nothing happened" reads as "press it again", which is the
       * behaviour use-action.ts exists to prevent and which once produced
       * twenty duplicate rows.
       *
       * Toast, because that is already this app's success channel for every
       * other money action — the bank request, the cash-out, opening the table.
       * Pushed BEFORE the modal closes, and ToastContainer sits at z-[60] above
       * the modal, so the acknowledgement is on screen as the surface leaves.
       *
       * Figures come from the settlement that was actually committed, through
       * the same unit-aware formatter the screen uses, so a club reading in
       * rupees is told in rupees.
       */
      pushToast(
        'Night settled',
        `${settledNight} — ${formatUnit(settled.totalBuyIns)} in, ${formatUnit(settled.totalCashOuts)} out.` +
          (settled.potContribution !== 0
            ? ` Club Pot ${formatSignedUnit(settled.potContribution)}.`
            : ''),
        'success'
      );
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

  /** Buy-ins are known from the moment the screen opens; cash-outs are not. */
  const settlementTotalIn = settlementUids.reduce(
    (sum, uid) => sum + (Number(buyInInputs[uid]) || 0),
    0
  );

  /*
    The action row, in Sheet's footer slot rather than at the bottom of the
    scroll.

    Sheet renders the footer outside the overflow-y-auto child and in
    flex-col-reverse, so on a phone the way OUT sits under the thumb and the
    irreversible one above it. That ordering is the reason ConfirmDialog puts
    cancel first, and it is why these are in DOM order Go Back → Confirm.
  */
  const settlementFooter = !confirmingSettle ? (
    <button
      onClick={() => { setRemoteFiguresMoved(false); setConfirmingSettle(true); }}
      disabled={!allCashOutsEntered || !preview || preview.requiresManualResolution}
      className="w-full bg-accent hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed text-accent-contrast font-semibold py-3.5 rounded-xl text-xs cursor-pointer shadow-lg"
    >
      Settle Session
    </button>
  ) : (
    <>
      <button
        onClick={() => setConfirmingSettle(false)}
        className="flex-1 bg-surface-alt border border-line-strong text-text font-medium py-3 rounded-xl text-xs cursor-pointer"
      >
        Go Back
      </button>
      <button
        onClick={() => { setConfirmingSettle(false); settleAction.run(); }}
        disabled={settleAction.pending}
        className="flex-1 bg-accent text-accent-contrast font-semibold py-3 rounded-xl text-xs cursor-pointer shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {settleAction.pending ? 'Settling…' : 'Confirm & Settle'}
      </button>
    </>
  );

  const startSessionAction = useAction(handleStartSession);
  const requestBuyInAction = useAction(handleRequestBuyIn);
  const standUpAction = useAction(handleStandUp);
  const decideSitInAction = useAction(handleDecideSitIn);
  const decideCashOutAction = useAction(handleDecideCashOut);
  const approveBuyInAction = useAction(handleApproveBuyIn);
  const rejectBuyInAction = useAction(handleRejectBuyIn);

  /**
   * What the one primary action should say right now.
   *
   * Not a menu title. The screen has a next thing to do, and the button should
   * name it rather than hiding it behind a generic plus.
   */

  /**
   * Who is at this table, for the self-approval rule.
   *
   * Presence, not roster: an admin who has cashed out and driven home cannot be
   * the second pair of eyes, and counting them is what deadlocks a night that
   * the owner opened and then left. Mirrors hasAnotherAdminHere on the server.
   *
   * MUST STAY ABOVE every memo that reads it — waitingForYou today. useMemo
   * runs its callback during the render it is declared in, so a reader declared
   * above this line reads it inside the temporal dead zone and throws
   * "Cannot access 'whoIsHere' before initialization", taking the whole club
   * screen into the ErrorBoundary for any admin with a pending buy-in. That
   * reached production once; ClubDetailView.render.test.tsx is what would catch
   * it happening again.
   */
  const whoIsHere = useMemo<WhoIsHere>(() => ({
    ownerUid: club.ownerUid ?? club.createdBy,
    adminUids: club.adminUids ?? [],
    seatedUids: activeSession?.activePlayerUids ?? [],
    pendingSitInUids: activeSession?.pendingSitInUids ?? [],
    cashedOutUids: (activeSession?.cashOuts ?? [])
      .filter((c) => c.status === 'confirmed')
      .map((c) => c.userId),
  }), [club.ownerUid, club.createdBy, club.adminUids, activeSession]);


  /**
   * The same three request types, as one list of people.
   *
   * night.queue decides what is waiting and in what order; this attaches the
   * faces, the permission rules and the mutations. Splitting it that way keeps
   * "who is waiting" pure and testable, and keeps the permission rules next to
   * the other permission rules.
   */


  const waitingForYou = useMemo<WaitingRow[]>(() => {
    if (!activeSession) return [];

    return night.queue.map((q) => {
      const name = q.userId === currentUser.uid ? 'You' : allUsers[q.userId]?.displayName || 'Player';
      const base = { ...q, name, avatarUrl: allUsers[q.userId]?.avatarUrl };

      if (q.kind === 'buy-in') {
        const req = buyInRequests.find((r) => r.id === q.id);
        // An admin may not wave through a buy-in that credits themselves —
        // mirrors offlineSessions.service.ts. Naming an admin who is actually
        // here matters: a block that names someone who went home costs the
        // host three taps to discover.
        // The author is whoever wrote the request, which is not always the
        // person receiving the chips — an admin banking somebody else is its
        // author, and may not then wave it through.
        const blocked = req && !isSuperUser
          ? selfApprovalBlock(whoIsHere, currentUser.uid, req.requestedBy, 'buy-in')
          : null;
        return {
          ...base,
          blockedReason: blocked,
          pending: req ? approveBuyInAction.isPending(req.id) || rejectBuyInAction.isPending(req.id) : false,
          onApprove: () => req && approveBuyInAction.run(req),
          onDismiss: () => req && rejectBuyInAction.run(req),
        };
      }

      if (q.kind === 'sit-in') {
        return {
          ...base,
          pending: decideSitInAction.isPending(q.userId),
          onApprove: () => decideSitInAction.run(q.userId, true),
          onDismiss: () => decideSitInAction.run(q.userId, false),
        };
      }

      // A cash-out is the largest money movement of the night, so it carries
      // the same rule a buy-in does: you cannot wave through your own while
      // there is another admin here to look at it.
      return {
        ...base,
        blockedReason: isSuperUser
          ? null
          : selfApprovalBlock(whoIsHere, currentUser.uid, q.userId, 'cash-out'),
        pending: decideCashOutAction.isPending(q.userId),
        onApprove: () => decideCashOutAction.run(q.userId, true),
        onDismiss: () => decideCashOutAction.run(q.userId, false),
      };
    });
  }, [
    activeSession, night.queue, allUsers, buyInRequests, currentUser.uid,
    whoIsHere, isSuperUser,
    approveBuyInAction, rejectBuyInAction, decideSitInAction, decideCashOutAction,
  ]);

  /**
   * The sheet's actions, connected.
   *
   * THE INVARIANT: nobody can give themselves chips, and no buy-in skips the
   * queue. Whoever creates it — the player, the host, another admin — it lands
   * as pending and somebody else approves it.
   *
   * An earlier version auto-approved when an admin banked another player, on
   * the reasoning that the admin was already the approving authority. That is
   * true about the RECIPIENT check and false about oversight: with two admins
   * seated it let either of them create chips for a friend with nobody
   * watching. Every buy-in now enters the queue, and the server's existing
   * rule does the rest — the creator cannot approve their own request while
   * another admin is present, and may when they are the only one, so a
   * one-admin game is never blocked.
   */
  const [sheetUid, setSheetUid] = useState<string | null>(null);
  const [sheetBusy, setSheetBusy] = useState(false);
  const [addPlayerOpen, setAddPlayerOpen] = useState(false);
  // Set only by the stud on the felt, which already means chips — so the sheet
  // opens on the amount rather than on a menu offering to ask the same thing.
  const [sheetAsksForChips, setSheetAsksForChips] = useState(false);
  const [openTableOpen, setOpenTableOpen] = useState(false);
  const [startingPlay, setStartingPlay] = useState(false);
  const [extendOpen, setExtendOpen] = useState(false);
  const [clockBusy, setClockBusy] = useState(false);

  /**
   * Settling stops the table.
   *
   * Figures cannot be agreed while they are still changing underneath, so the
   * server refuses every mutation from here. Reversible, which is what makes it
   * safe to put behind a single tap.
   */
  const beginSettling = async () => {
    if (!activeSession || clockBusy) return;
    setClockBusy(true);
    try {
      // Already frozen — the host closed the screen and came back to it. The
      // server refuses beginSettling from `settling` (it is legal only from
      // `playing`), so asking a second time would refuse the host entry to the
      // very screen the freeze exists to open.
      if (!activeSession.settlingAt) {
        // A night with no rules of its own cannot settle, and the server only
        // accepts its rules while it is still `playing` — so the ask has to
        // come before the freeze. Frozen legacy nights get the same ask after
        // "Back to the table"; the settlement sheet's warning says so.
        if (!activeSession.settlementRules) {
          setNightRulesError('');
          setShowNightRulesSheet(true);
          return;
        }
        applySession(await offlineSessionsApi.beginSettling(club.id, activeSession.id));
      }
      openCashoutModal();
    } catch (err) {
      // Carries the server's own words, which are the useful part here: the
      // refusal a host actually hits is "two requests are still waiting —
      // decide them before settling", and that names the next tap.
      pushToast('Could not settle', err instanceof Error ? err.message : 'Please try again.', 'warning');
    } finally {
      setClockBusy(false);
    }
  };

  /**
   * Give a pre-snapshot night its rules, then carry on into settling.
   *
   * Validation mirrors the server exactly (whole chips >= 0, whole percent
   * 0-100) so the refusals a host can hit locally are the same ones the
   * server would give. On success the returned session already carries the
   * snapshot, so settling continues in the same gesture -- the host pressed
   * "Settle night", and setting the rules was a step of that, not a detour.
   */
  const submitNightRules = async () => {
    if (!activeSession || nightRulesSaving) return;
    const rake = Number(nightRakeInput);
    const cut = Number(nightCutInput);
    if (!Number.isInteger(rake) || rake < 0) {
      setNightRulesError('The rake must be a whole number of chips, zero or more.');
      return;
    }
    if (!Number.isInteger(cut) || cut < 0 || cut > 100) {
      setNightRulesError("The winners' cut must be a whole percentage between 0 and 100.");
      return;
    }
    setNightRulesSaving(true);
    try {
      const updated = await offlineSessionsApi.initSettlementRules(club.id, activeSession.id, {
        sessionRakeAmount: rake,
        winnersCutPercent: cut,
      });
      applySession(updated);
      setShowNightRulesSheet(false);
      applySession(await offlineSessionsApi.beginSettling(club.id, activeSession.id));
      openCashoutModal();
    } catch (err) {
      // The server's own words: "already has its rules", "must be a whole
      // number" — each names the situation better than a generic failure.
      setNightRulesError(err instanceof Error ? err.message : 'Please try again.');
    } finally {
      setNightRulesSaving(false);
    }
  };

  /**
   * Take somebody out of the lobby who said they were coming and went home.
   *
   * The server refuses anyone holding chips, so the worst a mis-tap can do is
   * remove a name that had nothing at stake — and they can rejoin.
   */
  const removeFromLobby = (userId: string) =>
    runSheet(async () => {
      if (!activeSession) return;
      applySession(await offlineSessionsApi.removeFromLobby(club.id, activeSession.id, userId));
    }, 'Please try again.');

  /** Hand the table back. A mis-tap must not end somebody's evening. */
  const resumeNight = async () => {
    if (!activeSession || clockBusy) return;
    setClockBusy(true);
    try {
      applySession(await offlineSessionsApi.resumeNight(club.id, activeSession.id));
      // Handing the table back and leaving the settlement screen open would
      // offer to commit figures for a night that is running again.
      setShowCashoutModal(false);
    } catch (err) {
      pushToast('Could not resume', err instanceof Error ? err.message : 'Please try again.', 'warning');
    } finally {
      setClockBusy(false);
    }
  };

  /** More time. Additive, unlimited — the plan changed, which it always does. */
  const extendSession = async (minutes: number) => {
    if (!activeSession || clockBusy) return;
    setClockBusy(true);
    try {
      applySession(await offlineSessionsApi.extendSession(club.id, activeSession.id, minutes));
      setExtendOpen(false);
    } catch (err) {
      pushToast('Could not extend', err instanceof Error ? err.message : 'Please try again.', 'warning');
    } finally {
      setClockBusy(false);
    }
  };

  /**
   * Carry on with no limit for the rest of the night.
   *
   * One-way, and that is the value: without it a night that ran long would
   * reach the end of its grace period, be extended by half an hour, and do the
   * same thing again an hour later.
   */
  const keepPlaying = async () => {
    if (!activeSession || clockBusy) return;
    setClockBusy(true);
    try {
      applySession(await offlineSessionsApi.liftTimeLimit(club.id, activeSession.id));
    } catch (err) {
      pushToast('Could not continue', err instanceof Error ? err.message : 'Please try again.', 'warning');
    } finally {
      setClockBusy(false);
    }
  };

  /** "Alright, let's start" — the one moment the app cannot infer for itself. */
  const startPlaying = async () => {
    if (!activeSession || startingPlay) return;
    setStartingPlay(true);
    try {
      applySession(await offlineSessionsApi.startPlaying(club.id, activeSession.id));
    } catch (err) {
      pushToast('Could not start', err instanceof Error ? err.message : 'Please try again.', 'warning');
    } finally {
      setStartingPlay(false);
    }
  };

  /**
   * The night's story, recovered from what the client already holds.
   *
   * Not a socket stream: a stream would only show what happened since this
   * phone was unlocked, and the whole point is that you glance at it after
   * twenty minutes of playing cards and know how the evening is going.
   */
  const nightFeed = useMemo(
    () =>
      deriveFeed({
        session: activeSession ?? null,
        buyIns: buyInRequests,
        buyInMode: club.buyInMode,
        clubMaxBuyIn: club.maxBuyIn ?? DEFAULT_MAX_BUY_IN,
      }),
    [activeSession, buyInRequests, club.buyInMode, club.maxBuyIn]
  );

  /**
   * The one screen that is a frame rather than a document.
   *
   * The felt is the hero, so it takes whatever height is left after the fixed
   * regions above and below it. That only works if every container between
   * <main> and the table is flex — one block container in the chain and the
   * table quietly collapses back to its own content height, which is what it
   * did on the club screen while looking correct in the debug harness.
   */
  const liveTableFillsScreen = activeTab === 'activeSession';

  const sheetSeat = useMemo(
    () => [...night.seats, ...night.room].find((s) => s.userId === sheetUid) ?? null,
    [night.seats, night.room, sheetUid]
  );

  /**
   * Who a host can still bring to the table.
   *
   * Anyone already in the night is absent rather than greyed — including the
   * people in the room, who rejoin by being tapped where they stand rather than
   * by being added again. A disabled row is a name the host has to read and
   * then discard, fifteen times a night.
   */
  const addablePlayers = useMemo(() => {
    const inTheNight = new Set([
      ...night.seats.map((s) => s.userId),
      ...night.room.map((s) => s.userId),
    ]);
    return (club.memberUids ?? [])
      .filter((uid) => !inTheNight.has(uid))
      .map((uid) => ({
        userId: uid,
        name: uid === currentUser.uid ? 'You' : allUsers[uid]?.displayName || 'Player',
        avatarUrl: allUsers[uid]?.avatarUrl,
      }));
  }, [club.memberUids, night.seats, night.room, allUsers, currentUser.uid]);

  // The club's own figures. The ceiling is passed separately and shown as a
  // limit — never as a button, because under MATCH_HIGHEST it climbs all night.
  const bankOptions = useMemo(() => {
    const min = club.minBuyIn ?? 1000;
    const max = club.maxBuyIn ?? DEFAULT_MAX_BUY_IN;
    return Array.from(new Set([min, Math.round((min + max) / 2), max])).sort((a, b) => a - b);
  }, [club.minBuyIn, club.maxBuyIn]);

  const runSheet = async (fn: () => Promise<unknown>, failure: string) => {
    if (sheetBusy) return;
    setSheetBusy(true);
    try {
      await fn();
      setSheetUid(null);
    } catch (err) {
      pushToast('Could not do that', err instanceof Error ? err.message : failure, 'warning');
    } finally {
      setSheetBusy(false);
    }
  };

  const takeBank = (amount: number) =>
    runSheet(async () => {
      if (!activeSession || !sheetUid) return;
      const forSelf = sheetUid === currentUser.uid;
      await offlineSessionsApi.requestBuyIn(
        club.id, activeSession.id, amount, forSelf ? undefined : sheetUid
      );
      await refreshActiveSession();

      /*
       * Say that it was sent.
       *
       * runSheet closes the sheet on success and speaks only on failure, so the
       * commonest outcome in the night — money requested — was the one nothing
       * acknowledged. The sheet simply vanished, and the only confirmations were
       * a "+5,000" caption on a seat the sheet had just been covering, and a row
       * in a queue that shows the player approve/reject controls rather than a
       * receipt. "Nothing happened" on a money screen reads as "press it again",
       * which is precisely the behaviour that once produced twenty duplicate
       * rows (use-action.ts).
       *
       * Toast, because that is already this app's success channel for exactly
       * this event through the older door ("Buy-in requested", :1503) and for
       * cash-outs and opening the table. Pushed here rather than by teaching
       * runSheet a success message: four other callers share that helper and
       * only this one is in scope.
       *
       * Named for the SUBJECT of the sheet, not the holder of the phone. An
       * admin adding to Rahul's bank must not be told "waiting for the host to
       * approve" about their own tap — the same mistake the sit-back-down button
       * made until #41.
       */
      pushToast(
        'Bank requested',
        forSelf
          ? `${formatUnit(amount)} — waiting for the host to approve.`
          : `${formatUnit(amount)} for ${allUsers[sheetUid]?.displayName || 'that player'} — waiting for approval.`,
        'success'
      );
    }, 'Please try again.');

  /*
   * Standing up submits a count. It never confirms one.
   *
   * An earlier version auto-confirmed when an admin stood another player up,
   * which made a cash-out the one money movement in the night that could skip
   * the queue — and it is the largest one. It now behaves exactly as a buy-in
   * does: the request is created, it appears in the queue, and somebody
   * confirms it.
   */
  const standUp = (amount: number) =>
    runSheet(async () => {
      if (!activeSession || !sheetUid) return;
      const forSelf = sheetUid === currentUser.uid;
      applySession(
        await offlineSessionsApi.requestCashOut(
          club.id, activeSession.id, amount, forSelf ? undefined : sheetUid
        )
      );
    }, 'Please try again.');

  /** The confirmed figure, which may differ from what the player counted. */
  /**
   * Back to the table with the chips they stood up with.
   *
   * The sit-in path, not the buy-in path, and that is the whole point: an
   * approval here VOIDS the confirmed cash-out (see decideSitIn) and seats
   * them, so the chips they carry back are the ones already counted. Routing
   * this through a buy-in would add those chips to what they have put in a
   * second time and settle them that much down.
   */
  const sitBackDown = () =>
    runSheet(async () => {
      if (!activeSession || !sheetUid) return;
      // The sheet's subject, not whoever is holding the phone. Omitting this is
      // what made an admin pressing "Sit back down" on Rahul's sheet ask for a
      // seat for the admin — and, being seated already, get told so.
      // Same shape as takeBank above.
      const forSelf = sheetUid === currentUser.uid;
      applySession(
        await offlineSessionsApi.requestSitIn(club.id, activeSession.id, forSelf ? undefined : sheetUid)
      );
    }, 'Please try again.');

  const confirmCount = (amount: number) =>
    runSheet(async () => {
      if (!activeSession || !sheetUid) return;
      applySession(
        await offlineSessionsApi.decideCashOut(club.id, activeSession.id, sheetUid, true, amount)
      );
    }, 'Please try again.');

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
        // The "Cashout" action that used to sit here is gone. It opened the
        // settlement screen directly, which skipped the freeze — the host
        // counted chips into a form while the table carried on buying in
        // behind it, and every figure they typed could go stale before they
        // pressed Confirm. Settling now has one door, on the felt, in both
        // states it can be in: "Settle night" in the footer while the night
        // runs, "Count the chips" in the band once it is frozen. Two controls
        // a nav apart, both reading "Settle Night", is the on-screen-twice
        // defect PRODUCT-BRIEF §14 names.

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
      beginSettling,
    ]
  );

  return (
    /*
      min-h-screen is a floor, not a ceiling, which is fine for a document and
      wrong for a frame: the live table's regions size themselves against the
      space available, and with only a minimum there IS no ceiling to size
      against — the page simply grew 9px past the viewport and started
      scrolling the moment the feed had a couple of lines in it.

      h-[100dvh] gives the chain a definite height to divide up. dvh rather than
      vh because mobile browser chrome slides away as you scroll, and vh is
      measured against the taller state.
    */
    <div
      className={`bg-bg text-text font-sans flex flex-col ${
        liveTableFillsScreen ? 'h-[100dvh] overflow-hidden' : 'min-h-screen'
      }`}
    >
      
      {/* Top Header */}
      <header className="bg-bg/95 border-b border-line sticky top-0 z-50 backdrop-blur-md px-4 py-3">
        {/*
          flex-wrap below sm, for the same reason the plaque and the dashboard
          card wrap: the right-hand action block is not shrinkable, and on a
          session-less pot club it is ~336px wide -- wider than a phone header
          has to give. justify-between then crushed the flex-1 identity block
          to nothing, and its shrink-0 contents overflowed their own box: the
          pot card rendered on top of the back button and the club code, and
          the club's name disappeared entirely. Measured at 320 and 390; the
          no-pot club stayed clean, which is what isolated the trigger. On a
          phone the actions now step down to their own line; sm+ is unchanged.
        */}
        <div className="max-w-7xl mx-auto flex flex-wrap sm:flex-nowrap items-center justify-between gap-3">

          <div className="flex items-center gap-3 min-w-0 flex-1">
            <button
              onClick={onBackToDashboard}
              className="tap-44 p-2 bg-surface hover:bg-surface-alt border border-line rounded-xl text-text-muted hover:text-text transition-all cursor-pointer"
              title="Back to Clubs List"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>

            {/*
              Two lines, not one wrapping row. The club name is the only thing
              at full weight; the code and role are reference detail and sit
              beneath it at a size that does not compete. Previously all three
              shared one flex-wrap row, so "Friday Night" broke across two lines
              and pushed every screen down by ~40px.
            */}
            <div className="min-w-0">
              <h1 className="text-lg font-semibold text-text truncate leading-tight">
                {club.name}
              </h1>
              <div className="flex items-center gap-1.5 mt-0.5 min-w-0">
                <span className="font-mono text-xs text-text-muted shrink-0">
                  #{club.code || '0007'}
                </span>
                {/* The owner IS an admin here (isAdmin includes isOwner), so the
                    label distinguishes what the flag cannot: whose club this is.
                    A label only -- every capability on this screen still keys
                    off isAdmin, and owners and admins remain deliberately
                    identical in what they can do. */}
                {isAdmin && (
                  <span className="text-xs text-accent shrink-0">{isOwner ? '· Owner' : '· Admin'}</span>
                )}
                {/* Only shown when something is wrong. A permanent green badge
                    becomes furniture people stop reading; an indicator that
                    appears only on trouble keeps its meaning. */}
                {connection !== 'live' && (
                  <span
                    title={connectionBadge.title}
                    className={`px-2 py-0.5 border font-extrabold text-[10px] uppercase rounded-full flex items-center gap-1.5 ${
                      connectionBadge.tone === 'danger'
                        ? 'bg-danger/10 border-danger text-danger'
                        : 'bg-warning/10 border-warning text-warning'
                    }`}
                  >
                    <span className={`w-1.5 h-1.5 rounded-full ${connectionBadge.tone === 'danger' ? 'bg-danger' : 'bg-warning animate-pulse'}`} />
                    {connectionBadge.label}
                  </span>
                )}
                {/* Balances display in Chips everywhere, so the cash rate has
                    to be discoverable somewhere or players can't value their
                    stack. Only shown when it isn't the trivial 1:1. */}
                {(club.enableDevaluation ?? false) && (club.devaluationFactor ?? 1) > 1 && (
                  <span className="px-2 py-0.5 furniture text-text-muted font-mono text-[10px] rounded-lg">
                    {club.devaluationFactor} Chips = ₹1
                  </span>
                )}
                <button
                  onClick={() => setShowClubInfoModal(true)}
                  className="tap-44 p-1 text-text-muted hover:text-accent transition-colors cursor-pointer"
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
                    <div className="text-[9px] uppercase tracking-widest text-accent font-semibold">Club pot balance</div>
                    <div className="text-xs font-mono font-semibold text-text">
                      {formatVal(club.clubPotBalance || 0)}
                    </div>
                  </div>
                </button>
              )}

              {!activeSession && (
                <button
                  onClick={() => startSessionAction.run()}
                  disabled={startSessionAction.pending}
                  className="bg-accent hover:bg-accent text-accent-contrast font-semibold px-3.5 py-2 rounded-xl text-xs transition-all cursor-pointer flex items-center gap-1.5 shadow"
                >
                  <Plus className="w-4 h-4" /> Start New Session
                </button>
              )}
            </div>
          )}

        </div>
      </header>

      {/* Main Container */}
      {/*
        Two layouts, because the live table is the one screen that is not a
        scrolling document.

        Everywhere else this is a page: content stacks, the page grows, and the
        bottom padding clears both fixed layers on mobile — the nav (~68px) and
        the contextual action bar above it (~52px + gap). Without it the last
        row of the table sat under the action bar, which is exactly where the
        newest player card lands.

        On the live table it is a frame instead. The felt has to take whatever
        height is left over after the header, the queue and the settle footer,
        so the chain from here down has to be flex — a block container in the
        middle silently collapses the table back to its content height. The old
        action bar does not exist in that mode, so the padding only has to clear
        the nav.
      */}
      <main
        className={`flex-grow max-w-7xl w-full mx-auto p-4 md:p-8 space-y-6 md:pb-8 ${
          liveTableFillsScreen ? 'flex flex-col min-h-0 pb-24' : 'pb-44'
        }`}
      >

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
                className={`relative flex items-center gap-2 px-4 py-3 text-xs font-medium whitespace-nowrap transition-colors cursor-pointer border-b-2 -mb-px ${
 isSelected
 ? 'text-accent border-accent'
                    : 'text-text-muted border-transparent hover:text-text'
                }`}
              >
                <item.Icon className={`w-4 h-4 ${item.iconClass ?? ''}`} />
                {item.desktopLabel}
                {item.badge > 0 && (
                  <span className="bg-danger text-white font-semibold text-[10px] min-w-[18px] h-[18px] px-1 rounded-full flex items-center justify-center">
                    {item.badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        <div className={liveTableFillsScreen ? 'flex-1 min-h-0 flex flex-col' : 'space-y-6'}>

            {/* The live session. Built alongside the screen it replaced and
                gated behind a flag until the cutover; both the flag and that
                screen are gone, so this is the only session experience. */}
            {activeTab === 'activeSession' && (
              <LiveSession
                club={club}
                session={activeSession ?? null}
                night={night}
                currentUserId={currentUser.uid}
                isAdmin={isAdmin}
                users={allUsers}
                connection={connection}
                onStartSession={() => setOpenTableOpen(true)}
                onStartPlaying={startPlaying}
                starting={startingPlay}
                onExtendSession={() => setExtendOpen(true)}
                onKeepPlaying={keepPlaying}
                onResumeNight={resumeNight}
                onRemoveFromLobby={removeFromLobby}
                formatAmount={formatUnit}
                waiting={waitingForYou}
                onSelectPlayer={(uid) => { setSheetAsksForChips(false); setSheetUid(uid); }}
                ceiling={buyInCeiling}
                onSettleNight={beginSettling}
                onAddPlayer={() => setAddPlayerOpen(true)}
                onAskForChips={() => {
                  setSheetAsksForChips(true);
                  setSheetUid(currentUser.uid);
                }}
                feed={nightFeed}
              />
            )}

            {/* Picks a person, and nothing else. Choosing one opens their own
                sheet, which opens on the bank chooser because they have no
                seat — so there is exactly one "how much?" in the app,
                entered from two doors. */}
            {/* What a pre-snapshot night is asked before it can settle.
                The two figures the snapshot cannot guess; everything else the
                snapshot needs is captured from the club on the server. */}
            <Sheet
              open={showNightRulesSheet}
              onClose={() => setShowNightRulesSheet(false)}
              title="Set this night's rules"
              description="It started before rules were recorded against a night, so it has none of its own."
              footer={
                <Button
                  variant="primary"
                  size="md"
                  fullWidth
                  loading={nightRulesSaving}
                  onClick={() => void submitNightRules()}
                >
                  Set rules & settle
                </Button>
              }
            >
              <div className="space-y-4">
                <p className="text-xs text-text-muted leading-relaxed">
                  The club's current settings are deliberately not used — they may have
                  changed since this night began. Whatever is set here is fixed for this
                  night and recorded in the audit log.
                </p>
                <div className="space-y-1">
                  <label htmlFor="night-rake" className="text-[10px] font-medium text-text-muted uppercase tracking-wide">
                    Rake — chips per player
                  </label>
                  <input
                    id="night-rake"
                    type="number"
                    inputMode="numeric"
                    min={0}
                    step={1}
                    placeholder="0"
                    value={nightRakeInput}
                    onChange={(e) => setNightRakeInput(e.target.value)}
                    className={SETTLEMENT_AMOUNT_INPUT}
                  />
                </div>
                <div className="space-y-1">
                  <label htmlFor="night-cut" className="text-[10px] font-medium text-text-muted uppercase tracking-wide">
                    Winners' cut — % of profit
                  </label>
                  <input
                    id="night-cut"
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={100}
                    step={1}
                    placeholder="0"
                    value={nightCutInput}
                    onChange={(e) => setNightCutInput(e.target.value)}
                    className={SETTLEMENT_AMOUNT_INPUT}
                  />
                </div>
                {nightRulesError && (
                  <p role="alert" className="text-xs text-danger leading-relaxed">{nightRulesError}</p>
                )}
              </div>
            </Sheet>

            <AddPlayerSheet
              open={addPlayerOpen}
              onClose={() => setAddPlayerOpen(false)}
              candidates={addablePlayers}
              onSelect={(uid) => {
                setAddPlayerOpen(false);
                setSheetAsksForChips(false);
                setSheetUid(uid);
              }}
            />

            {/* The sheet is where every action originates. Mounted beside the
                screen rather than inside it, so the felt never has to know
                what a request is. */}
            {sheetUid && (
              <PlayerSheet
                open
                onClose={() => { setSheetAsksForChips(false); setSheetUid(null); }}
                name={sheetUid === currentUser.uid ? 'You' : allUsers[sheetUid]?.displayName || 'Player'}
                userId={sheetUid}
                avatarUrl={allUsers[sheetUid]?.avatarUrl}
                seat={sheetSeat}
                isSelf={sheetUid === currentUser.uid}
                isAdmin={isAdmin}
                formatAmount={formatUnit}
                bankOptions={bankOptions}
                ceiling={buyInCeiling}
                busy={sheetBusy}
                askForChips={sheetAsksForChips}
                onJoin={takeBank}
                onBuyMore={takeBank}
                onStandUp={standUp}
                onConfirmCount={confirmCount}
                onSitBackDown={sitBackDown}
              />
            )}

            <ExtendSessionSheet
              open={extendOpen}
              onClose={() => setExtendOpen(false)}
              onExtend={extendSession}
              busy={clockBusy}
            />

            {/* Opening the table is not starting the game — see OpenTableSheet. */}
            <OpenTableSheet
              open={openTableOpen}
              onClose={() => setOpenTableOpen(false)}
              busy={startSessionAction.pending}
              onOpenTable={(options) => {
                setOpenTableOpen(false);
                startSessionAction.run(options);
              }}
            />

            {/* "Settle night" now opens the settlement screen itself — the
                placeholder that stood here held the control's position until
                there was somewhere real to send it. */}

            {/* TAB: MERGED ACTIVE SESSION & BUY-INS */}


            {/* GAME HISTORY */}
            {activeTab === 'history' && (
              <div className="space-y-6">
                {/* Historical Sessions (Chronological Day Sessions) */}
                <div className="bg-bg/80 border border-line/80 p-4 sm:p-6 rounded-3xl space-y-4 shadow-2xl backdrop-blur-sm">
                  <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line/60 pb-3">
                    <div>
                      <h2 className="text-base sm:text-lg font-semibold text-text flex items-center gap-2">
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
                          className="text-xs font-medium bg-accent/15 text-accent border border-accent/40 px-3 py-1.5 rounded-xl hover:bg-accent/25 transition-colors flex items-center gap-1.5"
                        >
                          <CalendarPlus className="w-3.5 h-3.5" /> Record a past night
                        </button>
                      )}
                      <div className="text-xs text-text-muted font-mono font-medium bg-bg border border-line/60 px-3 py-1.5 rounded-xl">
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
                          <div key={session.id} className="furniture/70 rounded-2xl overflow-hidden transition-all shadow-md">
                            {/* Card Header */}
                            <div
                              onClick={() => setExpandedSessionId(isExpanded ? null : session.id)}
                              className="p-4 sm:p-5 flex items-center justify-between gap-3 cursor-pointer hover:bg-surface transition-colors"
                            >
                              <div className="space-y-0.5 min-w-0">
                                <div className="text-xs text-text-muted font-sans">
                                  {session.date ? new Date(session.date).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : '—'}
                                </div>
                                <span className="font-extrabold text-text text-base sm:text-lg font-mono ">
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
                                    <div className={`text-[11px] font-mono font-medium pt-0.5 ${
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
                                        <div className="font-semibold text-text text-sm sm:text-base font-sans">{ps.name}</div>
                                        <div className={`font-mono font-semibold text-sm sm:text-base tracking-tight ${
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
                <div className="furniture p-6 rounded-3xl space-y-6">
                  <div className="border-b border-line pb-4 flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h2 className="text-lg font-semibold text-accent flex items-center gap-2">
                        <ListChecks className="w-5 h-5" /> Approvals
                        <InfoHint>
                          Buy-ins and session edits waiting on an admin. In clubs with two or more admins, you can't approve your own request — someone else has to.
                        </InfoHint>
                      </h2>
                    </div>

                    <div className="px-3 py-1 bg-bg border border-line text-warning text-xs font-mono font-medium rounded-xl flex items-center gap-1.5">
                      <ShieldCheck className="w-4 h-4 text-accent" /> Total Club Admins: {totalAdminsCount}
                    </div>
                  </div>

                  {/*
                    Admission comes before anything else on this screen: a
                    person has to be in the club before they can ask for chips
                    in it. Same component as the dashboard's cross-club list —
                    only `showClubName` differs, because this tab already IS a
                    club.
                  */}
                  <JoinRequestList
                    requests={clubJoinRequests}
                    loading={joinRequestsRes.status === 'empty' && !joinRequestsRes.error}
                    loadError={joinRequestsRes.error ? 'Could not load join requests.' : null}
                    onRetryLoad={() => void joinRequestsRes.refresh()}
                    onDecide={decideJoinRequest}
                    onStale={() => void joinRequestsRes.refresh()}
                    title={`Requests to join (${clubJoinRequests.length})`}
                    emptyMessage="Nobody is waiting to join this club."
                  />

                  {/* SECTION 1: PENDING BANK BUY-INS */}
                  <div className="space-y-3">
                    <h3 className="text-xs font-medium text-text flex items-center gap-2">
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
                                <div className="text-xs font-medium text-text flex items-center gap-2">
                                  {allUsers[req.userId]?.displayName || 'Player'}
                                  <span className="text-warning font-mono text-sm">
                                    {formatVal(req.amount)}
                                  </span>
                                </div>
                                <div className="text-[10px] text-text-muted font-mono mt-0.5">
                                  Requested at: {new Date(req.createdAt).toLocaleTimeString()}
                                </div>

                                {cannotSelfApprove && (
                                  <span className="mt-1 inline-flex items-center gap-1 text-[10px] font-medium text-warning bg-warning/80 border border-warning/40 px-2 py-0.5 rounded-full">
                                    <ShieldAlert className="w-3 h-3" /> Requires another Admin to approve (Cannot self-approve)
                                  </span>
                                )}
                              </div>

                              <div className="flex items-center gap-2">
                                <button
                                  onClick={() => approveBuyInAction.run(req)}
                                  disabled={cannotSelfApprove || approveBuyInAction.pending}
                                  className={`px-3.5 py-2 rounded-xl text-xs font-medium transition-all flex items-center gap-1 ${
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
                                  className="bg-danger/15 hover:bg-danger/25 border border-danger/40 text-danger font-medium px-3 py-2 rounded-xl text-xs cursor-pointer flex items-center gap-1"
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
                    <h3 className="text-xs font-medium text-text flex items-center gap-2">
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
                                    <span className="text-sm font-semibold text-text font-mono">{req.sessionTitle}</span>
                                    <span className={`px-2 py-0.5 font-medium text-[10px] uppercase rounded-full ${
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
                                    className={`px-3.5 py-2 rounded-xl text-xs font-medium transition-all flex items-center gap-1 ${
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
                                    className="bg-danger/15 hover:bg-danger/25 border border-danger/40 text-danger font-medium px-3.5 py-2 rounded-xl text-xs cursor-pointer flex items-center gap-1"
                                  >
                                    <X className="w-3.5 h-3.5" /> Reject
                                  </button>
                                </div>
                              </div>

                              {/* Changes Breakdown */}
                              {req.changes && req.changes.length > 0 && (
                                <div className="bg-surface p-3 rounded-xl space-y-1 font-mono text-xs">
                                  <div className="text-[10px] text-text-muted uppercase font-medium">Proposed Modifications:</div>
                                  {req.changes.map((c, idx) => (
                                    <div key={idx} className="flex items-center gap-2 text-text-muted">
                                      <span className="text-accent">{c.field}:</span>
                                      <span className="line-through text-text-faint">{c.oldValue || 'None'}</span>
                                      <span>➜</span>
                                      <span className="text-accent font-semibold">{c.newValue}</span>
                                    </div>
                                  ))}
                                </div>
                              )}

                              {cannotSelfApprove && (
                                <p className="text-[10px] text-warning font-medium flex items-center gap-1">
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
                <div className="furniture p-6 rounded-3xl space-y-6">
                  <div className="border-b border-line pb-4 flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h2 className="text-lg font-semibold text-text flex items-center gap-2">
                        <FileCheck className="w-5 h-5 text-accent" /> Audit Trail & Security Logs
                      </h2>
                      <p className="text-xs text-text-muted mt-1">
                        Permanent immutable log of historical session edits, approvals, rejections, soft deletions, and session restorations.
                      </p>
                    </div>

                    <span className="px-3 py-1 bg-warning/80 border border-warning/40 text-warning font-medium text-xs rounded-xl flex items-center gap-1">
                      <Lock className="w-3.5 h-3.5 text-warning" /> Restrict Access: Owner & Super User
                    </span>
                  </div>

                  {/* SOFT-DELETED SESSIONS RECOVERY */}
                  <div className="space-y-3">
                    <h3 className="text-xs font-medium text-text flex items-center gap-2">
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
                              <span className="font-semibold text-danger line-through">{item.title}</span>
                            </div>

                            <button
                              onClick={() => restoreSessionAction.run(item.id, item.sourceType, item.title)}
                              disabled={restoreSessionAction.isPending(item.id)}
                              className="px-3 py-1.5 bg-accent hover:bg-accent text-accent-contrast font-sans font-medium text-xs rounded-xl cursor-pointer flex items-center gap-1 shadow"
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
                    <h3 className="text-xs font-medium text-text ">
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
                              <span className="font-semibold text-accent ">{log.action}</span>
                              <span>{new Date(log.createdAt).toLocaleString()}</span>
                            </div>
                            <div className="text-text font-semibold">{log.sessionTitle}</div>
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
                <div className="furniture p-6 md:p-8 rounded-3xl space-y-6">
                  
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-line pb-4">
                    <div>
                      <h2 className="text-lg font-semibold text-text flex items-center gap-2">
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
                              <span className={`px-2.5 py-0.5 rounded-full text-xs font-semibold ${
 idx === 0 ? 'bg-warning/20 text-accent border border-accent' :
                                idx === 1 ? 'bg-line-strong/20 text-text-muted border border-line-strong' :
                                idx === 2 ? 'bg-warning/20 text-warning border border-warning/50' :
                                'bg-surface text-text-muted'
                              }`}>
                                {crownBadge}
                              </span>
                              <span className="font-medium text-text text-sm">{player.name}</span>
                            </div>

                            <div className={`text-sm font-semibold ${player.netProfit >= 0 ? 'text-accent' : 'text-danger'}`}>
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
                            <td className="py-3.5 px-2 font-semibold text-accent">
                              #{idx + 1}
                            </td>
                            <td className="py-3.5 px-2 font-semibold text-text">
                              {player.name}
                            </td>
                            <td className={`py-3.5 px-2 font-semibold text-xs ${player.netProfit >= 0 ? 'text-accent' : 'text-danger'}`}>
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
                <div className="furniture p-6 rounded-3xl space-y-4">
                  <div className="border-b border-line pb-3">
                    <h2 className="text-base font-semibold text-text flex items-center gap-2">
                      <Coins className="w-5 h-5 text-accent" /> Club Pot Ledger & Transactions (Admin Only)
                    </h2>
                    {/*
                      This club's actual charges, not example figures. The old
                      copy hardcoded "₹1,000/game, 5% winner's cut" -- wrong in
                      three ways for the very first pot-enabled club to read it
                      (its cut is a different number, the seat fee is per
                      player, and the figures are chips, not rupees). A ledger
                      whose one-line explanation misstates the charges teaches
                      the reader to distrust the ledger.
                    */}
                    <p className="text-xs text-text-muted">
                      Accumulated from{' '}
                      {[
                        (club.sessionRakeAmount ?? 0) > 0 ? `a ${formatVal(club.sessionRakeAmount)} seat fee per player` : null,
                        (club.winnersCutPercent ?? 0) > 0 ? `a ${club.winnersCutPercent}% winners' cut` : null,
                        'buy-in surplus left on the table',
                      ].filter(Boolean).join(', ')}
                      .
                    </p>
                  </div>

                  <div className="space-y-2">
                    {potLogs.map(log => (
                      <div key={log.id} className="p-3 bg-bg border border-line rounded-xl flex items-center justify-between text-xs font-mono">
                        <div>
                          <div className="font-semibold text-text">{log.note}</div>
                          <div className="text-[10px] text-text-muted">{new Date(log.createdAt).toLocaleString()}</div>
                        </div>
                        <div className="text-warning font-medium text-sm">
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
              className="furniture w-full sm:max-w-md max-h-[92vh] overflow-y-auto rounded-t-3xl sm:rounded-3xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="sticky top-0 bg-surface border-b border-line px-5 py-4 flex items-center justify-between z-10">
                <div>
                  <h3 className="text-sm font-semibold text-accent ">Buy In</h3>
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
                  <label className="text-[11px] font-medium text-text-muted uppercase">Amount</label>
                  <div className="flex flex-wrap gap-2">
                    {quickAmounts.map(amt => (
                      <button
                        key={amt}
                        type="button"
                        onClick={() => setBuyInAmount(amt)}
                        className={`px-3.5 py-2 rounded-full text-xs font-mono font-semibold cursor-pointer transition-all border ${
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
                    inputMode="decimal"
                    required
                    step={100}
                    value={buyInAmount}
                    onChange={(e) => setBuyInAmount(Number(e.target.value))}
                    className="w-full bg-bg border border-line rounded-xl px-4 py-3 text-lg font-mono font-semibold text-accent focus:border-accent outline-none"
                  />
                  <p className="text-[11px] text-accent font-mono font-medium">
                    Equivalent Real Bank Cash: ₹{Math.round(buyInAmount / ((club.enableDevaluation ?? true) ? (club.devaluationFactor ?? 5) : 1)).toLocaleString()} INR
                  </p>
                </div>

                {/* Min/max are enforced on submit via a toast rather than
                    spelled out up front — see handleRequestBuyIn. */}
                {isAdmin && buyInTargetUser === currentUser.uid && (
                  <p className="text-[11px] text-warning font-medium">
                    ⚠️ As an Admin, another Admin must approve your request.
                  </p>
                )}

                <button
                  type="submit"
                        disabled={requestBuyInAction.pending}
                  className="w-full bg-accent hover:bg-accent text-accent-contrast font-semibold py-3.5 rounded-xl text-xs cursor-pointer shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
                >
                        {requestBuyInAction.pending ? 'Sending…' : <>Buy in {formatPts(buyInAmount)} for {targetName}</>}
                </button>

                <button
                  type="button"
                  onClick={() => setShowBuyInModal(false)}
                  className="w-full text-center text-xs font-medium text-text-muted hover:text-text transition-colors cursor-pointer py-1"
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
            className="furniture w-full sm:max-w-lg rounded-t-3xl sm:rounded-3xl max-h-[92vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-5 border-b border-line/60 flex items-center justify-between sticky top-0 bg-surface rounded-t-3xl">
              <h3 className="font-semibold text-text flex items-center gap-2">
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
                <label className="text-xs font-medium text-text-muted ">Date played</label>
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
                      <span className="text-[10px] font-medium text-text-muted uppercase tracking-wider">
                        Who played
                      </span>
                      {unseated.length > 0 && (
                        <button
                          type="button"
                          onClick={() => unseated.forEach(addMember)}
                          className="text-[11px] font-medium text-accent hover:underline"
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
                            className="flex items-center gap-1.5 bg-bg border border-line/70 hover:border-accent/60 hover:text-accent text-text-muted text-xs font-medium pl-1.5 pr-2.5 py-1 rounded-full transition-colors"
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
                  <span className="text-[10px] font-medium text-text-muted uppercase tracking-wider">Player</span>
                  <span className="text-[10px] font-medium text-text-muted uppercase tracking-wider text-right">Buy-in</span>
                  <span className="text-[10px] font-medium text-text-muted uppercase tracking-wider text-right">Cash-out</span>
                  <span />
                </div>
                {pastRows.map((row, i) => (
                  <div key={i} className="grid grid-cols-[1fr_5rem_5rem_1.75rem] gap-2 items-center">
                    {row.userId ? (
                      <div className="flex items-center gap-1.5 bg-accent/10 border border-accent/30 rounded-xl px-2 py-2 min-w-0">
                        <span className="w-5 h-5 shrink-0 rounded-full bg-surface-alt border border-line/60 flex items-center justify-center text-[10px] text-text">
                          {row.name[0]?.toUpperCase() || 'M'}
                        </span>
                        <span className="text-sm text-text font-medium truncate">{row.name}</span>
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
                      inputMode="decimal"
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
                      inputMode="decimal"
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
                  className="w-full border border-dashed border-line/70 text-text-muted text-xs font-medium py-2 rounded-xl hover:border-accent/50 hover:text-accent transition-colors"
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
                className="w-full flex items-center justify-center gap-2 border border-accent/40 text-accent font-semibold py-3 rounded-xl text-xs disabled:opacity-40 disabled:cursor-not-allowed hover:bg-accent/10 transition-colors"
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
                  className="flex-1 border border-line text-text-muted font-semibold py-3 rounded-xl hover:text-text transition-colors"
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
                    className="flex-1 bg-accent text-accent-contrast font-semibold py-3 rounded-xl disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Record night
                  </button>
                ) : (
                  <button
                    key="past-confirm"
                    type="submit"
                    disabled={savingPast}
                    className="flex-1 bg-warning text-accent-contrast font-semibold py-3 rounded-xl disabled:opacity-50 text-xs"
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
            className="furniture w-full sm:max-w-sm rounded-t-3xl sm:rounded-3xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="border-b border-line px-5 py-4 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-accent ">Stand Up</h3>
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
                <label className="text-[10px] font-medium text-text-muted uppercase">Chips you are cashing out</label>
                <input
                  type="number"
                  inputMode="decimal"
                  required
                  min={0}
                  step={100}
                  value={standUpAmount}
                  onChange={(e) => setStandUpAmount(Math.max(0, Number(e.target.value)))}
                  className="w-full bg-bg border border-line rounded-xl px-4 py-3 text-lg font-mono font-semibold text-accent focus:border-accent outline-none"
                />
              </div>

              <button
                type="submit"
                      disabled={standUpAction.pending}
                className="w-full bg-accent text-accent-contrast font-semibold py-3.5 rounded-xl text-xs cursor-pointer shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
              >
                      {standUpAction.pending ? 'Sending…' : <>Cash out {formatVal(standUpAmount)}</>}
              </button>
              <button
                type="button"
                onClick={() => setShowStandUpModal(false)}
                className="w-full text-center text-xs font-medium text-text-muted hover:text-text transition-colors cursor-pointer py-1"
              >
                Cancel
              </button>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: CASHOUT & END-OF-SESSION SETTLEMENT (ADMIN ONLY) */}
      {showCashoutModal && isAdmin && activeSession && (
        <Sheet
          open={showCashoutModal}
          onClose={() => setShowCashoutModal(false)}
          size="lg"
          title="Settle night"
          description={activeSession.sessionName}
          footer={settlementFooter}
        >
          <div className="space-y-4">

              {/*
                IN / OUT / DIFF, pinned to the top of the count.

                It is the running total the host checks WHILE typing, which is
                why it is up here and not in the panel below. OUT and DIFF stay
                as — until every seat has a figure: an uncounted player's blank
                is a zero to the engine and takes a share of the mismatch, so a
                partial total is not a smaller truth, it is a wrong one. IN is
                honest throughout, because the buy-ins are already known.

                Keyboard behaviour is NOT handled here. On iOS this bar leaves
                the visible viewport when the keyboard opens, which is measured
                and is the next commit's problem.
              */}
              <div
                ref={summaryRef}
                className="sticky top-0 z-10 -mx-5 px-5 py-2.5 bg-bg/95 backdrop-blur-xl border-b border-line will-change-transform"
              >
                {/*
                  NOT justify-between, deliberately. Between shares every width
                  change across all three spans: the moment the last cash-out
                  got its first digit, DIFF went from "DIFF \u2014" (40px) to a
                  152px phrase and OUT lurched 69px left in the same frame --
                  measured at 390px -- and every digit-count boundary after
                  that jumped it again. A running total the host reads WHILE
                  typing must hold still.

                  So IN and OUT sit at fixed positions on the left (their own
                  digits are tabular, and IN is frozen for the whole count),
                  and DIFF is anchored to the RIGHT edge with ml-auto: its text
                  grows leftward into the free middle, which belongs to nobody.
                  The only thing that moves when the phrase changes is the
                  phrase's own left edge.
                */}
                <div className="flex items-baseline gap-3 text-[11px] font-mono tabular-nums">
                  <span className="shrink-0 text-text-muted">IN <span className="text-text">{formatVal(settlementTotalIn)}</span></span>
                  <span className="shrink-0 text-text-muted">OUT <span className="text-text">{allCashOutsEntered && preview ? formatVal(preview.totalCashOuts) : '\u2014'}</span></span>
                  <span className={`ml-auto min-w-0 text-right ${allCashOutsEntered && preview && preview.mismatchAmount !== 0 ? 'text-warning' : 'text-text-muted'}`}>
                    {allCashOutsEntered && preview
                      ? (preview.mismatchAmount === 0 ? 'balanced' : describeMismatch(preview.mismatchAmount, formatVal))
                      : 'DIFF —'}
                  </span>
                </div>
              </div>

              {/* Says the thing that makes the figures below trustworthy. A host
                  counting a stack needs to know the numbers cannot move while
                  they count, and closing this screen does not thaw the table —
                  the band on the felt is where the night gets handed back. */}
              <p className="text-[11px] text-text-muted text-center leading-relaxed">
                The table is frozen — nobody can buy in or cash out while you count.
                Close this and it stays on hold.
              </p>

              {/* What this night is being settled BY, from its own snapshot.
                  On screen before Confirm rather than buried in club settings,
                  because these are the numbers that decide what everyone walks
                  away with — and because the club's may no longer match. */}
              {sessionSettlementRules ? (
                <div className="p-3.5 bg-bg border border-line rounded-2xl">
                  <p className="text-[10px] uppercase tracking-[0.18em] text-text-faint">
                    This night's rules
                  </p>
                  <dl className="mt-2 space-y-1 text-[11px] font-mono tabular-nums">
                    {[
                      ['Rake', `${sessionSettlementRules.sessionRakeAmount.toLocaleString()} chips`],
                      ["Winners' cut", `${sessionSettlementRules.winnersCutPercent}%`],
                      ['Rake order', sessionSettlementRules.rakeOrder.replace(/_/g, ' ').toLowerCase()],
                      ['Winner definition', sessionSettlementRules.winnerDefinition.replace(/_/g, ' ').toLowerCase()],
                      ['Winners counted', String(sessionSettlementRules.winnerTopN)],
                      ['Mismatch', sessionSettlementRules.mismatchStrategy.replace(/_/g, ' ').toLowerCase()],
                      ['Rounding', sessionSettlementRules.roundingRule.replace(/_/g, ' ').toLowerCase()],
                    ].map(([label, value]) => (
                      <div key={label} className="flex items-baseline gap-3">
                        <dt className="flex-1 min-w-0 truncate text-text-muted">{label}</dt>
                        <dd className="shrink-0 text-text">{value}</dd>
                      </div>
                    ))}
                  </dl>
                  <p className="mt-2 text-[10px] text-text-faint leading-relaxed">
                    Fixed when this night started. Changing the club's settings does not move them.
                  </p>
                </div>
              ) : (
                <div className="p-3.5 bg-warning/10 border border-warning/40 rounded-2xl">
                  <p className="text-[11px] text-warning leading-relaxed">
                    This night started before its rules were recorded, so it has none of its own.
                    It cannot be settled until its rake and winners' cut are set — the club's
                    current settings are not used, because they may have changed since the night began.
                    Press <span className="font-semibold">Back to the table</span>, then{' '}
                    <span className="font-semibold">Settle night</span> again — you'll be asked to
                    set them on the way in.
                  </p>
                </div>
              )}

              {/* Player Rows: Buy-in (editable) / Cash-out (editable) */}
              <div className="space-y-3">
                {settlementUids.map(uid => {
                  /*
                    Nothing derived is shown until every seat has a figure.

                    calculateSettlement coerces a blank with `Number(x || 0)`,
                    and the engine has no way to say "not counted yet" — a blank
                    IS a zero to it. While one player is missing, every other
                    player's net is provisional too: the mismatch is distributed
                    across them, so an uncounted seat quietly changes what the
                    counted ones appear to have won.
                    So the whole table reads `—` until the count is complete,
                    rather than showing confident figures that are about to move.
                  */
                  const summary = allCashOutsEntered ? preview?.players.find(p => p.userId === uid) : undefined;
                  // netResult, not grossProfit: what the player actually leaves with,
                  // after the mismatch share and the house's cut.
                  const net = summary ? formatSignedVal(summary.netResult) : '—';
                  return (
                    <div key={uid} className="p-3.5 bg-bg border border-line rounded-2xl space-y-2.5">
                      <div className="flex items-center justify-between">
                        <div className="text-xs font-medium text-text">
                          {uid === currentUser.uid ? 'You' : (allUsers[uid]?.displayName || `Player (${uid.slice(0, 6)})`)}
                        </div>
                        {/*
                          The NIGHT's definition, not the club's.

                          This read the club while the engine two hundred lines
                          up is handed `sessionSettlementRules.winnerDefinition`
                          — and the rules panel at the top of this very modal
                          already prints the snapshot's value. So the modal
                          stated one rule and obeyed another, and the club's
                          setting stays editable while a night is running.

                          Both directions lose money quietly:

                            snapshot MANUAL, club since changed
                              no checkbox renders, every entry submits
                              manualWinner undefined, MANUAL marks nobody a
                              winner, and an excess has nobody to be charged to
                              — it is left unresolved and simply leaves the books

                            club MANUAL, snapshot not
                              a checkbox appears and ticking it invalidates the
                              preview and changes nothing, because the engine is
                              not reading MANUAL at all

                          The snapshot exists precisely so the night settles by
                          what it agreed to. This is the one line on the screen
                          that was still asking the club.
                        */}
                        <div className="flex items-center gap-2 shrink-0">
                        <span
                          className={`text-xs font-mono tabular-nums ${
                            summary ? (summary.netResult >= 0 ? 'text-success' : 'text-danger') : 'text-text-faint'
                          }`}
                        >
                          {net}
                        </span>
                        {sessionSettlementRules?.winnerDefinition === 'MANUAL' ? (
                          <label className="flex items-center gap-1.5 text-[10px] font-medium text-text-muted uppercase cursor-pointer">
                            <input
                              type="checkbox"
                              checked={!!manualWinnerInputs[uid]}
                              onChange={(e) => { setManualWinnerInputs({ ...manualWinnerInputs, [uid]: e.target.checked }); setConfirmingSettle(false); setMismatchAcknowledged(false); }}
                              className="w-3.5 h-3.5 accent-accent rounded cursor-pointer"
                            />
                            Winner
                          </label>
                        ) : summary?.isWinner ? (
                          <span className="px-2 py-0.5 bg-accent/15 border border-accent/40 text-accent text-[9px] font-semibold uppercase rounded-full">Winner</span>
                        ) : null}
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-2.5">
                        <div className="space-y-1">
                          <label className="text-[10px] font-medium text-text-muted uppercase">Buy-in</label>
                          <input
                            type="number"
                            inputMode="decimal"
                            min={0}
                            value={buyInInputs[uid] ?? ''}
                            onChange={(e) => { setBuyInInputs({ ...buyInInputs, [uid]: e.target.value }); setConfirmingSettle(false); setMismatchAcknowledged(false); }}
                            className={SETTLEMENT_AMOUNT_INPUT}
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="text-[10px] font-medium text-text-muted uppercase flex items-center gap-1">
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
                              <span className="text-xs font-mono font-medium text-text">
                                {confirmedCashOutByUid[uid].toLocaleString()}
                              </span>
                              <span className="flex items-center gap-1 text-[9px] font-semibold uppercase text-accent">
                                <Lock className="w-2.5 h-2.5" /> Stood up
                              </span>
                            </div>
                          ) : (
                            <input
                              type="number"
                              inputMode="decimal"
                              min={0}
                              value={cashOutInputs[uid] ?? ''}
                              onChange={(e) => { setCashOutInputs({ ...cashOutInputs, [uid]: e.target.value }); setConfirmingSettle(false); setMismatchAcknowledged(false); }}
                              placeholder="Enter cash-out"
                              className={SETTLEMENT_AMOUNT_INPUT}
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
                  Count everyone before you can settle.
                </p>
              )}

              {/* The figures, as soon as there are figures to show. The reveal
                  control this used to sit behind was doing two jobs, and only
                  one of them was real: it gated the arithmetic, which the count
                  itself gates better. */}
              {allCashOutsEntered && preview && (
                <SettlementPreview
                  result={preview}
                  club={club}
                  // The night's own rules, so the breakdown explains the very
                  // figures above it rather than what the club charges today.
                  settings={liveSettlementSettings ?? undefined}
                  formatAmount={formatVal}
                  formatSigned={formatSignedVal}
                  mismatchAcknowledgement={{
                    checked: mismatchAcknowledged,
                    // confirmingSettle IS reset: the figures just changed, so an
                      // already armed confirmation must be re-armed against the new
                      // numbers. (This comment used to explain why ticking the box
                      // must not reset cashoutCalculated — unmounting the block the
                      // checkbox lived in. That state is gone, and with it the trap.)
                      onChange: (checked) => { setMismatchAcknowledged(checked); setConfirmingSettle(false); },
                  }}
                />
              )}

              {/*
                The failure, where the person who caused it is looking.

                This rendered at the TOP of the modal body — and settling is the
                last control on a screen that runs to several thousand pixels at
                a full table, so the admin pressed Confirm & Settle, stayed at
                the bottom, and saw nothing change. The button returned to
                "Confirm & Settle" and the explanation sat a screen and a half
                above, unread.

                Same element, same styling, same text — the server's own message,
                which is the useful part. Only its position moved.

                Deliberately NOT inside the confirming branch below: the commit
                handler sets confirmingSettle false before it runs, so that
                branch has already unmounted by the time a failure arrives.
              */}
              {remoteFiguresMoved && (
                <div className="p-3 rounded-xl bg-warning/10 border border-warning/40 text-warning text-[11px] text-center leading-relaxed">
                  A cash-out was confirmed by someone else while you were reviewing. The figures
                  above have changed — check them, then settle again.
                </div>
              )}

              {settlementError && (
                <div className="p-3 rounded-xl bg-danger/10 border border-danger/30 text-danger text-xs text-center">
                  {settlementError}
                </div>
              )}

              {confirmingSettle && preview && (
                <SettlementConfirm
                  result={preview}
                  title="Settle this session?"
                  warning="This locks the results permanently and cannot be undone."
                  formatSigned={formatSignedVal}
                />
              )}
          </div>
        </Sheet>
      )}

      {/* MODAL: CLUB RULES & INFO */}
      {showClubInfoModal && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="furniture w-full sm:max-w-sm max-h-[85vh] overflow-y-auto rounded-t-3xl sm:rounded-3xl">
            <div className="sticky top-0 bg-surface border-b border-line px-5 py-4 flex items-center justify-between z-10">
              <h3 className="text-sm font-semibold text-accent flex items-center gap-2">
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
          <div className="furniture w-full max-w-lg p-6 rounded-3xl space-y-5 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-line pb-3">
              <h3 className="text-base font-semibold text-text flex items-center gap-2">
                <Settings className="w-5 h-5 text-accent" /> Club Rules & Devaluation Settings
              </h3>
              <button onClick={() => setShowSettingsModal(false)} className="text-text-muted hover:text-text cursor-pointer">
                <X className="w-5 h-5" />
              </button>
            </div>

            {(isOwner || isSuperUser) && (
              <button
                onClick={() => { setActiveTab('auditTrail'); setShowSettingsModal(false); }}
                className="w-full flex items-center justify-between p-3 bg-bg border border-line rounded-xl text-xs font-medium text-text-muted hover:text-text transition-colors cursor-pointer"
              >
                <span className="flex items-center gap-2"><FileCheck className="w-4 h-4 text-accent" /> Audit Trail & System Logs</span>
                <ChevronRight className="w-4 h-4" />
              </button>
            )}

            <form onSubmit={handleSaveClubSettings} className="space-y-4">
              <div className="space-y-1">
                <label className="text-[11px] font-medium text-text-muted uppercase">Club Name</label>
                <input
                  type="text"
                  required
                  value={editClubName}
                  onChange={(e) => setEditClubName(e.target.value)}
                  className="w-full bg-bg border border-line rounded-xl px-3.5 py-2.5 text-xs text-text font-medium focus:border-accent outline-none"
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
                  <label className="text-[11px] font-medium text-text-muted uppercase flex items-center gap-1">
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
                      <span className={`block text-xs font-medium ${editBuyInMode === value ? 'text-accent' : 'text-text'}`}>{label}</span>
                      <span className="block text-[10px] text-text-muted mt-0.5">{blurb}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Settlement Rules — everything the Cashout Engine reads at settle time */}
              <div className="p-4 bg-bg border border-line rounded-2xl space-y-4">
                <h4 className="text-xs font-semibold text-accent ">Settlement Rules</h4>

                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium text-text flex items-center gap-2 cursor-pointer">
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
                      <label className="text-[10px] font-medium text-text-muted uppercase">Rake Method</label>
                      <select
                        value={editRakeMethod}
                        onChange={(e) => setEditRakeMethod(e.target.value as RakeMethod)}
                        className="w-full furniture rounded-xl px-2.5 py-2 text-xs font-medium text-text focus:border-accent outline-none"
                      >
                        <option value="PERCENT_PROFIT">% of Winner's Profit</option>
                        <option value="PERCENT_CASHOUT">% of Cashout</option>
                        <option value="FIXED_PER_WINNER">Fixed Amount / Winner</option>
                        <option value="FIXED_PER_SESSION">Fixed Amount / Session</option>
                        <option value="CUSTOM">Custom (coming soon)</option>
                      </select>
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] font-medium text-text-muted uppercase">
                        Rake Value {editRakeMethod === 'PERCENT_PROFIT' || editRakeMethod === 'PERCENT_CASHOUT' ? '(%)' : '(Chips)'}
                      </label>
                      <input
                        type="number"
                        min={0}
                        value={editRakeValue}
                        onChange={(e) => setEditRakeValue(Number(e.target.value))}
                        className="w-full furniture rounded-xl px-3 py-2 text-xs font-mono font-medium text-warning focus:border-accent outline-none"
                      />
                    </div>
                    <div className="space-y-1 col-span-2">
                      <label className="text-[10px] font-medium text-text-muted uppercase">Rake Collection Order</label>
                      <select
                        value={editRakeOrder}
                        onChange={(e) => setEditRakeOrder(e.target.value as RakeOrder)}
                        className="w-full furniture rounded-xl px-2.5 py-2 text-xs font-medium text-text focus:border-accent outline-none"
                      >
                        <option value="MISMATCH_FIRST">Resolve mismatch first, then rake</option>
                        <option value="RAKE_FIRST">Rake first, then resolve mismatch</option>
                      </select>
                    </div>
                  </div>
                )}

                <div className="flex items-center justify-between pt-2 border-t border-line/60">
                  <label className="text-xs font-medium text-text flex items-center gap-2 cursor-pointer">
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
                  <label className="text-[10px] font-medium text-text-muted uppercase">Mismatch Handling Strategy</label>
                  <select
                    value={editMismatchStrategy}
                    onChange={(e) => setEditMismatchStrategy(e.target.value as MismatchStrategy)}
                    className="w-full furniture rounded-xl px-2.5 py-2 text-xs font-medium text-text focus:border-accent outline-none"
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
                    <label className="text-[10px] font-medium text-text-muted uppercase">Winner Definition</label>
                    <select
                      value={editWinnerDefinition}
                      onChange={(e) => setEditWinnerDefinition(e.target.value as WinnerDefinition)}
                      className="w-full furniture rounded-xl px-2.5 py-2 text-xs font-medium text-text focus:border-accent outline-none"
                    >
                      <option value="PROFIT_POSITIVE">Profit greater than zero</option>
                      <option value="TOP_N">Top N finishers</option>
                      <option value="MANUAL">Manual selection</option>
                      <option value="CUSTOM">Custom (coming soon)</option>
                    </select>
                  </div>
                  {editWinnerDefinition === 'TOP_N' && (
                    <div className="space-y-1">
                      <label className="text-[10px] font-medium text-text-muted uppercase">Top N</label>
                      <input
                        type="number"
                        min={1}
                        value={editWinnerTopN}
                        onChange={(e) => setEditWinnerTopN(Math.max(1, Number(e.target.value)))}
                        className="w-full furniture rounded-xl px-3 py-2 text-xs font-mono font-medium text-text focus:border-accent outline-none"
                      />
                    </div>
                  )}
                </div>

                <div className="space-y-1 pt-2 border-t border-line/60">
                  <label className="text-[10px] font-medium text-text-muted uppercase">Rounding Rule</label>
                  <select
                    value={editRoundingRule}
                    onChange={(e) => setEditRoundingRule(e.target.value as RoundingRule)}
                    className="w-full furniture rounded-xl px-2.5 py-2 text-xs font-medium text-text focus:border-accent outline-none"
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
                    <label className="text-xs font-medium text-text flex items-center gap-2 cursor-pointer">
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
                    <label className="text-[11px] font-medium text-text-muted">
                      Devaluation Ratio:
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        min={1}
                        max={100}
                        value={editDevaluationFactor}
                        onChange={(e) => setEditDevaluationFactor(Math.max(1, parseInt(e.target.value) || 1))}
                        className="w-20 furniture rounded-lg px-2.5 py-1.5 text-xs text-accent font-mono font-medium outline-none focus:border-accent"
                      />
                      <span className="text-xs text-text font-mono font-medium">
                        Chips = ₹1 Cash
                      </span>
                    </div>
                    <div className="text-[11px] text-accent font-mono font-medium furniture px-3 py-1 rounded-lg w-full">
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
                  <label className="text-xs font-medium text-text flex items-center gap-2 cursor-pointer">
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
                      <h4 className="text-xs font-medium text-text flex items-center gap-1.5">
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
                        <div key={mUid} className="p-2.5 furniture rounded-xl flex items-center justify-between flex-wrap gap-y-2 text-xs">
                          <div className="flex items-center gap-2 flex-wrap">
                            <div className="w-6 h-6 rounded-full bg-bg text-accent text-[10px] font-medium flex items-center justify-center border border-line">
                              {mUid === currentUser.uid ? 'Me' : (allUsers[mUid]?.displayName ? allUsers[mUid].displayName[0].toUpperCase() : 'M')}
                            </div>
                            <span className="font-semibold text-text">
                              {mUid === currentUser.uid ? (currentUser.displayName || 'You') : (allUsers[mUid]?.displayName || allUsers[mUid]?.email || `Member (${mUid.slice(0, 6)})`)}
                            </span>
                            {isThisOwner && (
                              <span className="px-2 py-0.5 bg-warning/15 border border-warning/50 text-warning font-medium text-[9px] uppercase rounded-full">
                                👑 Club Owner
                              </span>
                            )}
                            {!isThisOwner && isThisAdmin && (
                              <span className="px-2 py-0.5 bg-accent/15 border border-accent/50 text-accent font-medium text-[9px] uppercase rounded-full">
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
                                  className="px-2.5 py-1 bg-warning/80 hover:bg-warning/25 border border-warning/40 text-warning text-[10px] font-medium uppercase rounded-lg cursor-pointer transition-colors"
                                >
                                  Demote Admin
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => promoteAdminAction.run(mUid)}
                                  disabled={(club.adminUids?.length || 0) >= 3 || promoteAdminAction.pending}
                                  className={`px-2.5 py-1 text-[10px] font-medium uppercase rounded-lg transition-all ${
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
                                className="px-2 py-1 bg-danger/15 hover:bg-danger/25 border border-danger/40 text-danger text-[10px] font-medium uppercase rounded-lg cursor-pointer transition-colors"
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
                className="w-full bg-accent hover:bg-accent text-accent-contrast font-semibold py-3 rounded-xl text-xs cursor-pointer shadow-lg disabled:opacity-50"
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
          <div className="furniture w-full max-w-xl p-6 rounded-3xl space-y-5 my-8">
            <div className="flex items-center justify-between border-b border-line pb-3">
              <h3 className="text-base font-semibold text-text flex items-center gap-2">
                <FileEdit className="w-5 h-5 text-accent" /> Edit Session ({editingSession.dayTitle})
              </h3>
              <button onClick={() => setShowEditSessionModal(false)} className="text-text-muted hover:text-text cursor-pointer">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSubmitSessionEdit} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-[11px] font-medium text-text-muted uppercase">Session Date</label>
                  <input
                    type="date"
                    required
                    value={editSessionDate}
                    onChange={(e) => setEditSessionDate(e.target.value)}
                    className="w-full bg-bg border border-line rounded-xl px-3.5 py-2.5 text-xs text-text font-medium focus:border-accent outline-none font-mono"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-[11px] font-medium text-text-muted uppercase">Session Notes</label>
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
                  <h4 className="text-xs font-medium text-text flex items-center gap-1.5">
                    <Users className="w-4 h-4 text-accent" /> Individual Player Buy-Ins & Cash-Outs
                  </h4>
                  <button
                    type="button"
                    onClick={handleAddPlayerToEdit}
                    className="px-2.5 py-1 bg-surface hover:bg-surface-alt border border-line text-accent text-[10px] font-medium uppercase rounded-lg cursor-pointer"
                  >
                    + Add Player
                  </button>
                </div>

                <div className="space-y-2.5 max-h-60 overflow-y-auto pr-1">
                  {editPlayerStats.map((p, idx) => {
                    const profit = (Number(p.cashOut) || 0) - (Number(p.buyIn) || 0);
                    return (
                      <div key={idx} className="p-3 furniture rounded-xl space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <input
                            type="text"
                            required
                            placeholder="Player Name"
                            value={p.name}
                            onChange={(e) => handlePlayerStatChange(idx, 'name', e.target.value)}
                            className="bg-bg border border-line rounded-lg px-2.5 py-1.5 text-xs text-text font-medium focus:border-accent outline-none flex-1"
                          />
                          {/* Gross cash-out minus buy-in, before the club's
                              rules are applied — Calculate below shows the
                              settled figure. */}
                          <span className={`text-xs font-mono font-medium tabular-nums ${profit >= 0 ? 'text-accent' : 'text-danger'}`}>
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
                            <label className="text-[10px] text-text-muted font-medium block mb-0.5">Buy-In (Chips)</label>
                            <input
                              type="number"
                              inputMode="decimal"
                              min={0}
                              required
                              value={p.buyIn}
                              onChange={(e) => handlePlayerStatChange(idx, 'buyIn', Number(e.target.value))}
                              className="w-full bg-bg border border-line rounded-lg px-2.5 py-1 text-xs text-text font-mono font-medium focus:border-accent outline-none"
                            />
                          </div>
                          <div>
                            <label className="text-[10px] text-text-muted font-medium block mb-0.5">Cash-Out (Chips)</label>
                            <input
                              type="number"
                              inputMode="decimal"
                              min={0}
                              required
                              value={p.cashOut}
                              onChange={(e) => handlePlayerStatChange(idx, 'cashOut', Number(e.target.value))}
                              className="w-full bg-bg border border-line rounded-lg px-2.5 py-1 text-xs text-text font-mono font-medium focus:border-accent outline-none"
                            />
                          </div>
                        </div>

                        {/* Link to Club Member Dropdown */}
                        <div className="pt-1 flex items-center gap-2">
                          <label className="text-[10px] text-text-muted font-medium shrink-0">Link Account:</label>
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
                className="w-full flex items-center justify-center gap-2 border border-accent/40 text-accent font-semibold py-3 rounded-xl text-xs disabled:opacity-40 disabled:cursor-not-allowed hover:bg-accent/10 transition-colors"
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
                  className="flex-1 border border-line text-text-muted font-medium py-3 rounded-xl hover:text-text transition-colors text-xs "
                >
                  {editConfirming ? 'Back' : 'Cancel'}
                </button>
                <button
                  type="submit"
                  disabled={submittingEdit || !editCalculated || !editPreview || editPreview.requiresManualResolution}
                  className={`flex-1 font-semibold py-3 rounded-xl text-xs cursor-pointer shadow-lg disabled:opacity-40 disabled:cursor-not-allowed ${editConfirming ? 'bg-warning text-accent-contrast' : 'bg-accent text-accent-contrast'}`}
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
              <h3 className="text-base font-semibold text-danger flex items-center gap-2">
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
                Are you sure you want to delete <strong className="text-danger font-semibold font-mono">{deletingSessionTarget.dayTitle || 'this session'}</strong> ({deletingSessionTarget.date})?
              </p>

              <div className="p-3 bg-bg border border-danger/60 rounded-xl space-y-1.5 font-mono text-[11px]">
                <div className="text-text-muted">Players: <span className="text-text font-semibold">{deletingSessionTarget.playersCount}</span></div>
                <div className="text-text-muted">Total Buy-Ins: <span className="text-warning font-semibold">{formatVal(deletingSessionTarget.totalBuyIns)}</span></div>
              </div>

              <p className="text-[11px] text-text-muted">
                ⚠️ This will soft-delete the session record and automatically recalculate player leaderboards and overall stats. You can restore this session anytime from the Audit Trail.
              </p>

              {(!isOwner && !isSuperUser && (club.adminUids || []).filter(u => u !== currentUser.uid && u !== club.ownerUid && u !== club.createdBy).length > 0) && (
                <div className="p-3 bg-warning/60 border border-warning/40 rounded-xl text-[11px] text-warning space-y-1">
                  <p className="font-semibold flex items-center gap-1">
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
                className="px-4 py-2.5 bg-bg hover:bg-surface-alt border border-line text-text-muted font-medium rounded-xl text-xs cursor-pointer"
              >
                Cancel
              </button>

              <button
                type="button"
                disabled={submittingDelete}
                onClick={() => performDeleteSession(deletingSessionTarget)}
                className="px-5 py-2.5 bg-danger hover:bg-danger text-white font-semibold rounded-xl text-xs cursor-pointer shadow-lg disabled:opacity-50 flex items-center gap-1.5"
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
              className="furniture rounded-3xl p-5 space-y-3 mb-16"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between border-b border-line pb-3">
                <span className="text-xs font-semibold text-accent ">
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
                  className="w-full bg-accent hover:bg-accent text-accent-contrast font-semibold p-3.5 rounded-2xl text-xs flex items-center justify-center gap-2 shadow-lg cursor-pointer min-h-[48px]"
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
                    className="w-full bg-surface-alt hover:bg-line-strong border border-line-strong text-text font-medium p-3.5 rounded-2xl text-xs flex items-center justify-center gap-2 cursor-pointer min-h-[48px]"
                  >
                    <Play className="w-4 h-4 text-accent" /> Start New Session
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {/*
          One primary action, in a bar above the nav.

          This replaces a circular FAB that floated over the content and
          physically overlapped the cash-out bar beneath it — three controls
          (FAB, bar, nav) all claiming primacy in the same corner, which means
          none had it. A bar is also a bigger, squarer target than a 56px circle
          pinned to the right edge, and it does not cover the row it sits on.

          The label changes with the situation, because the "next thing" genuinely
          differs: chips when you are seated, settle when the night is over.
        */}
        {/* The redesigned screen owns its own next-action bar, and its whole
            point is that there often isn't one. Leaving this pair underneath it
            would put the two competing primaries back on the screen that exists
            to remove them. */}

        {/* Sticky Bottom Navigation Bar */}
          <nav className="fixed bottom-0 left-0 right-0 z-40 shelf py-2 px-1 flex items-center">
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
                      <span className="absolute -top-1 -right-1.5 bg-danger text-white font-semibold text-[8px] w-3.5 h-3.5 rounded-full flex items-center justify-center">
                        {item.badge}
                      </span>
                    )}
                  </div>
                  <span className="text-[10px] font-medium tracking-tight font-sans leading-tight truncate max-w-full">
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
          <div className="furniture w-full max-w-md p-6 rounded-3xl space-y-5">
            <div className="flex items-center justify-between border-b border-line pb-3">
              <h3 className="text-base font-semibold text-text flex items-center gap-2">
                <LinkIcon className="w-5 h-5 text-accent" /> Link Player to Member
              </h3>
              <button onClick={() => setShowLinkModal(false)} className="text-text-muted hover:text-text cursor-pointer">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-4">
              <div className="p-3 bg-bg border border-line rounded-xl space-y-1 text-xs">
                <div className="text-[10px] text-text-muted font-medium uppercase">Ledger Player Entry:</div>
                <div className="text-text font-medium text-sm font-mono">{linkingPlayerName}</div>
                <div className="text-[10px] text-text-muted">Session: {linkingSession?.dayTitle || linkingSession?.sessionDate || 'Historical Session'}</div>
              </div>

              <div className="space-y-1.5">
                <label className="text-[11px] font-medium text-text-muted uppercase block">
                  Select Registered Club Member to Link:
                </label>
                <select
                  value={linkingSelectedUserUid}
                  onChange={(e) => setLinkingSelectedUserUid(e.target.value)}
                  className="w-full bg-bg border border-line rounded-xl p-3 text-xs text-text font-mono font-medium focus:border-accent outline-none"
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
                  className="flex-1 py-2.5 bg-bg hover:furniture text-text-muted font-medium rounded-xl text-xs "
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={!linkingSelectedUserUid || isSavingLink}
                  onClick={handleSavePlayerLink}
                  className="flex-1 py-2.5 bg-accent hover:bg-accent text-accent-contrast font-semibold rounded-xl text-xs cursor-pointer disabled:opacity-50 shadow-lg"
                >
                  {isSavingLink ? 'LINKING...' : 'SAVE PLAYER LINK'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
      {confirmAction.dialog}

    </div>
  );
};
