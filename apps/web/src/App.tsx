import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Suit, Card, Seat, Board, ToastMessage } from './types';
import { LobbyView } from './components/LobbyView';
import { PlayerView } from './components/PlayerView';
import { MergedHostDisplayView } from './components/MergedHostDisplayView';
import { LoginPage } from './components/LoginPage';
import { SplashScreen } from './components/SplashScreen';
import { ChipCardDecoration } from './components/ChipCardDecoration';
import { ToastContainer } from './components/ToastContainer';
import { ProfileSetupView } from './components/ProfileSetupView';
import { ClubDashboardView } from './components/ClubDashboardView';
import { ClubDetailView } from './components/ClubDetailView';
import { soundFx } from './utils/audio';
import { useAuth } from './lib/auth-context';
import { useApplyTheme } from './lib/theme';
import { Club } from './types';

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

const calculateSkippedSeats = (seats: Seat[], dealerSeat: number): number[] => {
  const activeOccupiedSeats = seats
    .filter(s => s.player && !s.isSatOut)
    .map(s => s.seatNumber)
    .sort((a, b) => a - b);

  const totalActive = activeOccupiedSeats.length;
  if (totalActive <= 9) return [];

  const numToSkip = totalActive - 9;
  const dealerIndex = activeOccupiedSeats.indexOf(dealerSeat);

  if (dealerIndex === -1) return [];

  const skipped: number[] = [];
  for (let i = 1; i <= numToSkip; i++) {
    const skipIdx = (dealerIndex - i + totalActive) % totalActive;
    skipped.push(activeOccupiedSeats[skipIdx]);
  }

  return skipped;
};

