import React, { useState } from 'react';
import { 
  Crown, Users, LogOut, GripVertical, RefreshCw, 
  Play, RotateCcw, ArrowRight, Sparkles, Copy, Check,
  UserCheck
} from 'lucide-react';
import { Seat, Board, Card, ToastMessage } from '../types';
import { PlayingCard } from './PlayingCard';
import { ToastContainer } from './ToastContainer';

interface MergedHostDisplayViewProps {
  handNumber: number;
  street: string;
  runCount: number;
  deck: Card[];
  boards: Board[];
  seats: Seat[];
  setSeats: React.Dispatch<React.SetStateAction<Seat[]>>;
  dealerSeat: number;
  setDealerSeat: React.Dispatch<React.SetStateAction<number>>;
  activeSkippedSeats: number[];
  handleStartNewHand: (shouldAdvanceDealer?: boolean) => void;
  handleRevealFlop: () => void;
  handleRevealTurn: () => void;
  handleRevealRiver: () => void;
  handleRunRemainingBoard: () => void;
  handleSetRunMode: (runs: number) => void;
  handleEndHandAndRotateDealer: () => void;
  tableCode: string;
  onLeaveTable: () => void;
  isGameStarted: boolean;
  handleStartGame: () => void;
  toasts: ToastMessage[];
  onDismissToast: (id: string) => void;
}

