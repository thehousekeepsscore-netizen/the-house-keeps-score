import React, { useState, useEffect, useMemo, useCallback, lazy, Suspense } from 'react';
import { Routes, Route, Navigate, useNavigate, useParams, useLocation } from 'react-router-dom';
import { Suit, Card, Seat, Board, ToastMessage } from './types';
import { ErrorBoundary } from './components/ErrorBoundary';
import { TAB_TO_PATH as DASHBOARD_TAB_TO_PATH } from './lib/dashboard-tabs';
import { useOAuthLanding } from './lib/use-oauth-landing';

// Split out of the entry chunk. None of these is reachable until the user is
// signed in, so shipping them with the login page delays the one screen every
// visitor sees. Suspense falls back to the same skeleton shape the routes
// already use for a cold cache, so a slow chunk looks like a slow fetch rather
// than a blank frame.
const ClubDashboardView = lazy(() =>
  import('./components/ClubDashboardView').then((m) => ({ default: m.ClubDashboardView }))
);
const ClubDetailView = lazy(() =>
  import('./components/ClubDetailView').then((m) => ({ default: m.ClubDetailView }))
);
const PerformanceDebugView = lazy(() =>
  import('./components/PerformanceDebugView').then((m) => ({ default: m.PerformanceDebugView }))
);
// The other two debug routes, split for the same reason /debug/performance is.
// They were statically imported, and because they render the real live-session
// components they pulled the whole session tree — LiveSession, PokerTable, the
// sheets — into the entry chunk: 38.6 kB of code reachable only from two
// unlinked developer URLs, on the critical path of every visitor including
// anyone still looking at the login screen.
const TablePreview = lazy(() =>
  import('./components/session/TablePreview').then((m) => ({ default: m.TablePreview }))
);
const SessionPreview = lazy(() =>
  import('./components/session/SessionPreview').then((m) => ({ default: m.SessionPreview }))
);

/** The skeleton shown while a route chunk loads. */
const RouteFallback: React.FC = () => (
  <div className="min-h-screen p-4 md:p-8 max-w-7xl mx-auto space-y-4" aria-busy="true" aria-label="Loading">
    <div className="h-14 bg-surface border border-line rounded-2xl animate-pulse" />
    <div className="h-40 bg-surface border border-line rounded-2xl animate-pulse" />
    <div className="h-40 bg-surface border border-line rounded-2xl animate-pulse" />
  </div>
);
import { LoginPage } from './components/LoginPage';
import { SplashScreen } from './components/SplashScreen';
import { ChipCardDecoration } from './components/ChipCardDecoration';
import { ToastContainer } from './components/ToastContainer';
import { ProfileSetupView } from './components/ProfileSetupView';
import { soundFx } from './utils/audio';
import { useAuth } from './lib/auth-context';
import { Club } from './types';
import * as clubsApi from './lib/clubs-api';
import { getSocket } from './lib/socket';
import { useResource, useResourceCache } from './lib/resource-cache';

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
  // Navigation state lives in the URL. There is deliberately no viewState or
  // selectedClub here any more: a second source of truth is what made browser
  // Back and the address bar disagree with the screen.
  const navigate = useNavigate();
  const cache = useResourceCache();
  /** Captured per render: writes from this render belong to this identity. */
  const write = cache.beginWrite();
  const { user: authUser, status: authStatus, logout, authError, clearAuthError } = useAuth();
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
    } else {
      setPlayerAvatarUrl('');
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

  /**
   * Seed before navigating. The dashboard already holds the full Club object,
   * so writing it into the cache under the key the club route reads means the
   * destination renders immediately instead of fetching and flashing a
   * skeleton. It still revalidates in the background.
   */
  const handleSelectClub = useCallback((club: Club) => {
    cache.update<Club>(`club:${club.id}`, () => club, write);
    navigate(`/clubs/${club.id}`);
  }, [cache, navigate]);

  const handleDismissToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  /**
   * Surfaces authentication failures. It does not *establish* authentication —
   * AuthProvider is the single writer of auth state, and it consumes the
   * /oauth/callback code itself during startup.
   *
   * Two sources of failure:
   *   /login?error=...   the API rejected the flow before returning (oauth.google.ts:46, :84)
   *   authError          the code came back but the exchange failed
   */
  const reportOAuthError = useCallback(
    (error: string) => {
      if (error === 'oauth_state') {
        addToast('Sign-in expired', 'That sign-in attempt timed out. Please try again.', 'warning');
      } else {
        addToast('Sign-in failed', 'Google sign-in could not be completed. Please try again.', 'warning');
      }
    },
    [addToast]
  );

  useOAuthLanding(authStatus, reportOAuthError);

  useEffect(() => {
    if (!authError) return;
    addToast('Sign-in failed', 'Could not complete Google sign-in. Please try again.', 'warning');
    clearAuthError();
  }, [authError, addToast, clearAuthError]);

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

    // (dead: the local table game has no route — see NAVIGATION-AUDIT.md §4)
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
    // (dead: the local table game has no route — see NAVIGATION-AUDIT.md §4)

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
      {authUser && <ChipCardDecoration variant="ambient" />}

      {!authUser ? (
        <LoginPage />
      ) : !authUser.profileComplete ? (
        /* Onboarding is a gate, not a screen you can be sent to at random:
           any route resolves here until the profile is finished. It is now
           escapable — ProfileSetupView owns a sign-out — where the old
           viewState version was a genuine trap. */
        <ProfileSetupView />
      ) : (
        <Suspense fallback={<RouteFallback />}>
        <Routes>
          {/* Every dashboard tab is its own address, generated from the same
              map the dashboard reads, so the two can never disagree about
              which tabs exist. They all render one screen — the tab is chosen
              from the path — which is what lets Back and Forward walk the tabs
              instead of leaving the app. */}
          {Object.values(DASHBOARD_TAB_TO_PATH).map(path => (
            <Route
              key={path}
              path={path}
              element={
                <RouteBoundary title="your clubs">
                  <ClubDashboardView
                    currentUser={authUser}
                    playerAvatarUrl={playerAvatarUrl}
                    onSelectClub={handleSelectClub}
                    onProceedToLobby={() => { /* legacy table game, unreachable */ }}
                    onSignOut={logout}
                  />
                </RouteBoundary>
              }
            />
          ))}
          {/* Both forms render the same screen. /clubs/:clubId is the bare
              club — treated as the session tab — while /clubs/:clubId/:tab
              addresses a specific one. Kept as two routes rather than an
              optional segment so a bare club link stays valid forever. */}
          <Route
            path="/clubs/:clubId"
            element={
              <RouteBoundary title="this club">
                <ClubRoute currentUser={authUser} playerAvatarUrl={playerAvatarUrl} />
              </RouteBoundary>
            }
          />
          <Route
            path="/clubs/:clubId/:tab"
            element={
              <RouteBoundary title="this club">
                <ClubRoute currentUser={authUser} playerAvatarUrl={playerAvatarUrl} />
              </RouteBoundary>
            }
          />
          {/* /setup is where the profile gate above sends people; once complete
              it has nothing to show, so it folds back to the dashboard. */}
          {/* Developer instrumentation. Deliberately unlinked from the UI, and
              inside the authenticated tree so it is not a public endpoint. */}
          <Route path="/debug/performance" element={<PerformanceDebugView />} />
          <Route path="/debug/table" element={<TablePreview />} />
          <Route path="/debug/session" element={<SessionPreview />} />
          <Route path="/setup" element={<Navigate to="/" replace />} />
          {/* Unknown URLs — including the OAuth callback, whose code
              AuthProvider has already consumed and whose URL it has rewritten. */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </Suspense>
      )}

      {/*
        App-level toasts, rendered outside every route.
      */}
      <ToastContainer toasts={toasts} onDismiss={handleDismissToast} />
    </div>
  );
}