export default function App() {
  const [viewState, setViewState] = useState<'lobby' | 'host' | 'player' | 'register' | 'profileSetup' | 'clubDashboard' | 'clubDetail'>('register');
  const [selectedClub, setSelectedClub] = useState<Club | null>(null);
  const { user: authUser, status: authStatus, logout, exchangeOAuthCode } = useAuth();
  useApplyTheme(authUser?.themePreference);
  const [tableCode, setTableCode] = useState('7742');
  const [tableCodeInput, setTableCodeInput] = useState('7742');
  const [playerNameInput, setPlayerNameInput] = useState('');
  const [playerAvatarUrl, setPlayerAvatarUrl] = useState('');
  const [selectedPlayerSeat, setSelectedPlayerSeat] = useState(1);
  const [selectedJoinSeat, setSelectedJoinSeat] = useState(1);
  const [errorMessage, setErrorMessage] = useState('');
  const [isGameStarted, setIsGameStarted] = useState(false);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  // The OAuth landing effect lives further down, below addToast — it needs to
  // surface failures as toasts, and referencing addToast in a dependency array
  // above its own declaration would be a temporal dead zone error.

  // Sync logged in user display name and avatar
  useEffect(() => {
    if (authStatus === 'loading') return;

    if (authUser) {
      const name = authUser.displayName || (authUser.email ? authUser.email.split('@')[0] : '') || '';
      if (name) {
        setPlayerNameInput(name);
      }
      if (authUser.photoURL) {
        setPlayerAvatarUrl(authUser.photoURL);
      }
      // New accounts (or ones that never finished onboarding) are forced
      // through profile setup before they can reach the rest of the app.
      setViewState(prev => {
        if (!authUser.profileComplete) return 'profileSetup';
        return prev === 'register' || prev === 'profileSetup' ? 'clubDashboard' : prev;
      });
    } else {
      setPlayerAvatarUrl('');
      setViewState('register');
    }
  }, [authUser, authStatus]);

  // Table Core State
  const [handNumber, setHandNumber] = useState(1);
  const [dealerSeat, setDealerSeat] = useState(1);
  const [street, setStreet] = useState('Preflop');
  const [runCount, setRunCount] = useState(1);

  // Deck & Board State
  const [deck, setDeck] = useState<Card[]>([]);
  const [, setBurnCards] = useState<Card[]>([]);
  const [boards, setBoards] = useState<Board[]>([
    { id: 1, flop: [], turn: null, river: null }
  ]);

  // Initial 11 Seats (Start with empty seats for lobby joining or host assignment)
  const [seats, setSeats] = useState<Seat[]>([
    { seatNumber: 1, player: null, isSatOut: false, isFolded: false, holeCards: [] },
    { seatNumber: 2, player: null, isSatOut: false, isFolded: false, holeCards: [] },
    { seatNumber: 3, player: null, isSatOut: false, isFolded: false, holeCards: [] },
    { seatNumber: 4, player: null, isSatOut: false, isFolded: false, holeCards: [] },
    { seatNumber: 5, player: null, isSatOut: false, isFolded: false, holeCards: [] },
    { seatNumber: 6, player: null, isSatOut: false, isFolded: false, holeCards: [] },
    { seatNumber: 7, player: null, isSatOut: false, isFolded: false, holeCards: [] },
    { seatNumber: 8, player: null, isSatOut: false, isFolded: false, holeCards: [] },
    { seatNumber: 9, player: null, isSatOut: false, isFolded: false, holeCards: [] },
    { seatNumber: 10, player: null, isSatOut: false, isFolded: false, holeCards: [] },
    { seatNumber: 11, player: null, isSatOut: false, isFolded: false, holeCards: [] },
  ]);

  const addToast = useCallback((title: string, message: string, type: 'success' | 'info' | 'warning' = 'success') => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    const newToast: ToastMessage = { id, title, message, type };
    setToasts(prev => [...prev, newToast]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 4500);
  }, []);

  const handleDismissToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  /**
   * Where the Google OAuth round trip lands. This app has no router, so the
   * path is inspected directly.
   *
   * Two landing paths, both of which must end with the URL rewritten to '/':
   *
   *   /oauth/callback?code=...   success — exchange the one-time code
   *   /login?error=...           failure — oauth.google.ts:46 and :84
   *
   * The failure path was previously unhandled: the SPA fallback served
   * index.html, this effect returned early because the path wasn't
   * /oauth/callback, and the user was left on the signed-out screen with
   * "?error=oauth_state" still in the address bar and no explanation. The
   * commonest cause is benign — OAuth state lives in an in-memory Map
   * (ephemeralStore.ts), so any API restart mid-flow invalidates it — which
   * makes "try again" the correct advice rather than a dead end.
   *
   * replaceState in both branches keeps the callback URL out of history, so
   * Back never re-enters a completed OAuth flow.
   */
  useEffect(() => {
    const { pathname, search } = window.location;
    const params = new URLSearchParams(search);

    if (pathname === '/oauth/callback') {
      const code = params.get('code');
      window.history.replaceState({}, '', '/');
      if (code) {
        exchangeOAuthCode(code).catch(err => {
          console.error('OAuth exchange failed:', err);
          addToast('Sign-in failed', 'Could not complete Google sign-in. Please try again.', 'warning');
        });
      }
      return;
    }

    if (pathname === '/login') {
      const error = params.get('error');
      window.history.replaceState({}, '', '/');
      if (error === 'oauth_state') {
        addToast('Sign-in expired', 'That sign-in attempt timed out. Please try again.', 'warning');
      } else if (error) {
        addToast('Sign-in failed', 'Google sign-in could not be completed. Please try again.', 'warning');
      }
    }
  }, [exchangeOAuthCode, addToast]);

  const activeSkippedSeats = useMemo(() => {
    return calculateSkippedSeats(seats, dealerSeat);
  }, [seats, dealerSeat]);

  const handleStartNewHand = useCallback((shouldAdvanceDealer = true) => {
    setSeats(prevSeats => {
      let nextDealer = dealerSeat;

      if (shouldAdvanceDealer) {
        const occupied = prevSeats.filter(s => s.player && !s.isSatOut);
        if (occupied.length > 0) {
          const sorted = [...occupied].sort((a, b) => a.seatNumber - b.seatNumber);
          const currIdx = sorted.findIndex(s => s.seatNumber === dealerSeat);
          const nextIdx = (currIdx + 1) % sorted.length;
          nextDealer = sorted[nextIdx].seatNumber;
          setDealerSeat(nextDealer);
        }
        setHandNumber(prev => prev + 1);
      }

      const nextSkippedSeats = calculateSkippedSeats(prevSeats, nextDealer);
      const freshDeck = createCryptographicDeck();
      let currentDeckIdx = 0;

      const updatedSeats = prevSeats.map(s => {
        const isSkipped = nextSkippedSeats.includes(s.seatNumber);
        if (s.player && !s.isSatOut && !isSkipped) {
          const card1 = freshDeck[currentDeckIdx++];
          const card2 = freshDeck[currentDeckIdx++];
          return { ...s, holeCards: [card1, card2], isFolded: false };
        }
        return { ...s, holeCards: [], isFolded: false };
      });

      const remainingDeck = freshDeck.slice(currentDeckIdx);

      setDeck(remainingDeck);
      setBurnCards([]);
      setStreet('Preflop');
      setRunCount(1);
      setBoards([{ id: 1, flop: [], turn: null, river: null }]);

      soundFx.playShuffleAndDealSeries(6);

      return updatedSeats;
    });
  }, [dealerSeat]);

  const handleStartGame = useCallback(() => {
    const activePlayersCount = seats.filter(s => s.player && !s.isSatOut).length;
    if (activePlayersCount < 2) {
      addToast('⚠️ Cannot Start Game', 'At least 2 active players are required to start the game.', 'warning');
      return;
    }

    setIsGameStarted(true);
    handleStartNewHand(false);
    addToast('🚀 GAME STARTED', `Hand #${handNumber} dealt to ${activePlayersCount} players. Enjoy!`, 'success');

    // Sync via BroadcastChannel
    try {
      const channel = new BroadcastChannel(`poker_room_${tableCode}`);
      channel.postMessage({ type: 'GAME_STARTED' });
      channel.close();
    } catch {
      // ignore
    }
  }, [handleStartNewHand, handNumber, seats, addToast, tableCode]);

  const handleRevealFlop = useCallback(() => {
    setStreet(currentStreet => {
      if (currentStreet !== 'Preflop') return currentStreet;

      setDeck(prevDeck => {
        if (prevDeck.length < 4) return prevDeck;
        const currentDeck = [...prevDeck];
        const burn1 = currentDeck.shift();
        if (burn1) setBurnCards(prev => [...prev, burn1]);

        const card1 = currentDeck.shift();
        const card2 = currentDeck.shift();
        const card3 = currentDeck.shift();

        if (card1 && card2 && card3) {
          const flopCards = [card1, card2, card3];
          setBoards(prevBoards => prevBoards.map(b => ({ ...b, flop: flopCards })));
          soundFx.playShuffleAndDealSeries(3);
          return currentDeck;
        }
        return prevDeck;
      });

      return 'Flop';
    });
  }, []);

  const handleRevealTurn = useCallback(() => {
    setStreet(currentStreet => {
      if (currentStreet !== 'Flop') return currentStreet;

      setDeck(prevDeck => {
        if (prevDeck.length < 2) return prevDeck;
        const currentDeck = [...prevDeck];
        const burn = currentDeck.shift();
        if (burn) setBurnCards(prev => [...prev, burn]);

        const turnCard = currentDeck.shift();
        if (turnCard) {
          setBoards(prevBoards => prevBoards.map(b => ({ ...b, turn: turnCard })));
          soundFx.playCardDealSound();
          return currentDeck;
        }
        return prevDeck;
      });

      return 'Turn';
    });
  }, []);

  const handleRevealRiver = useCallback(() => {
    setStreet(currentStreet => {
      if (currentStreet !== 'Turn') return currentStreet;

      setDeck(prevDeck => {
        if (prevDeck.length < 2) return prevDeck;
        const currentDeck = [...prevDeck];
        const burn = currentDeck.shift();
        if (burn) setBurnCards(prev => [...prev, burn]);

        const riverCard = currentDeck.shift();
        if (riverCard) {
          setBoards(prevBoards => prevBoards.map(b => ({ ...b, river: riverCard })));
          soundFx.playCardDealSound();
          return currentDeck;
        }
        return prevDeck;
      });

      return 'River';
    });
  }, []);

  const handleRunRemainingBoard = useCallback(() => {
    setDeck(prevDeck => {
      let currentDeck = [...prevDeck];

      setBoards(prevBoards => {
        return prevBoards.map(board => {
          let flop = [...board.flop];
          let turn = board.turn;
          let river = board.river;

          // Flop
          if (flop.length < 3 && currentDeck.length >= 4) {
            const burn = currentDeck.shift();
            if (burn) setBurnCards(prev => [...prev, burn]);
            const f1 = currentDeck.shift();
            const f2 = currentDeck.shift();
            const f3 = currentDeck.shift();
            if (f1 && f2 && f3) flop = [f1, f2, f3];
          }

          // Turn
          if (!turn && currentDeck.length >= 2) {
            const burn = currentDeck.shift();
            if (burn) setBurnCards(prev => [...prev, burn]);
            const t = currentDeck.shift();
            if (t) turn = t;
          }

          // River
          if (!river && currentDeck.length >= 2) {
            const burn = currentDeck.shift();
            if (burn) setBurnCards(prev => [...prev, burn]);
            const rv = currentDeck.shift();
            if (rv) river = rv;
          }

          return { ...board, flop, turn, river };
        });
      });

      setStreet('River');
      return currentDeck;
    });
  }, []);

  const handleSetRunMode = useCallback((runs: number) => {
    setRunCount(runs);

    setDeck(prevDeck => {
      const currentDeck = [...prevDeck];
      setBoards(prevBoards => {
        if (prevBoards.length === runs) return prevBoards;
        const newBoards: Board[] = [];
        for (let r = 0; r < runs; r++) {
          if (r < prevBoards.length) {
            newBoards.push({ ...prevBoards[r] });
          } else {
            let flop = [...(prevBoards[0]?.flop || [])];
            let turn = prevBoards[0]?.turn || null;
            let river = prevBoards[0]?.river || null;

            if (flop.length === 0 && currentDeck.length >= 4) {
              const burn = currentDeck.shift();
              if (burn) setBurnCards(prev => [...prev, burn]);
              const f1 = currentDeck.shift();
              const f2 = currentDeck.shift();
              const f3 = currentDeck.shift();
              if (f1 && f2 && f3) flop = [f1, f2, f3];
            }
            if (!turn && currentDeck.length >= 2) {
              const burn = currentDeck.shift();
              if (burn) setBurnCards(prev => [...prev, burn]);
              const t = currentDeck.shift();
              if (t) turn = t;
            }
            if (!river && currentDeck.length >= 2) {
              const burn = currentDeck.shift();
              if (burn) setBurnCards(prev => [...prev, burn]);
              const rv = currentDeck.shift();
              if (rv) river = rv;
            }

            newBoards.push({ id: r + 1, flop, turn, river });
          }
        }
        return newBoards;
      });

      return currentDeck;
    });
  }, []);

  const handleEndHandAndRotateDealer = useCallback(() => {
    handleStartNewHand(true);
  }, [handleStartNewHand]);

  const handleCreateTable = (_tableName?: string) => {
    const generatedCode = `${Math.floor(1000 + Math.random() * 9000)}`;
    setTableCode(generatedCode);
    setTableCodeInput(generatedCode);
    setIsGameStarted(false);

    // Initialize 11 vacant seats (Host is the Admin/Display and does not occupy a seat)
    setSeats([
      { seatNumber: 1, player: null, isSatOut: false, isFolded: false, holeCards: [] },
      { seatNumber: 2, player: null, isSatOut: false, isFolded: false, holeCards: [] },
      { seatNumber: 3, player: null, isSatOut: false, isFolded: false, holeCards: [] },
      { seatNumber: 4, player: null, isSatOut: false, isFolded: false, holeCards: [] },
      { seatNumber: 5, player: null, isSatOut: false, isFolded: false, holeCards: [] },
      { seatNumber: 6, player: null, isSatOut: false, isFolded: false, holeCards: [] },
      { seatNumber: 7, player: null, isSatOut: false, isFolded: false, holeCards: [] },
      { seatNumber: 8, player: null, isSatOut: false, isFolded: false, holeCards: [] },
      { seatNumber: 9, player: null, isSatOut: false, isFolded: false, holeCards: [] },
      { seatNumber: 10, player: null, isSatOut: false, isFolded: false, holeCards: [] },
      { seatNumber: 11, player: null, isSatOut: false, isFolded: false, holeCards: [] },
    ]);

    setViewState('host');
    addToast('🎉 Table Created!', `Room Code: ${generatedCode}. Share with players to join!`, 'success');
  };

  const handleJoinTable = (code: string, pName: string, requestedSeatNum: number) => {
    setErrorMessage('');
    if (!code) {
      setErrorMessage('Please enter a valid Table Code.');
      return;
    }
    if (!pName) {
      setErrorMessage('Please enter your player name.');
      return;
    }

    const occupiedCount = seats.filter(s => s.player).length;
    if (occupiedCount >= 11) {
      setErrorMessage('Table is at full capacity (11 Players Max).');
      return;
    }

    // Auto assign: check if requested seat is vacant; if not, pick first vacant seat!
    let targetSeatNum = requestedSeatNum;
    const isTargetOccupied = seats.find(s => s.seatNumber === requestedSeatNum)?.player;

    if (isTargetOccupied) {
      const firstVacant = seats.find(s => !s.player);
      if (firstVacant) {
        targetSeatNum = firstVacant.seatNumber;
      }
    }

    // Update seat with new player
    setSeats(prev => prev.map(s => s.seatNumber === targetSeatNum ? {
      ...s,
      player: { id: `p-${Date.now()}`, name: pName, avatarUrl: playerAvatarUrl }
    } : s));

    setSelectedPlayerSeat(targetSeatNum);
    setTableCode(code);
    setViewState('player');

    // Notify Host via BroadcastChannel & Toast
    addToast('🎉 Player Joined!', `${pName} joined and took Seat ${targetSeatNum}!`, 'info');

    try {
      const channel = new BroadcastChannel(`poker_room_${code}`);
      channel.postMessage({
        type: 'PLAYER_JOINED',
        playerName: pName,
        playerAvatarUrl: playerAvatarUrl,
        seatNumber: targetSeatNum
      });
      channel.close();
    } catch {
      // BroadcastChannel fallback
    }
  };

  // Cross-Tab Listener for BroadcastChannel
  useEffect(() => {
    if (!tableCode) return;

    try {
      const channel = new BroadcastChannel(`poker_room_${tableCode}`);
      channel.onmessage = (event) => {
        const { type, playerName, playerAvatarUrl: avatar, seatNumber } = event.data || {};
        if (type === 'PLAYER_JOINED' && playerName && seatNumber) {
          setSeats(prev => prev.map(s => s.seatNumber === seatNumber ? {
            ...s,
            player: { id: `p-${Date.now()}`, name: playerName, avatarUrl: avatar }
          } : s));
          addToast('🎉 Player Joined!', `${playerName} joined and took Seat ${seatNumber}!`, 'success');
        } else if (type === 'GAME_STARTED') {
          setIsGameStarted(true);
        }
      };

      return () => {
        channel.close();
      };
    } catch {
      // ignore
    }
  }, [tableCode, addToast]);

  if (authStatus === 'loading') {
    return <SplashScreen />;
  }

  return (
    <div id="poker-app-root" className="min-h-screen bg-bg text-text isolate relative">
      {/* Same login-page chip/card photo, tinted per theme, as a fixed
          low-opacity watermark so every screen shares the same brand motif
          without competing with real content. Login has its own full-strength
          hero version already. */}
      {viewState !== 'register' && <ChipCardDecoration variant="ambient" />}

      {viewState === 'lobby' && (
        <LobbyView 
          onCreateTable={handleCreateTable}
          onJoinTable={handleJoinTable}
          tableCodeInput={tableCodeInput}
          setTableCodeInput={setTableCodeInput}
          playerNameInput={playerNameInput}
          setPlayerNameInput={setPlayerNameInput}
          selectedJoinSeat={selectedJoinSeat}
          setSelectedJoinSeat={setSelectedJoinSeat}
          seats={seats}
          errorMessage={errorMessage}
          onOpenRegister={() => setViewState('register')}
          currentUser={authUser}
          playerAvatarUrl={playerAvatarUrl}
        />
      )}

      {viewState === 'register' && <LoginPage />}

      {viewState === 'profileSetup' && authUser && <ProfileSetupView />}

      {viewState === 'clubDashboard' && authUser && (
        <ClubDashboardView 
          currentUser={authUser}
          playerAvatarUrl={playerAvatarUrl}
          onSelectClub={(club) => {
            setSelectedClub(club);
            setViewState('clubDetail');
          }}
          onProceedToLobby={() => setViewState('lobby')}
          onSignOut={async () => {
            await logout();
            setViewState('register');
          }}
        />
      )}

      {viewState === 'clubDetail' && authUser && selectedClub && (
        <ClubDetailView
          club={selectedClub}
          currentUser={authUser}
          playerAvatarUrl={playerAvatarUrl}
          onBackToDashboard={() => setViewState('clubDashboard')}
        />
      )}

      {viewState === 'host' && (
        <MergedHostDisplayView 
          handNumber={handNumber}
          street={street}
          runCount={runCount}
          deck={deck}
          boards={boards}
          seats={seats}
          setSeats={setSeats}
          dealerSeat={dealerSeat}
          setDealerSeat={setDealerSeat}
          activeSkippedSeats={activeSkippedSeats}
          handleStartNewHand={handleStartNewHand}
          handleRevealFlop={handleRevealFlop}
          handleRevealTurn={handleRevealTurn}
          handleRevealRiver={handleRevealRiver}
          handleRunRemainingBoard={handleRunRemainingBoard}
          handleSetRunMode={handleSetRunMode}
          handleEndHandAndRotateDealer={handleEndHandAndRotateDealer}
          tableCode={tableCode}
          onLeaveTable={() => setViewState('lobby')}
          isGameStarted={isGameStarted}
          handleStartGame={handleStartGame}
          toasts={toasts}
          onDismissToast={handleDismissToast}
        />
      )}

      {viewState === 'player' && (
        <PlayerView 
          selectedPlayerSeat={selectedPlayerSeat}
          setSelectedPlayerSeat={setSelectedPlayerSeat}
          seats={seats}
          setSeats={setSeats}
          handNumber={handNumber}
          street={street}
          dealerSeat={dealerSeat}
          activeSkippedSeats={activeSkippedSeats}
          boards={boards}
          deck={deck}
          tableCode={tableCode}
          onLeaveTable={() => setViewState('lobby')}
        />
      )}

      {/*
        App-level toasts, rendered outside every view branch.

        Until now the only consumer of `toasts` was MergedHostDisplayView
        (part of the unreachable local table game), so anything addToast()
        produced on the login screen, the dashboard or a club was created and
        silently discarded. ClubDetailView sidesteps this with its own local
        toast state and its own container.
      */}
      <ToastContainer toasts={toasts} onDismiss={handleDismissToast} />
    </div>
  );
}
