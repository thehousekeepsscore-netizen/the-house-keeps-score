import React, { useState } from 'react';
import { 
  Compass, LogOut, Shield, UserX, AlertTriangle, 
  Flag, Eye, EyeOff, RefreshCw, Rabbit 
} from 'lucide-react';
import { Seat, Board, Card } from '../types';
import { PlayingCard } from './PlayingCard';
import { soundFx } from '../utils/audio';

interface PlayerViewProps {
  selectedPlayerSeat: number;
  setSelectedPlayerSeat: (seat: number) => void;
  seats: Seat[];
  setSeats: React.Dispatch<React.SetStateAction<Seat[]>>;
  handNumber: number;
  street: string;
  dealerSeat: number;
  activeSkippedSeats: number[];
  boards: Board[];
  deck: Card[];
  tableCode: string;
  onLeaveTable: () => void;
}

export const PlayerView: React.FC<PlayerViewProps> = ({ 
  selectedPlayerSeat, 
  setSelectedPlayerSeat, 
  seats, 
  setSeats,
  handNumber, 
  street, 
  dealerSeat, 
  activeSkippedSeats,
  boards,
  deck,
  tableCode,
  onLeaveTable
}) => {
  const currentSeatObj = seats.find(s => s.seatNumber === selectedPlayerSeat);
  const player = currentSeatObj?.player;
  const isSkipped = activeSkippedSeats.includes(selectedPlayerSeat);
  const isFolded = currentSeatObj?.isFolded || false;

  const [isPeeking, setIsPeeking] = useState(false);
  const [peekMode, setPeekMode] = useState<'hold' | 'toggle'>('hold');
  const [rabbitCards, setRabbitCards] = useState<Card[]>([]);
  const [showRabbitModal, setShowRabbitModal] = useState(false);

  const handleHoldStart = () => {
    if (peekMode === 'hold' && !isFolded) {
      setIsPeeking(true);
      soundFx.playCardFlipSound();
    }
  };

  const handleHoldEnd = () => {
    if (peekMode === 'hold') {
      setIsPeeking(false);
    }
  };

  const handleTogglePeek = () => {
    if (peekMode === 'toggle' && !isFolded) {
      setIsPeeking(prev => {
        const next = !prev;
        if (next) soundFx.playCardFlipSound();
        return next;
      });
    }
  };

  const handleFoldHand = () => {
    setSeats(prev => prev.map(s => 
      s.seatNumber === selectedPlayerSeat ? { ...s, isFolded: true } : s
    ));
    setIsPeeking(false);
    soundFx.playFoldSound();
  };

  const handleUnfoldHand = () => {
    setSeats(prev => prev.map(s => 
      s.seatNumber === selectedPlayerSeat ? { ...s, isFolded: false } : s
    ));
    soundFx.playCardFlipSound();
  };

  const handleRabbitHunt = () => {
    if (!deck || deck.length === 0) return;
    const countToPeek = street === 'Preflop' ? 5 : street === 'Flop' ? 2 : street === 'Turn' ? 1 : 0;
    if (countToPeek === 0) return;

    const peeked = deck.slice(0, countToPeek);
    setRabbitCards(peeked);
    setShowRabbitModal(true);
  };

  return (
    <div id="player-view" className="min-h-screen bg-bg text-text flex flex-col justify-between p-4 max-w-md mx-auto select-none overflow-hidden relative font-sans">
      
      {/* Header bar */}
      <div className="flex items-center justify-between border-b border-line pb-3 z-10">
        <div className="flex items-center space-x-2">
          <div className="w-2 h-2 rounded-full bg-accent shadow-[0_0_8px_rgba(52,211,153,0.8)]"></div>
          <span className="text-[11px] uppercase tracking-widest text-text-muted font-extrabold">Player Hole Cards</span>
        </div>

        <div className="flex items-center gap-2">
          <div className="bg-surface border border-line px-2.5 py-1 rounded-xl text-[10px] font-mono text-accent-2 font-bold">
            {tableCode}
          </div>
          <button 
            id="btn-leave-table"
            onClick={onLeaveTable}
            className="text-text-muted hover:text-danger p-1 rounded-lg bg-surface border border-line cursor-pointer"
            title="Leave Table"
          >
            <LogOut className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Peek mode toggle */}
      <div className="mt-2 flex items-center justify-between text-[11px] bg-surface/80 border border-line py-1.5 px-3 rounded-xl backdrop-blur-md">
        <span className="text-text-muted font-medium">Card Peek Mode:</span>
        <div className="flex gap-1 bg-bg p-0.5 rounded-lg border border-line">
          <button
            id="btn-peek-mode-hold"
            onClick={() => { setPeekMode('hold'); setIsPeeking(false); }}
            className={`px-2.5 py-0.5 rounded text-[10px] font-bold transition-all cursor-pointer ${
              peekMode === 'hold' ? 'bg-accent-2 text-accent-contrast' : 'text-text-muted hover:text-text'
            }`}
          >
            Hold Mode
          </button>
          <button
            id="btn-peek-mode-toggle"
            onClick={() => { setPeekMode('toggle'); setIsPeeking(false); }}
            className={`px-2.5 py-0.5 rounded text-[10px] font-bold transition-all cursor-pointer ${
              peekMode === 'toggle' ? 'bg-accent-2 text-accent-contrast' : 'text-text-muted hover:text-text'
            }`}
          >
            Toggle
          </button>
        </div>
      </div>

      {/* Shared Mini Table Board */}
      <div className="mt-2 bg-surface/80 border border-line rounded-2xl p-3 shadow-xl backdrop-blur-md z-10">
        <div className="flex items-center justify-between border-b border-line pb-2 mb-2">
          <div className="flex items-center gap-1.5">
            <Compass className="w-3.5 h-3.5 text-accent-2" />
            <span className="text-[10px] font-bold uppercase tracking-widest text-text">Table Board Overview</span>
          </div>
          <span className="text-[10px] font-mono text-accent-2 bg-accent-2/10 border border-accent-2/30 px-2.5 py-0.5 rounded-full font-semibold">
            Street: {street}
          </span>
        </div>

        <div className="flex justify-center items-center gap-1.5 my-1">
          {boards[0]?.flop.length > 0 ? (
            boards[0].flop.map((c, i) => <PlayingCard key={i} card={c} size="sm" variant="community" />)
          ) : (
            <div className="w-8 h-12 border border-dashed border-line rounded flex items-center justify-center text-[9px] text-text-faint font-mono">Flop</div>
          )}
          {boards[0]?.turn ? (
            <PlayingCard card={boards[0].turn} size="sm" variant="community" />
          ) : (
            <div className="w-8 h-12 border border-dashed border-line rounded flex items-center justify-center text-[9px] text-text-faint font-mono">Turn</div>
          )}
          {boards[0]?.river ? (
            <PlayingCard card={boards[0].river} size="sm" variant="community" />
          ) : (
            <div className="w-8 h-12 border border-dashed border-line rounded flex items-center justify-center text-[9px] text-text-faint font-mono">River</div>
          )}
        </div>
      </div>

      {/* Main Hole Cards Arena */}
      <div className="my-auto flex flex-col items-center text-center py-2 z-10">
        {player ? (
          <>
            <div className="relative mb-2">
              <div className="w-14 h-14 rounded-full bg-gradient-to-tr from-accent-2 to-accent-2 p-0.5 shadow-xl overflow-hidden flex items-center justify-center">
                {player.avatarUrl ? (
                  <img src={player.avatarUrl} alt={player.name} className="w-full h-full object-cover rounded-full" />
                ) : (
                  <div className="w-full h-full bg-bg rounded-full flex items-center justify-center font-black text-lg text-accent-2">
                    {player.name.split(' ').map(n => n[0]).join('')}
                  </div>
                )}
              </div>
              {dealerSeat === selectedPlayerSeat && (
                <div className="absolute -bottom-1 -right-1 bg-accent-2 text-accent-contrast text-[10px] font-black w-5 h-5 rounded-full flex items-center justify-center border-2 border-bg shadow">
                  D
                </div>
              )}
            </div>

            <h2 className="text-lg font-bold tracking-tight text-text">{player.name}</h2>
            <p className="text-[11px] text-text-muted font-medium">Hand #{handNumber} • Seat {selectedPlayerSeat}</p>

            <div className="mt-2 flex flex-wrap gap-1.5 justify-center">
              {isSkipped && (
                <span className="bg-danger/80 text-danger border border-danger/60 text-[10px] font-semibold px-2.5 py-0.5 rounded-full flex items-center gap-1">
                  <AlertTriangle className="w-3 h-3" /> Skipped Hand (11-Player Rotation)
                </span>
              )}
              {isFolded && (
                <span className="bg-bg text-danger border border-danger/60 text-[10px] font-semibold px-3 py-0.5 rounded-full flex items-center gap-1 shadow">
                  <Flag className="w-3 h-3" /> HAND FOLDED
                </span>
              )}
            </div>

            {!isSkipped && !currentSeatObj?.isSatOut && currentSeatObj?.holeCards?.length === 2 ? (
              <div className="mt-2 w-full flex flex-col items-center">
                <div 
                  className="relative w-full h-56 border border-line rounded-3xl p-4 flex flex-col items-center justify-center shadow-2xl overflow-hidden my-1"
                  style={{ backgroundColor: '#0E5A43' }}
                >
                  <div className="absolute inset-3 border border-accent/15 rounded-[32px] pointer-events-none"></div>

                  <div 
                    onMouseDown={peekMode === 'hold' ? handleHoldStart : undefined}
                    onMouseUp={peekMode === 'hold' ? handleHoldEnd : undefined}
                    onMouseLeave={peekMode === 'hold' ? handleHoldEnd : undefined}
                    onTouchStart={peekMode === 'hold' ? handleHoldStart : undefined}
                    onTouchEnd={peekMode === 'hold' ? handleHoldEnd : undefined}
                    onTouchCancel={peekMode === 'hold' ? handleHoldEnd : undefined}
                    onClick={peekMode === 'toggle' ? handleTogglePeek : undefined}
                    className="relative flex items-center justify-center z-10 my-auto cursor-pointer touch-none select-none group"
                  >
                    <div className="transform -rotate-3 z-10 transition-all duration-200 group-active:scale-105">
                      <PlayingCard 
                        card={currentSeatObj.holeCards[0]} 
                        hidden={!isPeeking && !isFolded} 
                        size="xl" 
                        isFolded={isFolded} 
                        variant="player" 
                      />
                    </div>

                    <div className="transform rotate-3 -ml-12 z-20 transition-all duration-200 group-active:scale-105">
                      <PlayingCard 
                        card={currentSeatObj.holeCards[1]} 
                        hidden={!isPeeking && !isFolded} 
                        size="xl" 
                        isFolded={isFolded} 
                        variant="player" 
                      />
                    </div>

                    {!isPeeking && !isFolded && (
                      <div className="absolute inset-0 z-30 flex items-center justify-center pointer-events-none">
                        <div className="bg-bg/90 border border-accent-2/50 text-accent-2 text-[10px] font-bold px-3 py-1.5 rounded-full shadow-2xl backdrop-blur-sm flex items-center gap-1.5 animate-pulse">
                          <Eye className="w-3.5 h-3.5 text-accent-2" />
                          <span>{peekMode === 'hold' ? 'HOLD CARDS TO PEEK' : 'TAP CARDS TO PEEK'}</span>
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_40%,rgba(0,0,0,0.85)_100%)] pointer-events-none"></div>
                </div>

                {!isFolded && (
                  <div className="w-full max-w-xs my-2">
                    {peekMode === 'hold' ? (
                      <button
                        onMouseDown={handleHoldStart}
                        onMouseUp={handleHoldEnd}
                        onMouseLeave={handleHoldEnd}
                        onTouchStart={handleHoldStart}
                        onTouchEnd={handleHoldEnd}
                        onTouchCancel={handleHoldEnd}
                        className={`w-full py-3 px-4 rounded-xl font-bold text-xs flex items-center justify-center gap-2 border transition-all duration-150 select-none shadow-lg cursor-pointer ${
                          isPeeking
                            ? 'bg-accent-2 text-accent-contrast border-accent-2 shadow-[0_0_20px_rgba(226,183,85,0.4)] scale-98'
                            : 'bg-surface hover:bg-surface text-accent-2 border-accent-2/40 shadow-md'
                        }`}
                      >
                        {isPeeking ? <EyeOff className="w-4 h-4 animate-pulse" /> : <Eye className="w-4 h-4" />}
                        <span>{isPeeking ? 'REVEALING CARDS (HOLDING)' : 'PRESS & HOLD TO PEEK CARDS'}</span>
                      </button>
                    ) : (
                      <button
                        onClick={handleTogglePeek}
                        className={`w-full py-3 px-4 rounded-xl font-bold text-xs flex items-center justify-center gap-2 border transition-all duration-200 select-none shadow-lg cursor-pointer ${
                          isPeeking
                            ? 'bg-accent-2 text-accent-contrast border-accent-2 shadow-[0_0_20px_rgba(226,183,85,0.4)]'
                            : 'bg-surface hover:bg-surface text-accent-2 border-accent-2/40 shadow-md'
                        }`}
                      >
                        {isPeeking ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        <span>{isPeeking ? 'HIDE HOLE CARDS' : 'SHOW HOLE CARDS'}</span>
                      </button>
                    )}
                  </div>
                )}

                <div className="w-full max-w-xs flex gap-2">
                  {!isFolded ? (
                    <button
                      id="btn-fold-hand"
                      onClick={handleFoldHand}
                      className="w-full bg-surface hover:bg-surface-alt text-danger font-semibold py-2.5 px-4 rounded-xl shadow-lg flex items-center justify-center gap-2 active:scale-95 transition-all duration-200 cursor-pointer border border-danger/50 text-xs"
                    >
                      <Flag className="w-4 h-4" />
                      <span>FOLD HAND</span>
                    </button>
                  ) : (
                    <div className="flex gap-2 w-full">
                      <button
                        id="btn-unfold-hand"
                        onClick={handleUnfoldHand}
                        className="flex-1 bg-surface hover:bg-surface text-text font-medium py-2 px-3 rounded-xl text-xs flex items-center justify-center gap-1 border border-line transition-all cursor-pointer"
                      >
                        <RefreshCw className="w-3.5 h-3.5" /> Re-open
                      </button>

                      {street !== 'River' && (
                        <button
                          id="btn-rabbit-hunt"
                          onClick={handleRabbitHunt}
                          className="flex-1 bg-accent-2/10 hover:bg-accent-2/20 text-accent-2 font-bold py-2 px-3 rounded-xl text-xs flex items-center justify-center gap-1.5 border border-accent-2/40 transition-all cursor-pointer shadow-[0_0_10px_rgba(226,183,85,0.2)]"
                        >
                          <Rabbit className="w-4 h-4" /> Rabbit Hunt
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="mt-6 p-6 bg-surface/60 border border-line rounded-2xl text-text-muted text-xs backdrop-blur-md">
                Waiting for host to deal next hand...
              </div>
            )}
          </>
        ) : (
          <div className="py-10">
            <UserX className="w-12 h-12 text-line mx-auto mb-3" />
            <h3 className="text-base font-bold text-text">Seat {selectedPlayerSeat} Unassigned</h3>
            <p className="text-xs text-text-muted mt-1">Ask Table Host to assign your display name to this seat.</p>
          </div>
        )}
      </div>

      {showRabbitModal && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-surface border border-accent-2/40 rounded-2xl p-5 max-w-sm w-full text-center shadow-2xl space-y-4">
            <div className="flex items-center justify-center gap-2 text-accent-2 font-bold text-base">
              <Rabbit className="w-5 h-5" /> Rabbit Hunt
            </div>
            <p className="text-xs text-text-muted">
              Here are the upcoming cards from the deck that would have been dealt:
            </p>

            <div className="flex justify-center gap-2 my-4">
              {rabbitCards.map((card, i) => (
                <PlayingCard key={i} card={card} size="md" variant="community" />
              ))}
            </div>

            <button
              onClick={() => setShowRabbitModal(false)}
              className="w-full bg-accent-2 hover:bg-accent-2 text-accent-contrast font-bold py-2 rounded-xl text-xs transition-all cursor-pointer"
            >
              Close Rabbit Hunt
            </button>
          </div>
        </div>
      )}

      <div className="border-t border-line/80 pt-2 text-center text-[10px] text-text-faint flex items-center justify-center gap-1 z-10">
        <Shield className="w-3.5 h-3.5 text-accent-2" /> The House Keeps Score • Private Room Companion
      </div>
    </div>
  );
};
