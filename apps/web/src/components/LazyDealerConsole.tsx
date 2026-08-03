import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { 
  Crown, 
  Users, 
  ShieldCheck, 
  Plus, 
  Check, 
  X, 
  Play, 
  ArrowLeft, 
  AlertCircle, 
  Coins, 
  Gamepad2, 
  Lock, 
  Eye, 
  EyeOff, 
  Tv, 
  RotateCcw, 
  ChevronRight, 
  Sparkles, 
  ShieldAlert, 
  MessageCircle,
  GripVertical,
  Sliders,
  CheckCircle2,
  Volume2,
  VolumeX
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Club, 
  PokerSession, 
  BuyInRequest, 
  LazyPlayerSeat, 
  Card, 
  Suit 
} from '../types';
import { PlayingCard } from './PlayingCard';
import { soundFx } from '../utils/audio';
import {
  db,
  doc,
  onSnapshot,
  updateDoc,
  addDoc,
  collection,
  query,
  where,
  handleFirestoreError,
  OperationType
} from '../lib/firebase';
import { AppUser as User } from '../lib/auth-types';

interface LazyDealerConsoleProps {
  club: Club;
  session: PokerSession;
  currentUser: User;
  playerAvatarUrl: string;
  onBackToClub: () => void;
  onSettleSession?: (session: PokerSession) => void;
}

const SUITS: Suit[] = [
  { symbol: '♠', name: 'spades', color: 'text-zinc-900', isRed: false },
  { symbol: '♥', name: 'hearts', color: 'text-rose-700', isRed: true },
  { symbol: '♦', name: 'diamonds', color: 'text-rose-700', isRed: true },
  { symbol: '♣', name: 'clubs', color: 'text-zinc-900', isRed: false }
];

const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

const createCryptographicDeck = (): Card[] => {
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({
        id: `${rank}-${suit.symbol}-${Math.random().toString(36).substring(2, 7)}`,
        rank,
        suit: suit.symbol,
        color: suit.color,
        isRed: suit.isRed,
        suitName: suit.name
      });
    }
  }

  const array = new Uint32Array(deck.length);
  window.crypto.getRandomValues(array);
  
  for (let i = deck.length - 1; i > 0; i--) {
    const j = array[i] % (i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }

  return deck;
};