export const MergedHostDisplayView: React.FC<MergedHostDisplayViewProps> = ({
  handNumber,
  street,
  runCount,
  boards,
  seats,
  setSeats,
  dealerSeat,
  setDealerSeat,
  activeSkippedSeats,
  handleStartNewHand,
  handleRevealFlop,
  handleRevealTurn,
  handleRevealRiver,
  handleRunRemainingBoard,
  handleSetRunMode,
  handleEndHandAndRotateDealer,
  tableCode,
  onLeaveTable,
  isGameStarted,
  handleStartGame,
  toasts,
  onDismissToast
}) => {
  const [draggedSeat, setDraggedSeat] = useState<number | null>(null);
  const [dragOverSeat, setDragOverSeat] = useState<number | null>(null);
  const [showSeatDrawer, setShowSeatDrawer] = useState(false);
  const [newPlayerName, setNewPlayerName] = useState('');
  const [assignTargetSeat, setAssignTargetSeat] = useState(1);
  const [copiedCode, setCopiedCode] = useState(false);

  const occupiedCount = seats.filter(s => s.player).length;

  const handleCopyCode = () => {
    navigator.clipboard.writeText(tableCode);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2000);
  };

  const handleSwapSeats = (fromSeatNum: number, toSeatNum: number) => {
    if (!fromSeatNum || !toSeatNum || fromSeatNum === toSeatNum) return;
    setSeats(prev => {
      const updated = prev.map(s => ({ ...s }));
      const fromObj = updated.find(s => s.seatNumber === fromSeatNum);
      const toObj = updated.find(s => s.seatNumber === toSeatNum);
      if (fromObj && toObj) {
        const tempPlayer = fromObj.player;
        const tempSatOut = fromObj.isSatOut;
        fromObj.player = toObj.player;
        fromObj.isSatOut = toObj.isSatOut;
        toObj.player = tempPlayer;
        toObj.isSatOut = tempSatOut;
      }
      return updated;
    });
  };

  const handleDragStart = (e: React.DragEvent<HTMLDivElement>, seatNumber: number) => {
    setDraggedSeat(seatNumber);
    e.dataTransfer.setData('text/plain', seatNumber.toString());
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>, seatNumber: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragOverSeat !== seatNumber) {
      setDragOverSeat(seatNumber);
    }
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setDragOverSeat(null);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>, targetSeatNumber: number) => {
    e.preventDefault();
    if (draggedSeat !== null && draggedSeat !== targetSeatNumber) {
      handleSwapSeats(draggedSeat, targetSeatNumber);
    }
    setDraggedSeat(null);
    setDragOverSeat(null);
  };

  return (
    <div id="host-display-view" className="min-h-screen bg-gradient-to-b from-surface via-bg to-bg text-text p-3 md:p-6 flex flex-col justify-between font-sans select-none relative overflow-x-hidden">
      
      {/* Real-time Toast Alerts */}
      <ToastContainer toasts={toasts} onDismiss={onDismissToast} />

      {/* Top Header Controls Bar */}
      <div className="flex flex-wrap items-center justify-between border-b border-line/80 pb-3 gap-3 z-20">
        <div className="flex items-center gap-3">
          <div className="w-2.5 h-2.5 rounded-full bg-accent shadow-[0_0_8px_rgba(52,211,153,0.8)] animate-pulse"></div>
          <div>
            <div className="flex items-center gap-2">
              <Crown className="w-4 h-4 text-accent-2" />
              <h1 className="text-base md:text-xl font-black tracking-tight text-text uppercase">
                THE HOUSE KEEPS SCORE
              </h1>
              <button
                onClick={handleCopyCode}
                className="bg-accent-2/10 hover:bg-accent-2/20 text-accent-2 border border-accent-2/40 text-[11px] font-mono px-2.5 py-0.5 rounded-full font-bold flex items-center gap-1 cursor-pointer transition-all"
                title="Click to copy room code"
              >
                <span>CODE: {tableCode}</span>
                {copiedCode ? <Check className="w-3 h-3 text-accent" /> : <Copy className="w-3 h-3" />}
              </button>
            </div>
            <p className="text-[10px] text-text-muted font-medium hidden sm:block">Unified iPad Display & Digital Dealer Control Center</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {!isGameStarted ? (
            <div className="bg-surface border border-line-strong px-3 py-1 rounded-xl flex items-center gap-1.5 text-xs text-accent-2 font-bold">
              <Sparkles className="w-3.5 h-3.5" /> WAITING ROOM
            </div>
          ) : (
            <>
              <div className="bg-surface border border-line px-3 py-1 rounded-xl text-right">
                <div className="text-[9px] text-text-muted uppercase tracking-wider font-semibold">Hand</div>
                <div className="text-sm font-black text-accent-2">#{handNumber}</div>
              </div>

              <div className="bg-surface border border-line px-3 py-1 rounded-xl text-right">
                <div className="text-[9px] text-text-muted uppercase tracking-wider font-semibold">Street</div>
                <div className="text-sm font-black text-accent">{street}</div>
              </div>
            </>
          )}

          <button
            id="btn-manage-seats"
            onClick={() => setShowSeatDrawer(prev => !prev)}
            className="bg-surface hover:bg-surface text-accent-2 font-bold px-3 py-2 rounded-xl text-xs border border-line flex items-center gap-1.5 transition-all cursor-pointer"
          >
            <Users className="w-4 h-4" />
            <span className="hidden md:inline">Manage Seats ({occupiedCount}/11)</span>
          </button>

          <button
            id="btn-exit-table"
            onClick={onLeaveTable}
            className="bg-surface hover:bg-surface-alt text-text-muted p-2 rounded-xl border border-line transition-all cursor-pointer"
            title="Exit Table"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Main Oval Table Arena */}
      <div className="my-auto relative w-full max-w-6xl mx-auto py-4">
        <div 
          className="w-full h-[380px] sm:h-[460px] md:h-[500px] rounded-[180px] sm:rounded-[220px] border-[14px] sm:border-[18px] border-bg shadow-[0_0_90px_rgba(0,0,0,0.9)] relative flex items-center justify-center transition-all duration-300"
          style={{ backgroundColor: '#0E5A43' }}
        >
          {/* Table felt interior ring line */}
          <div className="absolute inset-4 rounded-[160px] sm:rounded-[200px] border border-accent/20 pointer-events-none flex flex-col items-center justify-center text-center p-4">
            <div className="text-accent/10 font-black text-3xl sm:text-5xl tracking-widest uppercase select-none pointer-events-none">
              Texas Hold'em
            </div>
            <div className="text-[10px] font-mono text-accent/20 uppercase tracking-widest mt-1">
              Drag player nodes on felt to swap seats
            </div>
          </div>

          {/* Central Community Boards or Waiting Banner */}
          <div className="z-20 flex flex-col items-center gap-3 my-auto max-w-4xl px-2 text-center">
            {!isGameStarted ? (
              <div className="bg-bg/95 border border-accent-2/50 p-6 rounded-3xl shadow-2xl backdrop-blur-md max-w-md space-y-3 animate-fade-in">
                <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-surface border border-line-strong text-accent-2 text-xs font-bold uppercase tracking-wider">
                  <UserCheck className="w-4 h-4" /> Waiting Room Active
                </div>
                <h3 className="text-lg font-black text-text uppercase tracking-tight">
                  Waiting For Players To Join
                </h3>
                <p className="text-xs text-text-muted leading-relaxed">
                  Players can join on their mobile devices using Room Code <span className="text-accent-2 font-mono font-bold">{tableCode}</span>.
                  Joined players will automatically be assigned to open seats and trigger a toast notification.
                </p>

                <div className="flex items-center justify-center gap-2 pt-1">
                  <button
                    onClick={handleCopyCode}
                    className="bg-surface hover:bg-surface text-accent-2 font-bold text-xs py-2 px-4 rounded-xl border border-line flex items-center gap-1.5 cursor-pointer"
                  >
                    {copiedCode ? <Check className="w-4 h-4 text-accent" /> : <Copy className="w-4 h-4" />}
                    <span>{copiedCode ? 'Room Code Copied!' : 'Copy Room Code'}</span>
                  </button>
                </div>
              </div>
            ) : (
              boards.map((b, idx) => (
                <div key={b.id} className="bg-bg/90 border border-accent-2/30 px-4 sm:px-6 py-3 rounded-2xl shadow-2xl flex flex-col items-center gap-1.5 backdrop-blur-md">
                  {boards.length > 1 && (
                    <span className="text-[10px] font-bold text-accent-2 uppercase tracking-widest">
                      Run #{idx + 1}
                    </span>
                  )}
                  
                  <div className="flex gap-2">
                    {b.flop.length === 3 ? (
                      b.flop.map((card, cIdx) => (
                        <PlayingCard key={cIdx} card={card} size="md" variant="community" />
                      ))
                    ) : (
                      <>
                        <PlayingCard hidden size="md" variant="community" />
                        <PlayingCard hidden size="md" variant="community" />
                        <PlayingCard hidden size="md" variant="community" />
                      </>
                    )}

                    {b.turn ? (
                      <PlayingCard card={b.turn} size="md" variant="community" />
                    ) : (
                      <PlayingCard hidden size="md" variant="community" />
                    )}

                    {b.river ? (
                      <PlayingCard card={b.river} size="md" variant="community" />
                    ) : (
                      <PlayingCard hidden size="md" variant="community" />
                    )}
                  </div>
                </div>
              ))
            )}
          </div>

          {/* 11 Trigonometrically Placed Interactive Oval Seats */}
          {seats.map((seat, index) => {
            const angle = (index / seats.length) * 2 * Math.PI - Math.PI / 2;
            const rx = 44; // horizontal radius %
            const ry = 42; // vertical radius %
            const left = 50 + rx * Math.cos(angle);
            const top = 50 + ry * Math.sin(angle);

            const isDealer = dealerSeat === seat.seatNumber;
            const isSkipped = activeSkippedSeats.includes(seat.seatNumber);
            const isBeingDragged = draggedSeat === seat.seatNumber;
            const isTarget = dragOverSeat === seat.seatNumber;

            return (
              <div 
                key={seat.seatNumber}
                style={{ left: `${left}%`, top: `${top}%` }}
                draggable={!!seat.player}
                onDragStart={(e) => handleDragStart(e, seat.seatNumber)}
                onDragOver={(e) => handleDragOver(e, seat.seatNumber)}
                onDragLeave={handleDragLeave}
                onDrop={(e) => handleDrop(e, seat.seatNumber)}
                className="absolute transform -translate-x-1/2 -translate-y-1/2 z-30 transition-all duration-200"
              >
                <div className={`w-20 sm:w-26 p-1.5 rounded-xl border text-center transition-all duration-200 backdrop-blur-md shadow-2xl relative ${
                  isBeingDragged 
                    ? 'opacity-40 border-dashed border-accent-2 bg-accent-2/20 scale-95' 
                    : isTarget 
                    ? 'border-accent-2 bg-accent-2/30 scale-110 shadow-[0_0_20px_rgba(226,183,85,0.6)]' 
                    : isSkipped
                    ? 'bg-danger/80 border-danger/60 opacity-60'
                    : seat.isFolded
                    ? 'bg-bg/80 border-line opacity-60'
                    : seat.player 
                    ? 'bg-bg/95 border-accent-2/50 hover:border-accent-2' 
                    : 'bg-bg/40 border-line/60'
                }`}>
                  {isDealer && (
                    <button
                      onClick={() => setDealerSeat(seat.seatNumber)}
                      className="absolute -top-2 -right-1.5 bg-accent-2 text-accent-contrast text-[9px] font-black w-5 h-5 rounded-full flex items-center justify-center shadow-md border border-accent-2 cursor-pointer"
                      title="Dealer Button"
                    >
                      D
                    </button>
                  )}

                  {!isDealer && seat.player && (
                    <button
                      onClick={() => setDealerSeat(seat.seatNumber)}
                      className="absolute -top-2 -right-1.5 bg-surface hover:bg-accent-2 text-text-muted hover:text-accent-contrast text-[8px] font-bold px-1 py-0.5 rounded-full border border-line-strong cursor-pointer transition-all"
                      title="Set as Dealer"
                    >
                      +D
                    </button>
                  )}

                  <div className="flex items-center justify-between text-[8px] font-mono text-text-muted mb-0.5 px-0.5">
                    <span>S{seat.seatNumber}</span>
                    {seat.player && <GripVertical className="w-2.5 h-2.5 text-text-faint" />}
                  </div>

                  {seat.player?.avatarUrl && (
                    <img src={seat.player.avatarUrl} alt="Avatar" className="w-5 h-5 rounded-full mx-auto border border-accent-2 object-cover my-0.5" />
                  )}

                  <div className="text-[10px] sm:text-xs font-bold text-text truncate px-0.5">
                    {seat.player ? seat.player.name : <span className="text-text-faint font-normal italic">Vacant</span>}
                  </div>

                  <div className="mt-0.5 flex flex-wrap gap-0.5 justify-center">
                    {isSkipped && (
                      <span className="text-[7px] font-bold bg-danger/15 text-danger px-1 py-0.2 rounded">
                        SKIPPED
                      </span>
                    )}
                    {seat.isFolded && (
                      <span className="text-[7px] font-bold bg-bg text-text-muted px-1 py-0.2 rounded border border-line">
                        FOLDED
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Strategic Bottom Control Dock */}
      <div className="bg-surface/90 border border-line p-3 sm:p-4 rounded-2xl shadow-2xl backdrop-blur-md max-w-5xl mx-auto w-full space-y-3 z-20">
        
        {!isGameStarted ? (
          <div className="flex flex-col items-center justify-center text-center space-y-2.5 py-2">
            <button
              id="btn-start-game-main"
              onClick={handleStartGame}
              disabled={occupiedCount < 2}
              className="w-full max-w-md bg-accent-2 hover:bg-accent-2 disabled:bg-surface-alt disabled:text-text-faint disabled:border disabled:border-line-strong disabled:shadow-none text-accent-contrast font-black py-4 px-8 rounded-2xl text-sm md:text-base tracking-widest uppercase shadow-[0_0_30px_rgba(226,183,85,0.4)] transition-all duration-200 cursor-pointer disabled:cursor-not-allowed flex items-center justify-center gap-3 active:scale-98"
            >
              <Play className="w-6 h-6 fill-current" /> START GAME & DEAL HAND (#{handNumber})
            </button>
            {occupiedCount < 2 ? (
              <p className="text-xs text-danger font-bold bg-danger/60 border border-danger/80 px-3 py-1 rounded-full animate-pulse">
                ⚠️ At least 2 seated players are required to start the game ({occupiedCount}/11 seated)
              </p>
            ) : (
              <p className="text-[11px] text-text-muted">
                Current seated players: <span className="text-accent-2 font-bold">{occupiedCount}/11 Players</span>. Dealer: <span className="text-text font-bold">Seat {dealerSeat}</span>
              </p>
            )}
          </div>
        ) : (
          <>
            {/* Deal Actions Bar */}
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
              <button
                id="btn-fresh-hand"
                onClick={() => handleStartNewHand(true)}
                className="bg-accent/40 hover:bg-accent/50 text-text font-extrabold p-2.5 rounded-xl text-xs flex items-center justify-center gap-1.5 border border-accent/40 cursor-pointer shadow transition-all"
              >
                <RefreshCw className="w-3.5 h-3.5" /> Start Fresh Hand
              </button>

              <button
                id="btn-reveal-flop"
                disabled={street !== 'Preflop'}
                onClick={handleRevealFlop}
                className="bg-bg hover:bg-surface-alt disabled:opacity-30 text-text font-bold p-2.5 rounded-xl text-xs flex items-center justify-center gap-1.5 border border-line cursor-pointer transition-all"
              >
                <Play className="w-3.5 h-3.5 text-accent-2" /> Flop (3)
              </button>

              <button
                id="btn-reveal-turn"
                disabled={street !== 'Flop'}
                onClick={handleRevealTurn}
                className="bg-bg hover:bg-surface-alt disabled:opacity-30 text-text font-bold p-2.5 rounded-xl text-xs flex items-center justify-center gap-1.5 border border-line cursor-pointer transition-all"
              >
                <Play className="w-3.5 h-3.5 text-accent-2" /> Turn (1)
              </button>

              <button
                id="btn-reveal-river"
                disabled={street !== 'Turn'}
                onClick={handleRevealRiver}
                className="bg-bg hover:bg-surface-alt disabled:opacity-30 text-text font-bold p-2.5 rounded-xl text-xs flex items-center justify-center gap-1.5 border border-line cursor-pointer transition-all"
              >
                <Play className="w-3.5 h-3.5 text-accent-2" /> River (1)
              </button>

              <button
                id="btn-next-dealer"
                onClick={handleEndHandAndRotateDealer}
                className="bg-accent-2 hover:bg-accent-2 text-accent-contrast font-black p-2.5 rounded-xl text-xs flex items-center justify-center gap-1.5 shadow-[0_0_15px_rgba(226,183,85,0.2)] cursor-pointer transition-all col-span-2 sm:col-span-1"
              >
                <RotateCcw className="w-3.5 h-3.5" /> Next Dealer
              </button>
            </div>

            {/* Secondary Bar: Run-It-Twice/Thrice & Quick Board Run */}
            <div className="flex flex-wrap items-center justify-between border-t border-line/60 pt-2.5 gap-2 text-xs">
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-bold text-text-muted uppercase tracking-wider">Multi-Board Run:</span>
                <div className="flex gap-1">
                  {[1, 2, 3].map(num => (
                    <button
                      key={num}
                      id={`btn-run-mode-${num}`}
                      onClick={() => handleSetRunMode(num)}
                      className={`px-3 py-1 rounded-lg text-xs font-bold border transition-all cursor-pointer ${
                        runCount === num 
                          ? 'bg-accent-2 text-accent-contrast border-accent-2' 
                          : 'bg-bg text-text border-line'
                      }`}
                    >
                      Run {num}x
                    </button>
                  ))}
                </div>
              </div>

              <button
                id="btn-run-remaining-board"
                onClick={handleRunRemainingBoard}
                className="bg-bg hover:bg-surface-alt text-accent-2 font-bold px-3 py-1 rounded-lg text-xs border border-accent-2/40 flex items-center gap-1 cursor-pointer"
              >
                <ArrowRight className="w-3.5 h-3.5" /> Run Remaining Board
              </button>
            </div>
          </>
        )}
      </div>

      {/* Seat Management Drawer Overlay */}
      {showSeatDrawer && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-surface border border-line p-5 rounded-3xl max-w-xl w-full shadow-2xl space-y-4 max-h-[85vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-line pb-3">
              <div className="flex items-center gap-2">
                <Users className="w-5 h-5 text-accent-2" />
                <h3 className="font-extrabold text-text uppercase tracking-wide">Detailed Seat Controls</h3>
              </div>
              <button onClick={() => setShowSeatDrawer(false)} className="text-xs text-text-muted hover:text-text cursor-pointer">
                Close
              </button>
            </div>

            {/* Quick Player Assign */}
            <div className="bg-bg p-3 rounded-2xl border border-line space-y-2">
              <span className="text-xs font-bold text-accent-2 uppercase">Assign Player to Vacant Seat</span>
              <div className="flex gap-2">
                <input
                  id="input-assign-name"
                  type="text"
                  placeholder="Player Name"
                  value={newPlayerName}
                  onChange={(e) => setNewPlayerName(e.target.value)}
                  className="flex-1 bg-surface border border-line rounded-xl px-3 py-1.5 text-xs text-text outline-none"
                />
                <select
                  id="select-assign-seat"
                  value={assignTargetSeat}
                  onChange={(e) => setAssignTargetSeat(Number(e.target.value))}
                  className="bg-surface border border-line rounded-xl px-2 py-1.5 text-xs text-text outline-none cursor-pointer"
                >
                  {seats.map(s => (
                    <option key={s.seatNumber} value={s.seatNumber}>
                      Seat {s.seatNumber} {s.player ? `(${s.player.name})` : '(Vacant)'}
                    </option>
                  ))}
                </select>
                <button
                  id="btn-assign-player"
                  onClick={() => {
                    if (!newPlayerName) return;
                    setSeats(prev => prev.map(s => s.seatNumber === assignTargetSeat ? {
                      ...s,
                      player: { id: `p-${Date.now()}`, name: newPlayerName, isConnected: true }
                    } : s));
                    setNewPlayerName('');
                  }}
                  className="bg-accent-2 text-accent-contrast font-bold px-3 py-1.5 rounded-xl text-xs cursor-pointer"
                >
                  Assign
                </button>
              </div>
            </div>

            {/* Seat List Rows */}
            <div className="divide-y divide-line">
              {seats.map(seat => (
                <div key={seat.seatNumber} className="py-2.5 flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2">
                    <span className="w-5 h-5 rounded-full bg-bg border border-line text-accent-2 font-bold flex items-center justify-center text-[10px]">
                      {seat.seatNumber}
                    </span>
                    <span className="font-bold text-text">
                      {seat.player ? seat.player.name : <span className="text-text-faint italic">Vacant</span>}
                    </span>
                    {dealerSeat === seat.seatNumber && <span className="text-[9px] bg-accent-2 text-accent-contrast px-1.5 rounded font-black">DEALER</span>}
                  </div>

                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => setDealerSeat(seat.seatNumber)}
                      className="px-2 py-1 rounded text-[10px] bg-bg border border-line text-text cursor-pointer"
                    >
                      Make Dealer
                    </button>
                    {seat.player && (
                      <button
                        onClick={() => setSeats(prev => prev.map(s => s.seatNumber === seat.seatNumber ? { ...s, player: null } : s))}
                        className="px-2 py-1 rounded text-[10px] bg-danger/15 text-danger border border-danger/40 cursor-pointer"
                      >
                        Vacate
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
