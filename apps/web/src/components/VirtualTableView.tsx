import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { AppUser as User } from '../lib/auth-types';
import { Club } from '../types';
import * as sessionsApi from '../lib/sessions-api';
import { VTSession, VTSeat, VTHandHistoryRecord, VTBuyInRequest } from '../lib/sessions-api';
import { getSocket } from '../lib/socket';
import { ApiError } from '../lib/api-client';
import { PlayingCard } from './PlayingCard';
import {
  Crown,
  Play,
  RotateCcw,
  Clock,
  Award,
  Eye,
  Settings,
  X,
  Plus,
  History,
  TrendingUp,
  Sparkles,
  Flame,
  Layers,
  Bot,
  UserPlus,
  AlertTriangle,
  Info,
  Check,
  Ban
} from 'lucide-react';

interface VirtualTableViewProps {
  club: Club;
  currentUser: User;
  isAdmin: boolean;
  playerAvatarUrl?: string;
  formatVal: (amount: number) => string;
}

const TURN_DURATION_SEC = 30;

function getActiveSeats(seats: VTSeat[]): VTSeat[] {
  return seats.filter(s => s.uid && !s.isSatOut && s.chipStack > 0).sort((a, b) => a.seatNumber - b.seatNumber);
}

// ==========================================================
// PRESENTATIONAL SUBCOMPONENTS (memoized so a 1-second timer
// tick or an unrelated seat update doesn't re-render the whole
// table)
// ==========================================================