export const LazyDealerConsole: React.FC<LazyDealerConsoleProps> = ({
  club,
  session: initialSession,
  currentUser,
  playerAvatarUrl,
  onBackToClub,
  onSettleSession
}) => {
  // Real-time Poker Session state synced via Firestore
  const [session, setSession] = useState<PokerSession>(initialSession);
  const [buyInRequests, setBuyInRequests] = useState<BuyInRequest[]>([]);
  const [activeTab, setActiveTab] = useState<'dealerConsole' | 'playerView' | 'adminView'>('dealerConsole');
  
  // Large Table / TV Display Mode Toggle
  const [showTvMode, setShowTvMode] = useState(false);

  // Player Privacy Peek Mode (Hold vs Toggle)
  const [isPeeking, setIsPeeking] = useState(false);
  const [peekMode, setPeekMode] = useState<'hold' | 'toggle'>('hold');

  // Buy-in Request Modal
  const [showBuyInModal, setShowBuyInModal] = useState(false);
  const [buyInAmount, setBuyInAmount] = useState<number>(session.minBuyIn || club.minBuyIn || 1000);
  const [submittingBuyIn, setSubmittingBuyIn] = useState(false);

  // Admin Change Dealer Modal
  const [showChangeDealerModal, setShowChangeDealerModal] = useState(false);
  const [selectedNewDealerUid, setSelectedNewDealerUid] = useState<string>('');

  // Toast / Status banner
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3500);
  };

  // User Role Checks
  const isSuperUser = 
    currentUser.email?.toLowerCase().trim() === 'aniket.maru77@gmail.com';

  const isAdmin = 
    club.ownerUid === currentUser.uid ||
    club.createdBy === currentUser.uid ||
    club.adminUids?.includes(currentUser.uid) ||
    isSuperUser;

  const isAssignedDealer = session.assignedDealerUid === currentUser.uid;

  const seatedPlayer = session.playerSeats?.find(s => s.uid === currentUser.uid);
  const isSeatedPlayer = Boolean(seatedPlayer);

  // Set default tab based on role
  useEffect(() => {
    if (isAssignedDealer) {
      setActiveTab('dealerConsole');
    } else if (isSeatedPlayer) {
      setActiveTab('playerView');
    } else if (isAdmin) {
      setActiveTab('adminView');
    } else {
      setActiveTab('playerView');
    }
  }, [isAssignedDealer, isSeatedPlayer, isAdmin]);

  // Firestore Real-Time Listeners
  useEffect(() => {
    // 1. Session snapshot
    const sessionRef = doc(db, 'sessions', session.id);
    const unsubSession = onSnapshot(sessionRef, (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data() as PokerSession;
        setSession(prev => ({ ...prev, ...data, id: docSnap.id }));
      }
    }, (err) => handleFirestoreError(err, OperationType.GET, `sessions/${session.id}`));

    // 2. Buy-in requests query
    const buyInsQuery = query(
      collection(db, 'buyInRequests'),
      where('sessionId', '==', session.id)
    );
    const unsubBuyIns = onSnapshot(buyInsQuery, (snapshot) => {
      const reqs: BuyInRequest[] = [];
      snapshot.forEach(doc => {
        reqs.push({ id: doc.id, ...doc.data() } as BuyInRequest);
      });
      setBuyInRequests(reqs.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()));
    }, (err) => handleFirestoreError(err, OperationType.GET, 'buyInRequests'));

    return () => {
      unsubSession();
      unsubBuyIns();
    };
  }, [session.id]);

  // Currency valuation display helper
  const formatVal = (pts: number) => {
    const isDevalued = club?.enableDevaluation ?? true;
    const factor = isDevalued ? (club?.devaluationFactor ?? 5) : 1;
    const cash = factor > 0 ? pts / factor : pts;
    return `₹${Math.round(cash).toLocaleString()} (${Math.round(pts).toLocaleString()} Chips)`;
  };

  // ==========================================
  // GAMEPLAY ENGINE (DEALER PERMISSIONS ONLY)
  // ==========================================

  // 1. Join / Sit at Table
  const handleJoinTableSeat = async (seatNumber: number) => {
    try {
      const currentSeats = [...(session.playerSeats || [])];
      const existingSeat = currentSeats.find(s => s.seatNumber === seatNumber);

      if (existingSeat && existingSeat.uid) {
        showToast('⚠️ Seat already occupied.');
        return;
      }

      const userDisplayName = currentUser.displayName || (currentUser.email ? currentUser.email.split('@')[0] : 'Player');

      const newSeatObj: LazyPlayerSeat = {
        seatNumber,
        uid: currentUser.uid,
        name: userDisplayName,
        avatarUrl: playerAvatarUrl,
        chipStack: club.minBuyIn || 1000,
        activeBank: club.minBuyIn || 1000,
        isFolded: false,
        isSatOut: false,
        skippedBlindsCount: 0,
        holeCards: [],
        status: 'Waiting'
      };

      const updatedSeats = currentSeats.filter(s => s.seatNumber !== seatNumber);
      updatedSeats.push(newSeatObj);
      updatedSeats.sort((a, b) => a.seatNumber - b.seatNumber);

      const activeUids = Array.from(new Set([...session.activePlayerUids, currentUser.uid]));

      const sessionRef = doc(db, 'sessions', session.id);
      await updateDoc(sessionRef, {
        playerSeats: updatedSeats,
        activePlayerUids: activeUids
      });

      showToast(`✅ Seated at Seat #${seatNumber}!`);
      soundFx.playChipStackSound();
    } catch (err) {
      console.error('Failed to join seat:', err);
      showToast('❌ Failed to sit at table.');
    }
  };

  // 2. Start Game (Dealer Only)
  const handleStartGame = async () => {
    if (!isAssignedDealer && !isAdmin) {
      showToast('⚠️ Only the assigned Dealer or Admin can start the game.');
      return;
    }

    const currentSeats = session.playerSeats || [];
    const activeSeats = currentSeats.filter(s => s.uid && !s.isSatOut);

    if (activeSeats.length < 2) {
      showToast('⚠️ Minimum 2 players required to start game.');
      return;
    }

    try {
      const freshDeck = createCryptographicDeck();
      let deckIdx = 0;

      // Assign Small Blind (Seat 1/2), Big Blind, Dealer Button
      const dealerSeatNum = activeSeats[0].seatNumber;

      const updatedSeats = currentSeats.map(seat => {
        if (!seat.uid || seat.isSatOut) return seat;

        // Check Skip Blind Rule Limit (default 2)
        const limit = session.skipBlindLimit || 2;
        if (seat.skippedBlindsCount > limit) {
          return {
            ...seat,
            status: 'Blocked' as const,
            holeCards: [],
            isFolded: true
          };
        }

        const card1 = freshDeck[deckIdx++];
        const card2 = freshDeck[deckIdx++];

        return {
          ...seat,
          holeCards: [card1, card2],
          isFolded: false,
          status: 'Acting' as const
        };
      });

      const remainingDeck = freshDeck.slice(deckIdx);

      const sessionRef = doc(db, 'sessions', session.id);
      await updateDoc(sessionRef, {
        isGameStarted: true,
        handNumber: (session.handNumber || 0) + 1,
        street: 'Preflop',
        dealerSeat: dealerSeatNum,
        communityCards: [],
        burnCards: [],
        deck: remainingDeck,
        potSize: (session.smallBlind || 25) + (session.bigBlind || 50),
        playerSeats: updatedSeats
      });

      soundFx.playShuffleAndDealSeries(6);
      showToast(`🚀 Game Started! Hand #${(session.handNumber || 0) + 1} dealt.`);
    } catch (err) {
      console.error('Failed to start game:', err);
      showToast('❌ Failed to start game.');
    }
  };

  // 3. Deal Next Hand (Dealer Only)
  const handleNextHand = async () => {
    if (!isAssignedDealer && !isAdmin) {
      showToast('⚠️ Only the assigned Dealer can deal the next hand.');
      return;
    }

    try {
      const currentSeats = session.playerSeats || [];
      const activeSeats = currentSeats.filter(s => s.uid && !s.isSatOut);

      if (activeSeats.length < 2) {
        showToast('⚠️ Need at least 2 active players for next hand.');
        return;
      }

      // Rotate Dealer Seat to next occupied seat
      const currDealer = session.dealerSeat || activeSeats[0].seatNumber;
      const sortedSeats = [...activeSeats].sort((a, b) => a.seatNumber - b.seatNumber);
      const currIdx = sortedSeats.findIndex(s => s.seatNumber === currDealer);
      const nextIdx = (currIdx + 1) % sortedSeats.length;
      const nextDealerSeat = sortedSeats[nextIdx].seatNumber;

      const freshDeck = createCryptographicDeck();
      let deckIdx = 0;

      const updatedSeats = currentSeats.map(seat => {
        if (!seat.uid || seat.isSatOut) return seat;

        const limit = session.skipBlindLimit || 2;
        if (seat.skippedBlindsCount > limit) {
          return {
            ...seat,
            status: 'Blocked' as const,
            holeCards: [],
            isFolded: true
          };
        }

        const card1 = freshDeck[deckIdx++];
        const card2 = freshDeck[deckIdx++];

        return {
          ...seat,
          holeCards: [card1, card2],
          isFolded: false,
          status: 'Acting' as const
        };
      });

      const remainingDeck = freshDeck.slice(deckIdx);

      const sessionRef = doc(db, 'sessions', session.id);
      await updateDoc(sessionRef, {
        handNumber: (session.handNumber || 1) + 1,
        street: 'Preflop',
        dealerSeat: nextDealerSeat,
        communityCards: [],
        burnCards: [],
        deck: remainingDeck,
        potSize: (session.smallBlind || 25) + (session.bigBlind || 50),
        playerSeats: updatedSeats
      });

      soundFx.playShuffleAndDealSeries(6);
      showToast(`🃏 Hand #${(session.handNumber || 1) + 1} Dealt! Dealer button moved.`);
    } catch (err) {
      console.error('Failed to deal next hand:', err);
      showToast('❌ Failed to deal next hand.');
    }
  };

  // 4. Reveal Flop (Dealer Only)
  const handleRevealFlop = async () => {
    if (!isAssignedDealer && !isAdmin) return;
    if (session.street !== 'Preflop') return;

    const currentDeck = [...(session.deck || [])];
    if (currentDeck.length < 4) return;

    const burn1 = currentDeck.shift();
    const flop1 = currentDeck.shift();
    const flop2 = currentDeck.shift();
    const flop3 = currentDeck.shift();

    if (!flop1 || !flop2 || !flop3) return;

    const newCommunity = [flop1, flop2, flop3];
    const newBurns = [...(session.burnCards || []), burn1!].filter(Boolean);

    try {
      const sessionRef = doc(db, 'sessions', session.id);
      await updateDoc(sessionRef, {
        street: 'Flop',
        communityCards: newCommunity,
        burnCards: newBurns,
        deck: currentDeck
      });

      soundFx.playShuffleAndDealSeries(3);
      showToast('🎴 Flop Revealed!');
    } catch (err) {
      console.error('Failed to reveal flop:', err);
    }
  };

  // 5. Reveal Turn (Dealer Only)
  const handleRevealTurn = async () => {
    if (!isAssignedDealer && !isAdmin) return;
    if (session.street !== 'Flop') return;

    const currentDeck = [...(session.deck || [])];
    if (currentDeck.length < 2) return;

    const burn = currentDeck.shift();
    const turnCard = currentDeck.shift();

    if (!turnCard) return;

    const newCommunity = [...(session.communityCards || []), turnCard];
    const newBurns = [...(session.burnCards || []), burn!].filter(Boolean);

    try {
      const sessionRef = doc(db, 'sessions', session.id);
      await updateDoc(sessionRef, {
        street: 'Turn',
        communityCards: newCommunity,
        burnCards: newBurns,
        deck: currentDeck
      });

      soundFx.playCardDealSound();
      showToast('🃏 Turn Revealed!');
    } catch (err) {
      console.error('Failed to reveal turn:', err);
    }
  };

  // 6. Reveal River (Dealer Only)
  const handleRevealRiver = async () => {
    if (!isAssignedDealer && !isAdmin) return;
    if (session.street !== 'Turn') return;

    const currentDeck = [...(session.deck || [])];
    if (currentDeck.length < 2) return;

    const burn = currentDeck.shift();
    const riverCard = currentDeck.shift();

    if (!riverCard) return;

    const newCommunity = [...(session.communityCards || []), riverCard];
    const newBurns = [...(session.burnCards || []), burn!].filter(Boolean);

    try {
      const sessionRef = doc(db, 'sessions', session.id);
      await updateDoc(sessionRef, {
        street: 'River',
        communityCards: newCommunity,
        burnCards: newBurns,
        deck: currentDeck
      });

      soundFx.playCardDealSound();
      showToast('🌊 River Revealed!');
    } catch (err) {
      console.error('Failed to reveal river:', err);
    }
  };

  // 7. Showdown (Dealer Only)
  const handleRevealShowdown = async () => {
    if (!isAssignedDealer && !isAdmin) return;

    try {
      const sessionRef = doc(db, 'sessions', session.id);
      await updateDoc(sessionRef, {
        street: 'Showdown'
      });

      soundFx.playCardFlipSound();
      showToast('🏆 Showdown Stage - Players Reveal Hands!');
    } catch (err) {
      console.error('Failed to trigger showdown:', err);
    }
  };

  // 8. Dealer Keyboard Hotkeys Listener
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Only process hotkeys if assigned dealer and not typing in input
      if (!isAssignedDealer) return;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement)?.tagName)) return;

      const key = e.key.toLowerCase();

      if (key === ' ') {
        e.preventDefault();
        if (session.street === 'Preflop') handleRevealFlop();
        else if (session.street === 'Flop') handleRevealTurn();
        else if (session.street === 'Turn') handleRevealRiver();
        else if (session.street === 'River') handleRevealShowdown();
        else if (session.street === 'Showdown' || session.street === 'HandFinished') handleNextHand();
      } else if (key === 'f') {
        handleRevealFlop();
      } else if (key === 't') {
        handleRevealTurn();
      } else if (key === 'r') {
        handleRevealRiver();
      } else if (key === 's') {
        handleRevealShowdown();
      } else if (key === 'n') {
        handleNextHand();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isAssignedDealer, session.street, handleRevealFlop, handleRevealTurn, handleRevealRiver, handleRevealShowdown, handleNextHand]);

  // ==========================================
  // BUY-IN REQUEST SUBMISSION & APPROVAL
  // ==========================================
  const handleRequestBuyIn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (buyInAmount < (club.minBuyIn || 1000)) {
      showToast(`⚠️ Minimum buy-in is ${formatVal(club.minBuyIn || 1000)}`);
      return;
    }

    setSubmittingBuyIn(true);
    try {
      const userDisplayName = currentUser.displayName || (currentUser.email ? currentUser.email.split('@')[0] : 'Player');

      await addDoc(collection(db, 'buyInRequests'), {
        sessionId: session.id,
        clubId: club.id,
        userId: currentUser.uid,
        userDisplayName,
        amount: buyInAmount,
        status: 'pending',
        requestedBy: currentUser.uid,
        createdAt: new Date().toISOString()
      });

      soundFx.playChipStackSound();
      showToast('💰 Buy-in request submitted to Club Admin!');
      setShowBuyInModal(false);
    } catch (err) {
      console.error('Failed to submit buyin request:', err);
      showToast('❌ Failed to send request.');
    } finally {
      setSubmittingBuyIn(false);
    }
  };

  const handleApproveBuyIn = async (req: BuyInRequest) => {
    if (!isAdmin) {
      showToast('⚠️ Only Club Admins can approve buy-in requests.');
      return;
    }

    try {
      // 1. Mark request approved
      const reqRef = doc(db, 'buyInRequests', req.id);
      await updateDoc(reqRef, {
        status: 'approved',
        approvedBy: currentUser.uid
      });

      // 2. Update player's active bank and stack in session
      const currentSeats = [...(session.playerSeats || [])];
      const targetSeat = currentSeats.find(s => s.uid === req.userId);

      if (targetSeat) {
        targetSeat.activeBank += req.amount;
        targetSeat.chipStack += req.amount;
        // If player was blocked due to missed blinds, unblock them
        if (targetSeat.status === 'Blocked') {
          targetSeat.status = 'Waiting';
          targetSeat.skippedBlindsCount = 0;
        }
      } else {
        // Find next empty seat
        const occupiedNumbers = currentSeats.map(s => s.seatNumber);
        let freeSeatNum = 1;
        while (occupiedNumbers.includes(freeSeatNum) && freeSeatNum <= (session.maxPlayers || 9)) {
          freeSeatNum++;
        }

        currentSeats.push({
          seatNumber: freeSeatNum,
          uid: req.userId,
          name: req.userDisplayName,
          chipStack: req.amount,
          activeBank: req.amount,
          isFolded: false,
          isSatOut: false,
          skippedBlindsCount: 0,
          holeCards: [],
          status: 'Waiting'
        });
      }

      const activeUids = Array.from(new Set([...session.activePlayerUids, req.userId]));

      const sessionRef = doc(db, 'sessions', session.id);
      await updateDoc(sessionRef, {
        playerSeats: currentSeats,
        activePlayerUids: activeUids
      });

      soundFx.playChipStackSound();
      showToast(`✅ Approved ${formatVal(req.amount)} for ${req.userDisplayName}! Stack updated.`);
    } catch (err) {
      console.error('Failed to approve buy-in:', err);
      showToast('❌ Failed to approve request.');
    }
  };

  const handleRejectBuyIn = async (req: BuyInRequest) => {
    if (!isAdmin) return;
    try {
      const reqRef = doc(db, 'buyInRequests', req.id);
      await updateDoc(reqRef, {
        status: 'rejected',
        approvedBy: currentUser.uid
      });
      showToast(`Rejected buy-in request for ${req.userDisplayName}`);
    } catch (err) {
      console.error('Failed to reject buyin:', err);
    }
  };

  // ==========================================
  // ADMIN RE-ASSIGN DEALER
  // ==========================================
  const handleChangeDealer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isAdmin) return;
    if (!selectedNewDealerUid) {
      showToast('Please select a player to be Dealer.');
      return;
    }

    const targetSeat = session.playerSeats?.find(s => s.uid === selectedNewDealerUid);
    const targetName = targetSeat?.name || 'Assigned Dealer';

    try {
      const sessionRef = doc(db, 'sessions', session.id);
      await updateDoc(sessionRef, {
        assignedDealerUid: selectedNewDealerUid,
        assignedDealerName: targetName
      });

      showToast(`👑 Assigned ${targetName} as the active Dealer!`);
      setShowChangeDealerModal(false);
    } catch (err) {
      console.error('Failed to change dealer:', err);
      showToast('❌ Failed to update dealer.');
    }
  };

  return (
    <div id="lazy-dealer-root" className="min-h-screen bg-bg text-text flex flex-col font-sans select-none relative overflow-hidden">
      
      {/* REAL-TIME TOAST BANNER */}
      <AnimatePresence>
        {toastMessage && (
          <motion.div 
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="fixed top-4 left-1/2 -translate-x-1/2 z-50 bg-accent-2 text-accent-contrast font-black px-6 py-3 rounded-2xl shadow-2xl text-xs uppercase tracking-wider flex items-center gap-2 border border-warning"
          >
            <Sparkles className="w-4 h-4 text-accent-contrast" /> {toastMessage}
          </motion.div>
        )}
      </AnimatePresence>

      {/* TOP APPLICATION HEADER */}
      <header className="bg-bg border-b border-line px-4 py-3 flex flex-wrap items-center justify-between gap-3 shadow-xl">
        <div className="flex items-center gap-3">
          <button
            onClick={onBackToClub}
            className="p-2 bg-surface hover:bg-surface-alt border border-line rounded-xl text-text hover:text-text cursor-pointer transition-colors"
            title="Back to Club Dashboard"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>

          <div>
            <div className="flex items-center gap-2">
              <span className="font-extrabold text-text text-sm">{club.name}</span>
              <span className="px-2 py-0.5 bg-warning/20 text-warning border border-warning/40 font-bold text-[9px] uppercase rounded-full flex items-center gap-1">
                <Gamepad2 className="w-3 h-3" /> Dealer Assist
              </span>
            </div>
            <p className="text-[11px] text-text-muted font-mono">
              Session: <strong className="text-text">{session.sessionName}</strong> | Dealer: <strong className="text-warning">{session.assignedDealerName || 'Unassigned'}</strong>
            </p>
          </div>
        </div>

        {/* ROLE TABS & TV MODE BUTTON */}
        <div className="flex items-center gap-2">
          {isAssignedDealer && (
            <button
              onClick={() => setActiveTab('dealerConsole')}
              className={`px-3.5 py-1.5 rounded-xl text-xs font-bold uppercase tracking-wider transition-all cursor-pointer flex items-center gap-1.5 ${
                activeTab === 'dealerConsole'
                  ? 'bg-accent-2 text-accent-contrast font-black shadow'
                  : 'bg-surface border border-line text-text-muted hover:text-text'
              }`}
            >
              <Crown className="w-3.5 h-3.5" /> Dealer Console
            </button>
          )}

          {isSeatedPlayer && (
            <button
              onClick={() => setActiveTab('playerView')}
              className={`px-3.5 py-1.5 rounded-xl text-xs font-bold uppercase tracking-wider transition-all cursor-pointer flex items-center gap-1.5 ${
                activeTab === 'playerView'
                  ? 'bg-accent-2 text-accent-contrast font-black shadow'
                  : 'bg-surface border border-line text-text-muted hover:text-text'
              }`}
            >
              <Eye className="w-3.5 h-3.5" /> My Hole Cards
            </button>
          )}

          {isAdmin && (
            <button
              onClick={() => setActiveTab('adminView')}
              className={`px-3.5 py-1.5 rounded-xl text-xs font-bold uppercase tracking-wider transition-all cursor-pointer flex items-center gap-1.5 ${
                activeTab === 'adminView'
                  ? 'bg-accent-2 text-accent-contrast font-black shadow'
                  : 'bg-surface border border-line text-text-muted hover:text-text'
              }`}
            >
              <ShieldCheck className="w-3.5 h-3.5" /> Admin Dashboard
              {buyInRequests.filter(r => r.status === 'pending').length > 0 && (
                <span className="bg-warning text-accent-contrast text-[9px] font-black px-1.5 py-0.2 rounded-full">
                  {buyInRequests.filter(r => r.status === 'pending').length}
                </span>
              )}
            </button>
          )}

          {/* Full-screen TV Table Mode Button */}
          <button
            onClick={() => setShowTvMode(true)}
            className="px-3.5 py-1.5 bg-surface-alt hover:bg-line-strong border border-line-strong text-accent font-bold text-xs uppercase rounded-xl flex items-center gap-1.5 cursor-pointer shadow"
            title="Launch Fullscreen TV Table Screen"
          >
            <Tv className="w-3.5 h-3.5" /> TV Table Mode
          </button>
        </div>
      </header>

      {/* MAIN CONTENT CANVAS */}
      <main className="flex-1 p-4 max-w-7xl w-full mx-auto space-y-6 overflow-y-auto">
        
        {/* ========================================================= */}
        {/* TAB 1: DEALER CONSOLE (OVERHEAD TABLE MANAGER VIEW)       */}
        {/* ========================================================= */}
        {activeTab === 'dealerConsole' && isAssignedDealer && (
          <div className="space-y-6">
            
            {/* DEALER CONTROL TOOLBAR */}
            <div className="bg-surface border border-line p-5 rounded-3xl flex flex-wrap items-center justify-between gap-4 shadow-2xl">
              <div>
                <span className="px-2.5 py-0.5 bg-warning/20 border border-warning/40 text-warning font-bold text-[10px] uppercase rounded-full">
                  👑 Active Dealer Console
                </span>
                <h2 className="text-lg font-black text-text uppercase mt-1">
                  Hand #{session.handNumber || 1} — Stage: <span className="text-accent-2">{session.street || 'Preflop'}</span>
                </h2>
              </div>

              {/* Hand Flow Progress Action Buttons */}
              <div className="flex flex-wrap items-center gap-2">
                {!session.isGameStarted ? (
                  <button
                    onClick={handleStartGame}
                    className="bg-accent-2 hover:bg-accent-2 text-accent-contrast font-black px-5 py-2.5 rounded-xl text-xs uppercase tracking-widest cursor-pointer shadow-lg flex items-center gap-1.5"
                  >
                    <Play className="w-4 h-4 fill-zinc-950" /> Start Game & Deal Hand #1
                  </button>
                ) : (
                  <>
                    {session.street === 'Preflop' && (
                      <button
                        onClick={handleRevealFlop}
                        className="bg-accent-2 hover:bg-accent-2 text-accent-contrast font-black px-4 py-2 rounded-xl text-xs uppercase tracking-wider cursor-pointer shadow"
                      >
                        Reveal Flop [F]
                      </button>
                    )}

                    {session.street === 'Flop' && (
                      <button
                        onClick={handleRevealTurn}
                        className="bg-accent-2 hover:bg-accent-2 text-accent-contrast font-black px-4 py-2 rounded-xl text-xs uppercase tracking-wider cursor-pointer shadow"
                      >
                        Reveal Turn [T]
                      </button>
                    )}

                    {session.street === 'Turn' && (
                      <button
                        onClick={handleRevealRiver}
                        className="bg-accent-2 hover:bg-accent-2 text-accent-contrast font-black px-4 py-2 rounded-xl text-xs uppercase tracking-wider cursor-pointer shadow"
                      >
                        Reveal River [R]
                      </button>
                    )}

                    {(session.street === 'River' || session.street === 'Flop' || session.street === 'Turn') && (
                      <button
                        onClick={handleRevealShowdown}
                        className="bg-accent hover:bg-accent text-accent-contrast font-black px-4 py-2 rounded-xl text-xs uppercase tracking-wider cursor-pointer shadow"
                      >
                        Showdown [S]
                      </button>
                    )}

                    <button
                      onClick={handleNextHand}
                      className="bg-surface-alt hover:bg-line-strong border border-line-strong text-text font-bold px-4 py-2 rounded-xl text-xs uppercase cursor-pointer flex items-center gap-1.5"
                    >
                      <RotateCcw className="w-3.5 h-3.5 text-warning" /> Next Hand [N]
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* OVERHEAD POKER TABLE CANVAS */}
            <div className="bg-bg border-2 border-line p-8 rounded-[40px] relative min-h-[460px] flex flex-col items-center justify-center shadow-2xl overflow-hidden">
              
              {/* Felt Texture & Ring */}
              <div className="absolute inset-4 border-2 border-line/50 rounded-[32px] pointer-events-none"></div>

              {/* CENTER COMMUNITY BOARD & POT INFO */}
              <div className="bg-surface/90 border border-line p-6 rounded-3xl space-y-4 text-center z-10 max-w-xl w-full shadow-2xl backdrop-blur-sm">
                <div className="flex items-center justify-between border-b border-line/60 pb-2 text-xs text-text-muted font-mono">
                  <span>BLINDS: <strong className="text-text">₹{session.smallBlind || 25}/₹{session.bigBlind || 50}</strong></span>
                  <span className="font-bold text-accent-2 uppercase">STAGE: {session.street || 'Preflop'}</span>
                  <span>POT: <strong className="text-accent text-sm">{formatVal(session.potSize || 0)}</strong></span>
                </div>

                {/* 5 COMMUNITY CARDS SLOTS */}
                <div className="flex items-center justify-center gap-2 py-2">
                  {[0, 1, 2, 3, 4].map(idx => {
                    const card = session.communityCards?.[idx];

                    return (
                      <div key={idx} className="w-14 h-20 bg-bg border border-line rounded-xl flex items-center justify-center relative">
                        {card ? (
                          <PlayingCard card={card} size="md" variant="community" />
                        ) : (
                          <span className="text-[10px] text-line font-mono font-bold uppercase">
                            {idx < 3 ? 'FLOP' : idx === 3 ? 'TURN' : 'RIVER'}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* BURN CARDS COUNTER */}
                <div className="text-[10px] text-text-muted font-mono flex items-center justify-center gap-3">
                  <span>Burn Cards: <strong className="text-warning">{session.burnCards?.length || 0}</strong></span>
                  <span>Deck Remaining: <strong className="text-text">{session.deck?.length || 52}</strong></span>
                </div>
              </div>

              {/* SEATED PLAYERS OVERHEAD POSITIONS (CIRCULAR GRID) */}
              <div className="w-full mt-8 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3 z-10">
                {Array.from({ length: session.maxPlayers || 9 }).map((_, i) => {
                  const seatNumber = i + 1;
                  const seatObj = session.playerSeats?.find(s => s.seatNumber === seatNumber);
                  const isDealerButton = session.dealerSeat === seatNumber;

                  return (
                    <div 
                      key={seatNumber} 
                      className={`p-3 rounded-2xl border transition-all flex flex-col justify-between h-32 relative ${
                        seatObj?.uid
                          ? seatObj.isFolded || seatObj.status === 'Blocked'
                            ? 'bg-bg/80 border-line/40 grayscale opacity-60'
                            : 'bg-surface border-line hover:border-line-strong shadow-lg'
                          : 'bg-bg/40 border-dashed border-line/60 flex items-center justify-center'
                      }`}
                    >
                      {seatObj?.uid ? (
                        <>
                          <div className="flex items-center justify-between text-xs">
                            <span className="font-bold text-text truncate max-w-[100px]">{seatObj.name}</span>
                            
                            {isDealerButton && (
                              <span className="w-5 h-5 rounded-full bg-warning text-accent-contrast font-black text-[10px] flex items-center justify-center shadow" title="Dealer Button">
                                D
                              </span>
                            )}
                          </div>

                          <div className="text-xs font-mono text-accent font-bold">
                            {formatVal(seatObj.chipStack)}
                          </div>

                          {/* Hole Cards Status */}
                          <div className="flex items-center gap-1 my-1">
                            {session.street === 'Showdown' && seatObj.holeCards && seatObj.holeCards.length === 2 ? (
                              <div className="flex items-center gap-1">
                                <PlayingCard card={seatObj.holeCards[0]} size="sm" variant="player" />
                                <PlayingCard card={seatObj.holeCards[1]} size="sm" variant="player" />
                              </div>
                            ) : (
                              <div className="flex items-center gap-1">
                                <PlayingCard hidden size="sm" />
                                <PlayingCard hidden size="sm" />
                              </div>
                            )}
                          </div>

                          {/* Status Badge */}
                          <div className="text-[9px] uppercase font-bold tracking-wider">
                            {seatObj.status === 'Blocked' ? (
                              <span className="text-danger bg-danger/80 px-1.5 py-0.5 rounded border border-danger/40">Blocked (Missed Blinds)</span>
                            ) : seatObj.isFolded ? (
                              <span className="text-text-muted">Folded</span>
                            ) : (
                              <span className="text-accent">Active</span>
                            )}
                          </div>
                        </>
                      ) : (
                        <div className="text-center space-y-1">
                          <span className="text-[10px] text-text-muted uppercase font-bold block">Seat #{seatNumber}</span>
                          <button
                            onClick={() => handleJoinTableSeat(seatNumber)}
                            className="px-2.5 py-1 bg-surface border border-line hover:bg-surface-alt text-text font-bold text-[10px] uppercase rounded-xl cursor-pointer"
                          >
                            Sit Here
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* DEALER HOTKEYS HELP FOOTER */}
            <div className="p-4 bg-bg border border-line rounded-2xl flex flex-wrap items-center justify-between text-xs text-text-muted font-mono gap-2">
              <span className="font-bold text-text">⌨️ Dealer Hotkeys:</span>
              <span><kbd className="px-1.5 py-0.5 bg-surface border border-line rounded text-text font-bold">Space</kbd> Next Street</span>
              <span><kbd className="px-1.5 py-0.5 bg-surface border border-line rounded text-text font-bold">F</kbd> Flop</span>
              <span><kbd className="px-1.5 py-0.5 bg-surface border border-line rounded text-text font-bold">T</kbd> Turn</span>
              <span><kbd className="px-1.5 py-0.5 bg-surface border border-line rounded text-text font-bold">R</kbd> River</span>
              <span><kbd className="px-1.5 py-0.5 bg-surface border border-line rounded text-text font-bold">S</kbd> Showdown</span>
              <span><kbd className="px-1.5 py-0.5 bg-surface border border-line rounded text-text font-bold">N</kbd> Next Hand</span>
            </div>
          </div>
        )}

        {/* ========================================================= */}
        {/* TAB 2: PLAYER MINIMAL HOLE CARDS VIEW                     */}
        {/* ========================================================= */}
        {activeTab === 'playerView' && (
          <div className="max-w-md mx-auto space-y-6 py-4">
            
            {/* PLAYER STATUS CARD */}
            <div className="bg-surface border border-line p-6 rounded-3xl space-y-4 shadow-2xl text-center">
              <div className="flex items-center justify-between border-b border-line pb-3">
                <div className="text-left">
                  <span className="text-[10px] text-text-muted uppercase font-bold block">Seated Player</span>
                  <span className="font-extrabold text-text text-base">{currentUser.displayName || currentUser.email}</span>
                </div>

                <button
                  onClick={() => setShowBuyInModal(true)}
                  className="bg-accent-2 hover:bg-accent-2 text-accent-contrast font-black px-3.5 py-2 rounded-xl text-xs uppercase cursor-pointer shadow flex items-center gap-1"
                >
                  <Plus className="w-3.5 h-3.5" /> Buy In
                </button>
              </div>

              <div className="grid grid-cols-2 gap-3 text-center font-mono">
                <div className="p-3 bg-bg border border-line rounded-2xl">
                  <span className="text-[10px] text-text-muted uppercase block">Seat Number</span>
                  <span className="text-text font-bold text-sm">#{seatedPlayer?.seatNumber || 'Unseated'}</span>
                </div>

                <div className="p-3 bg-bg border border-line rounded-2xl">
                  <span className="text-[10px] text-text-muted uppercase block">Current Stack</span>
                  <span className="text-accent font-bold text-sm">{formatVal(seatedPlayer?.chipStack || 0)}</span>
                </div>
              </div>

              {/* REAL-TIME DEALER STATUS MESSAGE */}
              <div className="p-3 bg-warning/40 border border-warning/60 rounded-2xl text-xs text-warning font-mono">
                📢 Dealer Message: <strong className="text-text">{session.street || 'Preflop'} — Waiting for next card reveal</strong>
              </div>
            </div>

            {/* DIGITAL HOLE CARDS & PRIVACY PEEK CONTROLS */}
            <div className="bg-surface border border-line p-6 rounded-3xl space-y-5 shadow-2xl text-center">
              <div className="flex items-center justify-between border-b border-line pb-3">
                <h3 className="text-xs font-bold text-text uppercase tracking-wider flex items-center gap-2">
                  <Eye className="w-4 h-4 text-accent-2" /> Private Digital Hole Cards
                </h3>

                <div className="flex items-center gap-1 bg-bg p-1 rounded-xl border border-line">
                  <button
                    onClick={() => setPeekMode('hold')}
                    className={`px-2 py-1 text-[10px] font-bold uppercase rounded-lg cursor-pointer ${
                      peekMode === 'hold' ? 'bg-accent-2 text-accent-contrast font-black' : 'text-text-muted'
                    }`}
                  >
                    Hold
                  </button>
                  <button
                    onClick={() => setPeekMode('toggle')}
                    className={`px-2 py-1 text-[10px] font-bold uppercase rounded-lg cursor-pointer ${
                      peekMode === 'toggle' ? 'bg-accent-2 text-accent-contrast font-black' : 'text-text-muted'
                    }`}
                  >
                    Toggle
                  </button>
                </div>
              </div>

              {/* CARD DISPLAY BOX */}
              {seatedPlayer?.status === 'Blocked' ? (
                <div className="p-6 bg-danger/60 border border-danger/40 rounded-2xl text-center space-y-2">
                  <ShieldAlert className="w-8 h-8 text-danger mx-auto" />
                  <h4 className="text-sm font-bold text-danger uppercase">Blocked — Missed Blinds Exceeded</h4>
                  <p className="text-xs text-danger">
                    You have exceeded the maximum allowed skipped blinds ({session.skipBlindLimit || 2}). Please request a bank update from the Admin to settle and resume playing.
                  </p>
                </div>
              ) : seatedPlayer?.holeCards && seatedPlayer.holeCards.length === 2 ? (
                <div className="space-y-4">
                  <div 
                    onMouseDown={() => peekMode === 'hold' && setIsPeeking(true)}
                    onMouseUp={() => peekMode === 'hold' && setIsPeeking(false)}
                    onTouchStart={() => peekMode === 'hold' && setIsPeeking(true)}
                    onTouchEnd={() => peekMode === 'hold' && setIsPeeking(false)}
                    className="flex justify-center items-center gap-4 py-4 cursor-pointer select-none"
                  >
                    {isPeeking ? (
                      <>
                        <PlayingCard card={seatedPlayer.holeCards[0]} size="lg" variant="player" />
                        <PlayingCard card={seatedPlayer.holeCards[1]} size="lg" variant="player" />
                      </>
                    ) : (
                      <>
                        <PlayingCard hidden size="lg" />
                        <PlayingCard hidden size="lg" />
                      </>
                    )}
                  </div>

                  {peekMode === 'toggle' && (
                    <button
                      onClick={() => setIsPeeking(!isPeeking)}
                      className="w-full bg-bg border border-line hover:bg-surface text-text font-bold py-2.5 rounded-xl text-xs uppercase tracking-wider cursor-pointer flex items-center justify-center gap-2"
                    >
                      {isPeeking ? <EyeOff className="w-4 h-4 text-warning" /> : <Eye className="w-4 h-4 text-accent" />}
                      {isPeeking ? 'Hide Cards' : 'Peek Hole Cards'}
                    </button>
                  )}

                  <p className="text-[10px] text-text-muted font-mono">
                    {peekMode === 'hold' ? 'Press & hold screen to reveal your private hole cards.' : 'Click button above to toggle card visibility.'}
                  </p>
                </div>
              ) : (
                <div className="py-8 text-center space-y-2">
                  <p className="text-xs text-text-muted">No hole cards dealt yet for Hand #{session.handNumber || 1}.</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ========================================================= */}
        {/* TAB 3: ADMIN OPERATIONAL DASHBOARD                        */}
        {/* ========================================================= */}
        {activeTab === 'adminView' && isAdmin && (
          <div className="space-y-6">
            
            <div className="bg-surface border border-line p-6 rounded-3xl space-y-6 shadow-xl">
              <div className="border-b border-line pb-4 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-black text-accent-2 uppercase flex items-center gap-2">
                    <ShieldCheck className="w-5 h-5" /> Admin Operational Dashboard
                  </h2>
                  <p className="text-xs text-text-muted mt-0.5">
                    Manage session finances, approve bank buy-in requests, and assign the active Dealer.
                  </p>
                </div>

                {onSettleSession && (
                  <button
                    onClick={() => onSettleSession(session)}
                    className="bg-accent hover:bg-accent text-accent-contrast font-black px-4 py-2.5 rounded-xl text-xs uppercase tracking-wider cursor-pointer shadow"
                  >
                    Complete Financial Settlement
                  </button>
                )}
              </div>

              {/* CHANGE ASSIGNED DEALER */}
              <div className="p-4 bg-bg border border-line rounded-2xl flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <span className="text-xs font-bold text-text uppercase block">Active Dealer Assignment</span>
                  <p className="text-[11px] text-text-muted mt-0.5">
                    Currently assigned: <strong className="text-warning">{session.assignedDealerName || 'None'}</strong>
                  </p>
                </div>

                <button
                  onClick={() => setShowChangeDealerModal(true)}
                  className="px-3.5 py-2 bg-surface border border-line hover:bg-surface-alt text-text font-bold text-xs uppercase rounded-xl cursor-pointer"
                >
                  Re-assign Dealer
                </button>
              </div>

              {/* PENDING BUY-IN REQUESTS */}
              <div className="space-y-3">
                <h3 className="text-xs font-bold text-text uppercase tracking-wider flex items-center gap-2">
                  <Coins className="w-4 h-4 text-warning" /> Pending Bank Buy-in Requests ({buyInRequests.filter(r => r.status === 'pending').length})
                </h3>

                {buyInRequests.filter(r => r.status === 'pending').length === 0 ? (
                  <p className="text-xs text-text-muted bg-bg p-4 rounded-2xl border border-line">
                    No pending buy-in requests currently.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {buyInRequests.filter(r => r.status === 'pending').map(req => (
                      <div key={req.id} className="p-4 bg-bg border border-line rounded-2xl flex items-center justify-between gap-3">
                        <div>
                          <div className="text-xs font-bold text-text flex items-center gap-2">
                            {req.userDisplayName}
                            <span className="text-warning font-mono font-bold text-sm">
                              {formatVal(req.amount)}
                            </span>
                          </div>
                          <span className="text-[10px] text-text-muted font-mono">
                            Requested at {new Date(req.createdAt).toLocaleTimeString()}
                          </span>
                        </div>

                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => handleApproveBuyIn(req)}
                            className="bg-accent hover:bg-accent text-accent-contrast font-bold px-3.5 py-2 rounded-xl text-xs uppercase cursor-pointer flex items-center gap-1 shadow"
                          >
                            <Check className="w-3.5 h-3.5" /> Approve
                          </button>
                          <button
                            onClick={() => handleRejectBuyIn(req)}
                            className="bg-danger/15 hover:bg-danger/25 border border-danger/40 text-danger font-bold px-3 py-2 rounded-xl text-xs uppercase cursor-pointer"
                          >
                            <X className="w-3.5 h-3.5" /> Reject
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

      </main>

      {/* ========================================================= */}
      {/* TV / LARGE TABLE DISPLAY OVERLAY                          */}
      {/* ========================================================= */}
      {showTvMode && (
        <div className="fixed inset-0 bg-bg z-50 flex flex-col p-8 select-none">
          <div className="flex items-center justify-between border-b border-line pb-4">
            <div className="flex items-center gap-3">
              <Tv className="w-8 h-8 text-accent-2" />
              <div>
                <h1 className="text-2xl font-black text-text uppercase tracking-wide">{club.name} — TV TABLE DISPLAY</h1>
                <p className="text-xs text-text-muted font-mono">Live Community Board & Pot Display | Hand #{session.handNumber || 1}</p>
              </div>
            </div>

            <button
              onClick={() => setShowTvMode(false)}
              className="px-4 py-2 bg-danger/15 hover:bg-danger/25 border border-danger/40 text-danger font-bold text-xs uppercase rounded-xl cursor-pointer"
            >
              Exit TV Mode
            </button>
          </div>

          <div className="flex-1 my-6 bg-bg border-4 border-line rounded-[48px] p-8 flex flex-col items-center justify-between relative shadow-2xl overflow-hidden">
            
            {/* TV CENTER BOARD */}
            <div className="bg-surface border-2 border-line p-8 rounded-3xl text-center space-y-6 max-w-2xl w-full shadow-2xl">
              <div className="flex items-center justify-between text-sm text-text-muted font-mono border-b border-line pb-3">
                <span>BLINDS: <strong className="text-text">₹{session.smallBlind || 25}/₹{session.bigBlind || 50}</strong></span>
                <span className="text-accent-2 font-black uppercase text-base">POT: {formatVal(session.potSize || 0)}</span>
              </div>

              {/* CARDS */}
              <div className="flex items-center justify-center gap-4 py-4">
                {[0, 1, 2, 3, 4].map(idx => {
                  const card = session.communityCards?.[idx];

                  return (
                    <div key={idx} className="w-20 h-28 bg-bg border border-line rounded-2xl flex items-center justify-center">
                      {card ? (
                        <PlayingCard card={card} size="lg" variant="community" />
                      ) : (
                        <span className="text-xs text-line font-mono font-bold uppercase">
                          {idx < 3 ? 'FLOP' : idx === 3 ? 'TURN' : 'RIVER'}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* SEATED PLAYERS ON TV */}
            <div className="w-full grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-4">
              {session.playerSeats?.map(seat => (
                <div key={seat.seatNumber} className="p-4 bg-surface border border-line rounded-2xl text-center space-y-1">
                  <span className="font-bold text-text text-sm block truncate">{seat.name}</span>
                  <span className="text-accent font-mono font-bold text-xs">{formatVal(seat.chipStack)}</span>
                  <span className="text-[10px] text-text-muted uppercase block">{seat.isFolded ? 'Folded' : 'Active'}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* MODAL: BUY-IN REQUEST */}
      {showBuyInModal && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-surface border border-line w-full max-w-sm p-6 rounded-3xl shadow-2xl space-y-5">
            <div className="flex items-center justify-between border-b border-line pb-3">
              <h3 className="text-base font-bold text-text uppercase tracking-wider flex items-center gap-2">
                <Coins className="w-5 h-5 text-accent-2" /> Buy In
              </h3>
              <button onClick={() => setShowBuyInModal(false)} className="text-text-muted hover:text-text cursor-pointer">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleRequestBuyIn} className="space-y-4">
              <div className="space-y-1">
                <label className="text-[11px] font-bold text-text-muted uppercase">Buy-in Amount</label>
                <input
                  type="number"
                  min={club.minBuyIn || 1000}
                  step={500}
                  value={buyInAmount}
                  onChange={(e) => setBuyInAmount(Number(e.target.value))}
                  className="w-full bg-bg border border-line rounded-xl px-3.5 py-2.5 text-xs text-text font-bold focus:border-accent-2 outline-none font-mono"
                />
                <span className="text-[10px] text-text-muted">Minimum buy-in: {formatVal(club.minBuyIn || 1000)}</span>
              </div>

              <button
                type="submit"
                disabled={submittingBuyIn}
                className="w-full bg-accent-2 hover:bg-accent-2 text-accent-contrast font-black py-3 rounded-xl text-xs uppercase tracking-widest cursor-pointer shadow-lg"
              >
                {submittingBuyIn ? 'SUBMITTING...' : 'SUBMIT BANK REQUEST'}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: RE-ASSIGN DEALER */}
      {showChangeDealerModal && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-surface border border-line w-full max-w-sm p-6 rounded-3xl shadow-2xl space-y-5">
            <div className="flex items-center justify-between border-b border-line pb-3">
              <h3 className="text-base font-bold text-text uppercase tracking-wider flex items-center gap-2">
                <Crown className="w-5 h-5 text-accent-2" /> Re-assign Active Dealer
              </h3>
              <button onClick={() => setShowChangeDealerModal(false)} className="text-text-muted hover:text-text cursor-pointer">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleChangeDealer} className="space-y-4">
              <div className="space-y-1">
                <label className="text-[11px] font-bold text-text-muted uppercase">Select Dealer</label>
                <select
                  value={selectedNewDealerUid}
                  onChange={(e) => setSelectedNewDealerUid(e.target.value)}
                  className="w-full bg-bg border border-line rounded-xl px-3.5 py-2.5 text-xs text-text font-bold focus:border-accent-2 outline-none"
                >
                  <option value="">-- Choose Seated Player --</option>
                  {session.playerSeats?.map(s => (
                    <option key={s.uid} value={s.uid}>{s.name} (Seat #{s.seatNumber})</option>
                  ))}
                </select>
              </div>

              <button
                type="submit"
                className="w-full bg-accent-2 hover:bg-accent-2 text-accent-contrast font-black py-3 rounded-xl text-xs uppercase tracking-widest cursor-pointer shadow-lg"
              >
                CONFIRM NEW DEALER
              </button>
            </form>
          </div>
        </div>
      )}

    </div>
  );
};