/**
 * An ErrorBoundary keyed to the current URL.
 *
 * Without the key the boundary latches: a screen throws, the user presses Back,
 * the route changes underneath, and they keep looking at the old error.
 */
const RouteBoundary: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => {
  const location = useLocation();
  return (
    <ErrorBoundary title={title} resetKey={location.pathname}>
      {children}
    </ErrorBoundary>
  );
};

/**
 * Resolves :clubId into a club.
 *
 * The dashboard seeds the cache before navigating, so arriving from there
 * paints on the first frame with no request and no skeleton. Arriving cold —
 * a deep link, a refresh, a shared URL — has nothing cached, so it fetches and
 * shows a skeleton exactly once.
 */
export const ClubRoute: React.FC<{ currentUser: NonNullable<ReturnType<typeof useAuth>['user']>; playerAvatarUrl: string }> = ({
  currentUser,
  playerAvatarUrl,
}) => {
  const { clubId } = useParams<{ clubId: string }>();
  const navigate = useNavigate();

  /**
   * Start the socket handshake here, before the club screen exists.
   *
   * ClubDetailView is lazily loaded, so opening a club spends a chunk download
   * and a club fetch in this component first. The handshake used to begin after
   * all that, when ClubDetailView's effect called getSocket() for the first
   * time — which meant the socket was reliably *not* connected when that effect
   * ran. That path fetches everything, then connects a few hundred milliseconds
   * later, and `connect` fires `resync()` which forces the same eight requests
   * again: sixteen for one cold open, measured.
   *
   * Connecting here overlaps the handshake with work that was happening anyway,
   * so by the time ClubDetailView mounts the socket is usually already up. It
   * then takes the branch that emits `club:join` directly and issues no second
   * round — the same path every warm navigation already takes.
   *
   * This does not remove the reconnect resync, and must not: a socket that
   * drops after the room is joined still has to re-join and refetch, because
   * events during the gap are gone. It only stops the *first* connect from
   * repeating work the mount just did.
   */
  useEffect(() => {
    getSocket();
  }, []);

  const { data: club, status, error } = useResource<Club>(
    clubId ? `club:${clubId}` : null,
    () => clubsApi.getClub(clubId!)
  );

  if (status === 'empty') {
    if (error) {
      // A club that does not exist, or one this user cannot see. Better than
      // silently bouncing to the dashboard, which would look like a bug.
      return (
        <div className="min-h-screen flex flex-col items-center justify-center gap-4 p-6 text-center">
          <p className="text-sm font-medium text-text">This club isn't available.</p>
          <p className="text-xs text-text-muted">It may have been deleted, or you may not be a member.</p>
          <button
            onClick={() => navigate('/', { replace: true })}
            className="bg-accent text-accent-contrast font-medium px-4 py-2 rounded-xl text-xs cursor-pointer"
          >
            Back to my clubs
          </button>
        </div>
      );
    }
    return (
      <div className="min-h-screen p-4 md:p-8 max-w-7xl mx-auto space-y-4" aria-busy="true" aria-label="Loading club">
        <div className="h-14 bg-surface border border-line rounded-2xl animate-pulse" />
        <div className="h-40 bg-surface border border-line rounded-2xl animate-pulse" />
        <div className="h-40 bg-surface border border-line rounded-2xl animate-pulse" />
      </div>
    );
  }

  return (
    <ClubDetailView
      club={club!}
      currentUser={currentUser}
      playerAvatarUrl={playerAvatarUrl}
      onBackToDashboard={() => navigate('/')}
    />
  );
};