const TurnTimerBadge: React.FC<{ turnStartedAt?: string; isActive: boolean }> = React.memo(({ turnStartedAt, isActive }) => {
  const [, forceTick] = useState(0);

  useEffect(() => {
    if (!isActive) return;
    const id = setInterval(() => forceTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, [isActive, turnStartedAt]);

  const remaining = turnStartedAt
    ? Math.max(0, TURN_DURATION_SEC - Math.floor((Date.now() - new Date(turnStartedAt).getTime()) / 1000))
    : TURN_DURATION_SEC;

  return <strong className="text-warning font-bold">{remaining}s</strong>;
});

interface SeatCardProps {
  seat: VTSeat;
  isMyTurn: boolean;
  isDealer: boolean;
  showCards: boolean;
}

const SeatCard: React.FC<SeatCardProps> = React.memo(({ seat, isMyTurn, isDealer, showCards }) => {
  return (
    <div
      className={`p-2.5 md:p-3 rounded-2xl border transition-all ${
        isMyTurn
          ? 'bg-surface-alt border-2 border-accent-2 shadow-[0_0_20px_rgba(226,183,85,0.4)] scale-105'
          : seat.isFolded
          ? 'bg-bg/50 border-line/40 opacity-50'
          : 'bg-bg border-line'
      }`}
    >
      <div className="flex items-center justify-between text-xs font-bold text-text mb-1">
        <div className="flex items-center gap-1.5 truncate">
          <div className="w-6 h-6 rounded-full bg-surface-alt border border-accent-2 text-accent-2 text-[10px] flex items-center justify-center font-black shrink-0">
            {seat.name[0]?.toUpperCase() || '?'}
          </div>
          <span className="truncate">{seat.name}</span>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {isDealer && <span className="bg-accent-2 text-accent-contrast text-[9px] font-black px-1.5 py-0.5 rounded-full">D</span>}
          {seat.isAllIn && <span className="bg-danger text-white text-[9px] font-black px-1.5 py-0.5 rounded-full">ALL-IN</span>}
        </div>
      </div>

      <div className="text-[11px] font-mono font-bold text-warning flex items-center justify-between">
        <span>Stack: ₹{seat.chipStack.toLocaleString()}</span>
        {(seat.currentBet || 0) > 0 && <span className="text-accent">Bet: ₹{seat.currentBet}</span>}
      </div>

      <div className="flex items-center justify-center gap-1 pt-2 min-h-[44px]">
        {seat.holeCards.length > 0 ? (
          seat.holeCards.map((c, i) => (
            <div key={i} className="w-8 h-12">
              {showCards ? (
                <PlayingCard card={c} size="sm" />
              ) : (
                <div className="w-full h-full bg-surface border border-line-strong rounded-lg flex items-center justify-center text-[10px] font-bold text-text-muted">
                  🂠
                </div>
              )}
            </div>
          ))
        ) : (
          <span className="text-[10px] text-text-muted italic">{seat.isFolded ? 'Folded' : 'Waiting...'}</span>
        )}
      </div>
    </div>
  );
});

export const VirtualTableView: React.FC<VirtualTableViewProps> = ({ club, currentUser, isAdmin, playerAvatarUrl, formatVal }) => {
  const [activeTab, setActiveTab] = useState<'table' | 'history' | 'stats' | 'spectate' | 'settings'>('table');

  const [session, setSession] = useState<VTSession | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [handHistory, setHandHistory] = useState<VTHandHistoryRecord[]>([]);
  const [pendingBuyIns, setPendingBuyIns] = useState<VTBuyInRequest[]>([]);

  // Host table-creation form state (local until submitted)
  const [tableName, setTableName] = useState(`${club.name} Virtual Table`);
  const [smallBlind, setSmallBlind] = useState(10);
  const [bigBlind, setBigBlind] = useState(10);
  const [minBuyIn, setMinBuyIn] = useState(club.minBuyIn || 1000);
  const [maxBuyIn, setMaxBuyIn] = useState(club.maxBuyIn || 5000);
  const [maxSeats, setMaxSeats] = useState(9);
  const [allowedSkipBlinds, setAllowedSkipBlinds] = useState(2);

  // Table config edit form (host, Settings tab)
  const [editTableName, setEditTableName] = useState(tableName);
  const [editSmallBlind, setEditSmallBlind] = useState(10);
  const [editBigBlind, setEditBigBlind] = useState(10);
  const [editSkipBlinds, setEditSkipBlinds] = useState(2);

  // Local-only UI state (not shared across devices)
  const [betSliderValue, setBetSliderValue] = useState(20);
  const [notificationMsg, setNotificationMsg] = useState<string | null>(null);
  const [showBuyInModal, setShowBuyInModal] = useState(false);
  const [buyInAmount, setBuyInAmount] = useState(minBuyIn);
  const [createError, setCreateError] = useState('');

  const me = session?.playerSeats?.find(p => p.uid === currentUser.uid);
  const isHost = !!session && (currentUser.uid === session.hostUid || isAdmin);
  const gameStage: 'idle' | 'preflop' | 'flop' | 'turn' | 'river' | 'showdown' = !session?.isGameStarted
    ? 'idle'
    : (session.street.toLowerCase() as 'preflop' | 'flop' | 'turn' | 'river' | 'showdown');

  const showNotification = (msg: string) => {
    setNotificationMsg(msg);
    setTimeout(() => setNotificationMsg(prev => (prev === msg ? null : prev)), 4500);
  };

  const refreshHandHistory = useCallback(async (sessionId: string) => {
    try {
      setHandHistory(await sessionsApi.listHandHistory(sessionId));
    } catch (err) {
      console.error('Failed to load hand history:', err);
    }
  }, []);

  const refreshBuyIns = useCallback(async (sessionId: string) => {
    try {
      const all = await sessionsApi.listBuyInRequests(sessionId);
      setPendingBuyIns(all.filter(r => r.status === 'pending'));
    } catch (err) {
      console.error('Failed to load buy-in requests:', err);
    }
  }, []);

  // Initial load: find this club's active Virtual Table session
  const loadActiveSession = useCallback(async () => {
    try {
      const active = await sessionsApi.getActiveVirtualTable(club.id);
      setSession(active);
      if (active) {
        refreshHandHistory(active.id);
        refreshBuyIns(active.id);
      }
    } catch (err) {
      console.error('Failed to load virtual table session:', err);
    } finally {
      setSessionLoading(false);
    }
  }, [club.id, refreshHandHistory, refreshBuyIns]);

  useEffect(() => {
    loadActiveSession();
  }, [loadActiveSession]);

  // Live sync: join this club's room to hear about session create/end, and
  // the session's own room for live engine-state updates.
  useEffect(() => {
    const socket = getSocket();
    socket.emit('club:join', club.id);

    const onSessionCreated = () => loadActiveSession();
    const onSessionEnded = () => loadActiveSession();
    socket.on('club:session-created', onSessionCreated);
    socket.on('club:session-ended', onSessionEnded);

    return () => {
      socket.emit('club:leave', club.id);
      socket.off('club:session-created', onSessionCreated);
      socket.off('club:session-ended', onSessionEnded);
    };
  }, [club.id, loadActiveSession]);

  useEffect(() => {
    if (!session) return;
    const socket = getSocket();
    socket.emit('session:join', session.id);

    const onUpdate = (updated: VTSession) => {
      setSession(updated);
      refreshBuyIns(updated.id);
    };
    socket.on('session:update', onUpdate);

    return () => {
      socket.emit('session:leave', session.id);
      socket.off('session:update', onUpdate);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id]);

  // Refresh hand history whenever a new hand starts or ends
  useEffect(() => {
    if (session) refreshHandHistory(session.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.handNumber, session?.street]);

  // Reset the Settings-tab edit form whenever a (new) session is loaded
  useEffect(() => {
    if (session) {
      setEditTableName(session.tableName);
      setEditSmallBlind(session.smallBlind);
      setEditBigBlind(session.bigBlind);
      setEditSkipBlinds(session.skipBlindLimit);
    }
  }, [session?.id]);

  // Suggest a sensible default raise size whenever a new turn starts for me
  useEffect(() => {
    if (session && me && session.currentTurnSeat === me.seatNumber) {
      const minRaise = Math.max(session.bigBlind * 2, session.currentHighBet * 2);
      setBetSliderValue(Math.min(minRaise, me.chipStack + (me.currentBet || 0)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.currentTurnSeat, session?.turnStartedAt]);

  // ----------------------------------------------------------
  // Host: create the table
  // ----------------------------------------------------------
  const handleHostStartGame = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isAdmin) return;
    setCreateError('');
    try {
      const created = await sessionsApi.createVirtualTable(club.id, {
        tableName,
        smallBlind,
        bigBlind,
        minBuyIn,
        maxBuyIn,
        maxPlayers: maxSeats,
        skipBlindLimit: allowedSkipBlinds,
      });
      setSession(created);
      showNotification(`🎮 Virtual Game Hosted! At least 2 players must enter/join table before dealing.`);
    } catch (err) {
      console.error('Failed to host virtual table:', err);
      setCreateError(err instanceof Error ? err.message : 'Failed to host virtual table.');
    }
  };

  // ----------------------------------------------------------
  // Seat management
  // ----------------------------------------------------------
  const handleEnterTable = async () => {
    if (!session) return;
    try {
      const updated = await sessionsApi.enterSeat(session.id);
      setSession(updated);
      showNotification(`✅ You entered the table!`);
    } catch (err) {
      console.error('Failed to enter table:', err);
      alert(err instanceof Error ? err.message : 'Failed to enter table.');
    }
  };

  const handleAddBotPlayer = async () => {
    if (!session) return;
    try {
      const updated = await sessionsApi.addBot(session.id);
      setSession(updated);
      showNotification(`🤖 A bot player entered the table!`);
    } catch (err) {
      console.error('Failed to add bot player:', err);
      alert(err instanceof Error ? err.message : 'Failed to add bot.');
    }
  };

  // ----------------------------------------------------------
  // Dealing / betting actions
  // ----------------------------------------------------------
  const startNewHand = async () => {
    if (!session) return;
    if (getActiveSeats(session.playerSeats).length < 2) {
      alert('⚠️ Game cannot start before at least two active players have entered the table!');
      return;
    }
    try {
      setSession(await sessionsApi.dealHand(session.id));
    } catch (err) {
      console.error('Failed to deal hand:', err);
      alert(err instanceof Error ? err.message : 'Failed to deal hand.');
    }
  };

  const handleFold = async () => {
    if (!session) return;
    try {
      setSession(await sessionsApi.fold(session.id));
    } catch (err) {
      console.error('Fold failed:', err);
      showNotification(err instanceof ApiError ? `⚠️ ${err.message}` : '⚠️ Fold failed — please try again.');
    }
  };

  const handleCheck = async () => {
    if (!session) return;
    try {
      setSession(await sessionsApi.check(session.id));
    } catch (err) {
      console.error('Check failed:', err);
      showNotification(err instanceof ApiError ? `⚠️ ${err.message}` : '⚠️ Check failed — please try again.');
    }
  };

  const handleCall = async () => {
    if (!session) return;
    try {
      setSession(await sessionsApi.call(session.id));
    } catch (err) {
      console.error('Call failed:', err);
      showNotification(err instanceof ApiError ? `⚠️ ${err.message}` : '⚠️ Call failed — please try again.');
    }
  };

  const handleBetRaise = async (targetBet: number) => {
    if (!session) return;
    try {
      setSession(await sessionsApi.raise(session.id, targetBet));
    } catch (err) {
      console.error('Raise failed:', err);
      showNotification(err instanceof ApiError ? `⚠️ ${err.message}` : '⚠️ Raise failed — please try again.');
    }
  };

  // ----------------------------------------------------------
  // Buy-ins
  // ----------------------------------------------------------
  const handleRequestBuyIn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!session) return;
    if (buyInAmount < session.minBuyIn) {
      alert(`Minimum buy-in is ₹${session.minBuyIn.toLocaleString()}`);
      return;
    }
    try {
      await sessionsApi.requestBuyIn(session.id, Number(buyInAmount));
      showNotification('💰 Buy-in request submitted to the table host!');
      setShowBuyInModal(false);
      refreshBuyIns(session.id);
    } catch (err) {
      console.error('Buy-in request failed:', err);
    }
  };

  const handleApproveBuyIn = async (req: VTBuyInRequest) => {
    if (!session) return;
    try {
      setSession(await sessionsApi.decideBuyInRequest(session.id, req.id, true));
      refreshBuyIns(session.id);
      showNotification(`✅ Approved ₹${req.amount.toLocaleString()}!`);
    } catch (err) {
      console.error('Approve buy-in failed:', err);
    }
  };

  const handleRejectBuyIn = async (req: VTBuyInRequest) => {
    if (!session) return;
    try {
      await sessionsApi.decideBuyInRequest(session.id, req.id, false);
      refreshBuyIns(session.id);
    } catch (err) {
      console.error('Reject buy-in failed:', err);
    }
  };

  // ----------------------------------------------------------
  // Table config + ending the session
  // ----------------------------------------------------------
  const handleSaveTableSettings = async () => {
    if (!session || !isHost) return;
    try {
      setSession(await sessionsApi.updateSettings(session.id, {
        tableName: editTableName.trim() || session.tableName,
        smallBlind: editSmallBlind,
        bigBlind: editBigBlind,
        skipBlindLimit: editSkipBlinds,
      }));
      showNotification('✅ Table settings updated.');
    } catch (err) {
      console.error('Failed to update table settings:', err);
    }
  };

  const handleEndVirtualTableSession = async () => {
    if (!session) return;
    if (!confirm('End this Virtual Table session? Results will be recorded in Club History and Leaderboard.')) return;
    try {
      await sessionsApi.endSession(session.id);
      alert('🎉 Virtual Table Session ended! Recorded in Club Session History & Leaderboard.');
      setSession(null);
      loadActiveSession();
    } catch (err) {
      console.error('Failed to end session:', err);
      alert('Failed to end session cleanly — please try again.');
    }
  };

  const sortedSeats = useMemo(() => [...(session?.playerSeats || [])].sort((a, b) => a.seatNumber - b.seatNumber), [session?.playerSeats]);

  // ==========================================================
  // UNSTARTED STATE
  // ==========================================================
  if (sessionLoading) {
    return <div className="p-12 text-center text-xs text-text-muted font-mono">Loading Virtual Table…</div>;
  }

  if (!session) {
    if (!isAdmin) {
      return (
        <div className="bg-surface border border-line p-8 md:p-12 rounded-3xl text-center space-y-4 shadow-xl max-w-xl mx-auto my-6 font-sans">
          <div className="w-14 h-14 rounded-2xl bg-bg border-2 border-accent-2 text-accent-2 flex items-center justify-center mx-auto shadow-xl">
            <Sparkles className="w-8 h-8" />
          </div>
          <h3 className="text-lg font-bold text-text uppercase tracking-wide">No Active Virtual Table Session</h3>
          <p className="text-xs text-text-muted leading-relaxed max-w-md mx-auto">
            Virtual Table sessions must be hosted by a Club Admin for <strong className="text-text">{club.name}</strong>. Please ask a Club Admin to start a session!
          </p>
          <div className="p-3 bg-bg border border-line rounded-2xl text-xs text-warning font-mono inline-block shadow">
            Waiting for Club Admin to host Virtual Table...
          </div>
        </div>
      );
    }

    return (
      <div className="bg-surface border border-line p-6 md:p-8 rounded-3xl space-y-6 shadow-2xl font-sans">
        <div className="text-center space-y-3 border-b border-line pb-6">
          <div className="w-14 h-14 rounded-2xl bg-bg border-2 border-accent-2 text-accent-2 flex items-center justify-center mx-auto shadow-xl">
            <Sparkles className="w-8 h-8" />
          </div>
          <h2 className="text-2xl font-black text-text uppercase tracking-wide">Start & Host Virtual Table</h2>
          <p className="text-xs text-text-muted max-w-xl mx-auto leading-relaxed">
            In Virtual Table mode, a player or admin must <strong>start a game session first</strong> to become the table host, define table rules, and allow players to request buy-ins and enter seats.
          </p>
        </div>

        {createError && (
          <div className="p-3 bg-danger/80 border border-danger/40 text-danger text-xs rounded-xl text-center max-w-2xl mx-auto">
            {createError}
          </div>
        )}

        <form onSubmit={handleHostStartGame} className="max-w-2xl mx-auto space-y-6">
          <div className="p-4 bg-bg border border-line rounded-2xl flex items-center gap-3">
            <Crown className="w-5 h-5 text-accent-2 shrink-0" />
            <div className="text-xs text-text-muted">
              Host: <strong className="text-text font-bold">{currentUser.displayName || currentUser.email}</strong> — You will configure the table settings and become the game host.
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
            <div className="space-y-1">
              <label className="text-text font-bold">Virtual Table Name:</label>
              <input
                type="text"
                value={tableName}
                onChange={e => setTableName(e.target.value)}
                className="w-full bg-bg border border-line rounded-xl px-3.5 py-2.5 text-text font-bold focus:border-accent-2 outline-none"
                required
              />
            </div>

            <div className="space-y-1">
              <label className="text-text font-bold">Small Blind (Chips):</label>
              <input
                type="number"
                value={smallBlind}
                onChange={e => setSmallBlind(Number(e.target.value))}
                className="w-full bg-bg border border-line rounded-xl px-3.5 py-2.5 text-text font-bold focus:border-accent-2 outline-none"
                required
              />
            </div>

            <div className="space-y-1">
              <label className="text-text font-bold">Big Blind (Chips):</label>
              <input
                type="number"
                value={bigBlind}
                onChange={e => setBigBlind(Number(e.target.value))}
                className="w-full bg-bg border border-line rounded-xl px-3.5 py-2.5 text-text font-bold focus:border-accent-2 outline-none"
                required
              />
            </div>

            <div className="space-y-1">
              <label className="text-text font-bold">Minimum Buy-In (Chips):</label>
              <input
                type="number"
                value={minBuyIn}
                onChange={e => setMinBuyIn(Number(e.target.value))}
                className="w-full bg-bg border border-line rounded-xl px-3.5 py-2.5 text-text font-bold focus:border-accent-2 outline-none"
                required
              />
            </div>

            <div className="space-y-1">
              <label className="text-text font-bold">Maximum Buy-In (Chips):</label>
              <input
                type="number"
                value={maxBuyIn}
                onChange={e => setMaxBuyIn(Number(e.target.value))}
                className="w-full bg-bg border border-line rounded-xl px-3.5 py-2.5 text-text font-bold focus:border-accent-2 outline-none"
                required
              />
            </div>

            <div className="space-y-1">
              <label className="text-text font-bold">Allowed Blind Skips:</label>
              <select
                value={allowedSkipBlinds}
                onChange={e => setAllowedSkipBlinds(Number(e.target.value))}
                className="w-full bg-bg border border-line rounded-xl px-3.5 py-2.5 text-text font-bold focus:border-accent-2 outline-none"
              >
                <option value={0}>0 (Strict - No Missed Blinds)</option>
                <option value={1}>1 Missed Blind Allowed</option>
                <option value={2}>2 Missed Blinds Allowed (Default)</option>
              </select>
            </div>
          </div>

          <div className="p-4 bg-accent/60 border border-accent/40 rounded-2xl flex items-start gap-2.5 text-xs text-accent">
            <Info className="w-4 h-4 shrink-0 mt-0.5" />
            <p>
              Rule Enforcement: The virtual table will require <strong>at least 2 players</strong> to enter before hands can be dealt.
            </p>
          </div>

          <button
            type="submit"
            className="w-full py-4 bg-accent-2 hover:bg-accent-2 text-accent-contrast font-black rounded-2xl text-xs uppercase tracking-widest cursor-pointer shadow-xl transition-all"
          >
            Start Game & Become Table Host
          </button>
        </form>
      </div>
    );
  }

  // ==========================================================
  // STARTED STATE
  // ==========================================================
  return (
    <div className="space-y-6 animate-fade-in font-sans">
      {/* Top Virtual Table Header */}
      <div className="bg-surface border border-line p-4 md:p-6 rounded-3xl space-y-4 shadow-xl">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-line pb-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="px-2.5 py-0.5 bg-accent/15 border border-accent/50 text-accent font-bold text-[10px] uppercase rounded-full flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-accent animate-ping" /> ONLINE VIRTUAL TABLE
              </span>
              <span className="px-2 py-0.5 bg-bg border border-accent-2/50 text-accent-2 font-bold text-[10px] uppercase rounded-full flex items-center gap-1">
                <Crown className="w-3 h-3" /> HOST: {session.hostName}
              </span>
              <span className="text-xs text-text-muted font-mono">Blinds: ₹{session.smallBlind} / ₹{session.bigBlind}</span>
            </div>
            <h2 className="text-xl md:text-2xl font-black text-text uppercase mt-1 flex items-center gap-2">
              <Sparkles className="w-6 h-6 text-accent-2" /> {session.tableName}
            </h2>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => setShowBuyInModal(true)}
              className="bg-accent-2 hover:bg-accent-2 text-accent-contrast font-black px-4 py-2.5 rounded-xl text-xs uppercase tracking-wider transition-all cursor-pointer flex items-center gap-1.5 shadow"
            >
              <Plus className="w-4 h-4" /> Request Buy-In / Bank
            </button>

            {!sortedSeats.some(p => p.uid === currentUser.uid) && (
              <button
                onClick={handleEnterTable}
                className="bg-surface-alt hover:bg-line-strong border border-line-strong text-text font-bold px-3.5 py-2.5 rounded-xl text-xs uppercase cursor-pointer flex items-center gap-1.5"
              >
                <UserPlus className="w-4 h-4 text-accent" /> Enter Table
              </button>
            )}

            {isHost && (
              <button
                onClick={handleAddBotPlayer}
                className="bg-bg hover:bg-surface border border-line text-text-muted font-bold px-3 py-2.5 rounded-xl text-xs uppercase cursor-pointer flex items-center gap-1.5"
              >
                <Bot className="w-4 h-4 text-accent-2" /> + AI Partner
              </button>
            )}

            {isHost && (
              <button
                onClick={startNewHand}
                disabled={sortedSeats.length < 2}
                className={`px-4 py-2.5 rounded-xl text-xs uppercase tracking-wider font-extrabold cursor-pointer flex items-center gap-1.5 ${
                  getActiveSeats(sortedSeats).length >= 2
                    ? 'bg-accent/50 hover:bg-accent text-accent-contrast shadow-lg'
                    : 'bg-bg border border-danger/80 text-danger opacity-80 cursor-not-allowed'
                }`}
              >
                <RotateCcw className="w-4 h-4 text-accent-2" />
                {gameStage === 'idle'
                  ? getActiveSeats(sortedSeats).length >= 2
                    ? 'Deal First Hand'
                    : `Waiting for 2nd Player (${getActiveSeats(sortedSeats).length}/2)`
                  : 'Deal Next Hand'}
              </button>
            )}
          </div>
        </div>

        {/* Navigation Tabs */}
        <div className="flex flex-wrap gap-2 pt-1">
          <button
            onClick={() => setActiveTab('table')}
            className={`px-4 py-2 rounded-xl text-xs font-bold uppercase tracking-wider transition-all cursor-pointer flex items-center gap-1.5 ${
              activeTab === 'table' ? 'bg-accent-2 text-accent-contrast font-black shadow-lg' : 'bg-bg border border-line text-text-muted hover:text-text'
            }`}
          >
            <Play className="w-3.5 h-3.5 fill-current" /> Live Table Canvas
          </button>

          <button
            onClick={() => setActiveTab('history')}
            className={`px-4 py-2 rounded-xl text-xs font-bold uppercase tracking-wider transition-all cursor-pointer flex items-center gap-1.5 ${
              activeTab === 'history' ? 'bg-accent-2 text-accent-contrast font-black shadow-lg' : 'bg-bg border border-line text-text-muted hover:text-text'
            }`}
          >
            <History className="w-3.5 h-3.5" /> Hand History ({handHistory.length})
          </button>

          <button
            onClick={() => setActiveTab('stats')}
            className={`px-4 py-2 rounded-xl text-xs font-bold uppercase tracking-wider transition-all cursor-pointer flex items-center gap-1.5 ${
              activeTab === 'stats' ? 'bg-accent-2 text-accent-contrast font-black shadow-lg' : 'bg-bg border border-line text-text-muted hover:text-text'
            }`}
          >
            <TrendingUp className="w-3.5 h-3.5" /> Player Statistics & HUD
          </button>

          <button
            onClick={() => setActiveTab('spectate')}
            className={`px-4 py-2 rounded-xl text-xs font-bold uppercase tracking-wider transition-all cursor-pointer flex items-center gap-1.5 ${
              activeTab === 'spectate' ? 'bg-accent-2 text-accent-contrast font-black shadow-lg' : 'bg-bg border border-line text-text-muted hover:text-text'
            }`}
          >
            <Eye className="w-3.5 h-3.5" /> Spectator Mode
          </button>

          {isHost && (
            <button
              onClick={() => setActiveTab('settings')}
              className={`px-4 py-2 rounded-xl text-xs font-bold uppercase tracking-wider transition-all cursor-pointer flex items-center gap-1.5 ${
                activeTab === 'settings' ? 'bg-accent-2 text-accent-contrast font-black shadow-lg' : 'bg-bg border border-line text-text-muted hover:text-text'
              }`}
            >
              <Settings className="w-3.5 h-3.5" /> Table Config
            </button>
          )}
        </div>
      </div>

      {/* TAB 1: LIVE POKER TABLE CANVAS */}
      {activeTab === 'table' && (
        <div className="space-y-6">
          {notificationMsg && (
            <div className="p-3 bg-bg border border-line rounded-2xl flex items-center justify-between text-xs text-accent-2 font-mono">
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-accent-2" />
                <span>{notificationMsg}</span>
              </div>
              <button onClick={() => setNotificationMsg(null)} className="text-text-muted hover:text-text">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {getActiveSeats(sortedSeats).length < 2 && (
            <div className="p-4 bg-warning/80 border-2 border-accent-2 rounded-2xl flex items-center justify-between text-xs font-mono text-accent-2">
              <div className="flex items-center gap-2.5">
                <AlertTriangle className="w-5 h-5 text-accent-2 shrink-0" />
                <span>
                  <strong>Game cannot start before two people have entered the table.</strong> Currently seated: {sortedSeats.length}/2.
                </span>
              </div>
              {isHost && (
                <button
                  onClick={handleAddBotPlayer}
                  className="px-3 py-1.5 bg-accent-2 text-accent-contrast font-black rounded-xl uppercase text-[11px] cursor-pointer"
                >
                  + Add AI Partner Now
                </button>
              )}
            </div>
          )}

          {/* OVAL POKER TABLE VISUALIZATION */}
          <div className="relative w-full aspect-[16/10] max-h-[580px] bg-gradient-to-b from-surface via-surface to-bg rounded-[60px] border-[12px] border-line shadow-[0_0_50px_rgba(0,0,0,0.8)] p-4 flex flex-col justify-between overflow-hidden">
            <div className="absolute inset-3 rounded-[50px] border-2 border-accent-2/30 pointer-events-none" />

            <div className="relative z-10 flex items-center justify-between px-6 pt-2">
              <div className="bg-bg/90 border border-line px-3 py-1 rounded-full text-[10px] text-text-muted font-mono flex items-center gap-2">
                <span className="text-accent-2 font-bold">HAND #{session.handNumber}</span>
                <span>•</span>
                <span>
                  STAGE: <strong className="text-text uppercase">{gameStage}</strong>
                </span>
              </div>

              <div className="bg-bg/95 border-2 border-accent-2 px-5 py-2 rounded-2xl text-center shadow-xl">
                <div className="text-[10px] text-text-muted uppercase tracking-wider font-bold">TOTAL POT</div>
                <div className="text-lg md:text-xl font-black text-accent-2 font-mono">{formatVal(session.potSize)}</div>
              </div>

              <div className="bg-bg/90 border border-line px-3 py-1 rounded-full text-[10px] text-text-muted font-mono flex items-center gap-2">
                <Clock className="w-3.5 h-3.5 text-accent-2" />
                <span>
                  TIMER:{' '}
                  <TurnTimerBadge
                    turnStartedAt={session.turnStartedAt}
                    isActive={session.isGameStarted && session.street !== 'Showdown' && session.currentTurnSeat != null}
                  />
                </span>
              </div>
            </div>

            <div className="relative z-10 my-auto text-center space-y-3">
              <div className="text-[11px] font-black tracking-[0.3em] text-accent-2/40 uppercase">THE HOUSE KEEPS SCORE · VIRTUAL TABLE</div>

              <div className="flex items-center justify-center gap-2 md:gap-3 min-h-[90px]">
                {[0, 1, 2, 3, 4].map(idx => {
                  const card = session.communityCards[idx];
                  return (
                    <div key={idx} className="w-14 h-20 md:w-16 md:h-24">
                      {card ? (
                        <PlayingCard card={card} size="md" />
                      ) : (
                        <div className="w-full h-full border-2 border-dashed border-line rounded-xl flex items-center justify-center text-line font-mono text-xs">
                          {idx < 3 ? 'FLOP' : idx === 3 ? 'TURN' : 'RIVER'}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {session.winningAnnouncement && (
                <div className="p-3 bg-warning/90 border-2 border-accent-2 rounded-2xl max-w-md mx-auto animate-bounce shadow-2xl">
                  <div className="text-xs font-black text-accent-2 uppercase tracking-wider flex items-center justify-center gap-1.5">
                    <Award className="w-4 h-4 text-accent-2" /> WINNER SHOWDOWN!
                  </div>
                  <div className="text-sm font-bold text-text">
                    {session.winningAnnouncement.winners.join(', ')} won {formatVal(session.winningAnnouncement.amountWon)}!
                  </div>
                  <div className="text-[11px] text-warning font-mono">{session.winningAnnouncement.handDesc}</div>
                </div>
              )}
            </div>

            <div className="relative z-10 grid grid-cols-2 sm:grid-cols-4 gap-2 md:gap-4 px-2 pb-2">
              {sortedSeats.map(seat => (
                <SeatCard
                  key={seat.uid}
                  seat={seat}
                  isMyTurn={session.currentTurnSeat === seat.seatNumber && gameStage !== 'showdown'}
                  isDealer={session.dealerSeat === seat.seatNumber}
                  showCards={seat.uid === currentUser.uid || gameStage === 'showdown'}
                />
              ))}
            </div>
          </div>

          {/* PLAYER BETTING ACTION CONTROL CONSOLE */}
          {me && !me.isFolded && session.currentTurnSeat === me.seatNumber && gameStage !== 'showdown' && (
            <div className="bg-surface border-2 border-accent-2 p-5 rounded-3xl space-y-4 shadow-2xl animate-fade-in">
              <div className="flex items-center justify-between border-b border-line pb-3">
                <div className="text-xs font-extrabold text-accent-2 uppercase tracking-wider flex items-center gap-2">
                  <Flame className="w-4 h-4 text-accent-2" /> YOUR TURN TO ACT (
                  <TurnTimerBadge turnStartedAt={session.turnStartedAt} isActive={true} />)
                </div>
                <div className="text-xs text-text font-mono">
                  Current High Bet: <strong className="text-accent">₹{session.currentHighBet}</strong> | Your Bet: ₹{me.currentBet || 0}
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs font-mono">
                  <span className="text-text-muted">Raise Amount:</span>
                  <span className="text-accent-2 font-black text-sm">₹{betSliderValue}</span>
                </div>
                <input
                  type="range"
                  min={Math.max(session.bigBlind * 2, session.currentHighBet * 2)}
                  max={me.chipStack + (me.currentBet || 0)}
                  step={session.bigBlind}
                  value={betSliderValue}
                  onChange={(e) => setBetSliderValue(Number(e.target.value))}
                  className="w-full accent-accent-2 cursor-pointer"
                />

                <div className="flex flex-wrap gap-2 text-xs font-mono">
                  <button
                    onClick={() => setBetSliderValue(Math.max(session.bigBlind * 2, session.currentHighBet * 2))}
                    className="px-2.5 py-1 bg-bg border border-line rounded-lg text-text hover:border-accent-2"
                  >
                    Min Raise
                  </button>
                  <button
                    onClick={() => setBetSliderValue(Math.min(me.chipStack, Math.round(session.potSize * 0.5)))}
                    className="px-2.5 py-1 bg-bg border border-line rounded-lg text-text hover:border-accent-2"
                  >
                    1/2 Pot
                  </button>
                  <button
                    onClick={() => setBetSliderValue(Math.min(me.chipStack, session.potSize))}
                    className="px-2.5 py-1 bg-bg border border-line rounded-lg text-text hover:border-accent-2"
                  >
                    Pot
                  </button>
                  <button
                    onClick={() => setBetSliderValue(me.chipStack + (me.currentBet || 0))}
                    className="px-2.5 py-1 bg-danger/15 border border-danger/40 text-danger rounded-lg hover:bg-danger/25 font-bold"
                  >
                    All-In (₹{me.chipStack + (me.currentBet || 0)})
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3 pt-1">
                <button
                  onClick={handleFold}
                  className="py-3 bg-danger/15 hover:bg-danger/25 border border-danger/40 text-danger font-black rounded-2xl text-xs uppercase cursor-pointer"
                >
                  Fold
                </button>

                {session.currentHighBet === (me.currentBet || 0) ? (
                  <button
                    onClick={handleCheck}
                    className="py-3 bg-accent/50 hover:bg-accent text-accent-contrast font-black rounded-2xl text-xs uppercase cursor-pointer"
                  >
                    Check
                  </button>
                ) : (
                  <button
                    onClick={handleCall}
                    className="py-3 bg-accent/50 hover:bg-accent text-accent-contrast font-black rounded-2xl text-xs uppercase cursor-pointer"
                  >
                    Call ₹{session.currentHighBet - (me.currentBet || 0)}
                  </button>
                )}

                <button
                  onClick={() => handleBetRaise(betSliderValue)}
                  className="py-3 bg-accent-2 hover:bg-accent-2 text-accent-contrast font-black rounded-2xl text-xs uppercase cursor-pointer shadow-lg"
                >
                  Raise to ₹{betSliderValue}
                </button>
              </div>
            </div>
          )}

          {/* Action Log Drawer */}
          <div className="p-4 bg-bg border border-line rounded-2xl space-y-2 text-xs font-mono">
            <div className="text-text font-bold uppercase tracking-wider flex items-center justify-between border-b border-line pb-2">
              <span className="flex items-center gap-1.5 text-accent-2">
                <Layers className="w-4 h-4" /> Live Action Feed
              </span>
              <span className="text-[10px] text-text-muted">Real-time Game State Engine</span>
            </div>
            <div className="max-h-28 overflow-y-auto space-y-1 text-text-muted">
              {session.actionLog.length === 0 ? (
                <p className="text-[11px] italic">No actions in current hand yet.</p>
              ) : (
                session.actionLog.map((log, i) => <div key={i}>{log}</div>)
              )}
            </div>
          </div>

          {/* Pending Buy-In Requests (host only) */}
          {isHost && pendingBuyIns.length > 0 && (
            <div className="p-4 bg-bg border border-warning/60 rounded-2xl space-y-2 text-xs font-mono">
              <div className="text-warning font-bold uppercase tracking-wider border-b border-line pb-2">
                Pending Buy-In Requests ({pendingBuyIns.length})
              </div>
              {pendingBuyIns.map(req => {
                const seat = sortedSeats.find(s => s.uid === req.userId);
                return (
                  <div key={req.id} className="flex items-center justify-between p-2 bg-surface rounded-xl">
                    <span className="text-text">
                      {seat?.name || req.userId} — ₹{req.amount.toLocaleString()}
                    </span>
                    <div className="flex gap-2">
                      <button onClick={() => handleApproveBuyIn(req)} className="p-1.5 bg-accent/50 hover:bg-accent rounded-lg text-accent-contrast cursor-pointer">
                        <Check className="w-3.5 h-3.5" />
                      </button>
                      <button onClick={() => handleRejectBuyIn(req)} className="p-1.5 bg-danger/20 hover:bg-danger/35 rounded-lg text-danger cursor-pointer">
                        <Ban className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* TAB 2: HAND HISTORY */}
      {activeTab === 'history' && (
        <div className="bg-surface border border-line p-6 rounded-3xl space-y-4 shadow-xl">
          <div className="border-b border-line pb-3">
            <h3 className="text-base font-bold text-text uppercase tracking-wider flex items-center gap-2">
              <History className="w-5 h-5 text-accent-2" /> Hand History Log
            </h3>
            <p className="text-xs text-text-muted">Complete chronological audit trail of all hands played at this virtual table.</p>
          </div>

          {handHistory.length === 0 ? (
            <p className="text-xs text-text-muted text-center py-6">No hands completed yet in this session.</p>
          ) : (
            <div className="space-y-3 font-mono text-xs">
              {handHistory.map(rec => (
                <div key={rec.id} className="p-4 bg-bg border border-line rounded-2xl space-y-2">
                  <div className="flex items-center justify-between border-b border-line/60 pb-2">
                    <span className="font-bold text-text">Hand #{rec.handNumber}</span>
                    <span className="text-[10px] text-text-muted">{rec.timestamp}</span>
                  </div>
                  <div className="text-accent font-bold">
                    Winner(s): {rec.winnerNames.join(', ')} — Won {formatVal(rec.potTotal)}
                  </div>
                  <div className="text-[11px] text-warning">Hand Evaluation: {rec.winningHandDesc}</div>
                  {rec.communityCards.length > 0 && (
                    <div className="flex gap-1 pt-1">
                      <span className="text-[10px] text-text-muted self-center mr-2">Board:</span>
                      {rec.communityCards.map((c, i) => (
                        <div key={i} className="w-6 h-9">
                          <PlayingCard card={c} size="sm" />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* TAB 3: PLAYER STATISTICS & HUD */}
      {activeTab === 'stats' && (
        <div className="bg-surface border border-line p-6 rounded-3xl space-y-4 shadow-xl">
          <div className="border-b border-line pb-3">
            <h3 className="text-base font-bold text-text uppercase tracking-wider flex items-center gap-2">
              <TrendingUp className="w-5 h-5 text-accent-2" /> Player Statistics & HUD
            </h3>
            <p className="text-xs text-text-muted">Real-time analytics including VPIP (Voluntarily Put $ In Pot), PFR (Preflop Raise), and Win Rates.</p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 font-mono text-xs">
            {sortedSeats.map(p => (
              <div key={p.uid} className="p-4 bg-bg border border-line rounded-2xl space-y-3">
                <div className="flex items-center justify-between border-b border-line pb-2">
                  <span className="font-bold text-text">{p.name}</span>
                  <span className="text-accent-2">Stack: {formatVal(p.chipStack)}</span>
                </div>

                <div className="grid grid-cols-3 gap-2 text-center text-[11px]">
                  <div className="p-2 bg-surface rounded-xl">
                    <div className="text-[9px] text-text-muted">VPIP</div>
                    <div className="font-bold text-accent">{p.statVPIP || 25}%</div>
                  </div>
                  <div className="p-2 bg-surface rounded-xl">
                    <div className="text-[9px] text-text-muted">PFR</div>
                    <div className="font-bold text-warning">{p.statPFR || 15}%</div>
                  </div>
                  <div className="p-2 bg-surface rounded-xl">
                    <div className="text-[9px] text-text-muted">HANDS</div>
                    <div className="font-bold text-text">{p.statHandsPlayed || 10}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* TAB 4: SPECTATOR */}
      {activeTab === 'spectate' && (
        <div className="bg-surface border border-line p-6 rounded-3xl space-y-4 shadow-xl">
          <div className="border-b border-line pb-3">
            <h3 className="text-base font-bold text-text uppercase tracking-wider flex items-center gap-2">
              <Eye className="w-5 h-5 text-accent-2" /> Spectator Mode
            </h3>
            <p className="text-xs text-text-muted">Observe the live table in real-time. Hole cards remain hidden from spectators to protect game integrity.</p>
          </div>

          <div className="p-4 bg-bg border border-line rounded-2xl space-y-2 text-xs">
            <div className="text-text font-bold">Table Host:</div>
            <p className="text-text-muted">{session.hostName}</p>
          </div>
        </div>
      )}

      {/* TAB 5: TABLE CONFIG & RULES (HOST ONLY) */}
      {activeTab === 'settings' && isHost && (
        <div className="bg-surface border border-line p-6 rounded-3xl space-y-6 shadow-xl">
          <div className="border-b border-line pb-3">
            <h3 className="text-base font-bold text-accent-2 uppercase tracking-wider flex items-center gap-2">
              <Settings className="w-5 h-5" /> Table Configuration & Rules
            </h3>
            <p className="text-xs text-text-muted">Host settings for blind structures and allowed skips. Changes apply on save for every connected player.</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
            <div className="space-y-1">
              <label className="text-text font-bold">Table Name:</label>
              <input
                type="text"
                value={editTableName}
                onChange={e => setEditTableName(e.target.value)}
                className="w-full bg-bg border border-line rounded-xl px-3 py-2 text-text font-bold focus:border-accent-2 outline-none"
              />
            </div>

            <div className="space-y-1">
              <label className="text-text font-bold">Small Blind (Chips):</label>
              <input
                type="number"
                value={editSmallBlind}
                onChange={e => setEditSmallBlind(Number(e.target.value))}
                className="w-full bg-bg border border-line rounded-xl px-3 py-2 text-text font-bold focus:border-accent-2 outline-none"
              />
            </div>

            <div className="space-y-1">
              <label className="text-text font-bold">Big Blind (Chips):</label>
              <input
                type="number"
                value={editBigBlind}
                onChange={e => setEditBigBlind(Number(e.target.value))}
                className="w-full bg-bg border border-line rounded-xl px-3 py-2 text-text font-bold focus:border-accent-2 outline-none"
              />
            </div>

            <div className="space-y-1">
              <label className="text-text font-bold">Allowed Blind Skips:</label>
              <select
                value={editSkipBlinds}
                onChange={e => setEditSkipBlinds(Number(e.target.value))}
                className="w-full bg-bg border border-line rounded-xl px-3 py-2 text-text font-bold focus:border-accent-2 outline-none"
              >
                <option value={0}>0 (Strict - No Skips)</option>
                <option value={1}>1 Missed Blind Allowed</option>
                <option value={2}>2 Missed Blinds Allowed (Default)</option>
              </select>
            </div>
          </div>

          <div className="flex items-center justify-between pt-4 border-t border-line">
            <button
              onClick={handleSaveTableSettings}
              className="px-4 py-2 bg-accent-2 hover:bg-accent-2 text-accent-contrast font-black rounded-xl text-xs uppercase cursor-pointer shadow"
            >
              Save Table Settings
            </button>
            <button
              onClick={handleEndVirtualTableSession}
              className="px-4 py-2 bg-danger/15 border border-danger/40 text-danger font-bold rounded-xl text-xs uppercase cursor-pointer hover:bg-danger/25 shadow"
            >
              End Table Session
            </button>
          </div>
        </div>
      )}

      {/* MODAL: REQUEST BUY-IN */}
      {showBuyInModal && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-surface border border-line w-full max-w-md p-6 rounded-3xl shadow-2xl space-y-5">
            <div className="flex items-center justify-between border-b border-line pb-3">
              <h3 className="text-base font-bold text-text uppercase tracking-wider">Buy In</h3>
              <button onClick={() => setShowBuyInModal(false)} className="text-text-muted hover:text-text cursor-pointer">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleRequestBuyIn} className="space-y-4">
              <div className="space-y-1">
                <label className="text-[11px] font-bold text-text-muted uppercase">Buy-in Amount (Chips)</label>
                <input
                  type="number"
                  value={buyInAmount}
                  onChange={e => setBuyInAmount(Number(e.target.value))}
                  min={session.minBuyIn}
                  className="w-full bg-bg border border-line rounded-xl px-3.5 py-2.5 text-text font-bold focus:border-accent-2 outline-none"
                  required
                />
              </div>
              <button
                type="submit"
                className="w-full py-3 bg-accent-2 hover:bg-accent-2 text-accent-contrast font-black rounded-2xl text-xs uppercase tracking-widest cursor-pointer shadow-xl"
              >
                Submit Request
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
