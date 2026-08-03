import React, { useState } from 'react';
import { Crown, Shield, Sparkles, Users, ArrowLeft, AlertTriangle, UserCheck } from 'lucide-react';
import { Seat } from '../types';
import { AppUser as User } from '../lib/auth-types';

interface LobbyViewProps {
  onCreateTable: (hostName: string) => void;
  onJoinTable: (code: string, name: string, seatNumber: number) => void;
  tableCodeInput: string;
  setTableCodeInput: (code: string) => void;
  playerNameInput: string;
  setPlayerNameInput: (name: string) => void;
  selectedJoinSeat: number;
  setSelectedJoinSeat: (seat: number) => void;
  seats: Seat[];
  errorMessage: string;
  onOpenRegister?: () => void;
  currentUser?: User | null;
  playerAvatarUrl?: string;
}

export const LobbyView: React.FC<LobbyViewProps> = ({ 
  onCreateTable, 
  onJoinTable, 
  tableCodeInput, 
  setTableCodeInput,
  playerNameInput,
  setPlayerNameInput,
  selectedJoinSeat,
  setSelectedJoinSeat,
  seats,
  errorMessage,
  onOpenRegister,
  currentUser,
  playerAvatarUrl
}) => {
  const [activeTab, setActiveTab] = useState<'landing' | 'create' | 'join'>('landing');

  const occupiedCount = seats.filter(s => s.player).length;

  return (
    <div id="lobby-view" className="min-h-screen bg-gradient-to-b from-surface via-bg to-bg text-text flex flex-col justify-between p-4 md:p-8 font-sans selection:bg-accent-2 selection:text-accent-contrast">
      
      {/* Top Header */}
      <div className="max-w-6xl mx-auto w-full flex justify-between items-center py-3 border-b border-line/40">
        <div className="flex items-center gap-2">
          <Crown className="w-5 h-5 text-accent-2" />
          <span className="font-extrabold text-xs md:text-sm tracking-[0.25em] text-accent-2 uppercase">
            POKER DAD · 2026
          </span>
        </div>

        <div className="flex items-center gap-2">
          {currentUser && onOpenRegister && (
            <button
              onClick={onOpenRegister}
              className="text-xs font-bold text-accent-contrast bg-accent-2 hover:bg-accent-2 px-3.5 py-1.5 rounded-full transition-all cursor-pointer flex items-center gap-1.5 shadow"
            >
              <Users className="w-3.5 h-3.5 text-accent-contrast" /> My Clubs Dashboard
            </button>
          )}

          {onOpenRegister && (
            currentUser ? (
              <button
                onClick={onOpenRegister}
                className="text-xs font-bold text-accent-2 bg-surface hover:bg-surface-alt border border-line-strong pl-1.5 pr-3.5 py-1 rounded-full transition-all cursor-pointer flex items-center gap-2"
              >
                {playerAvatarUrl ? (
                  <img src={playerAvatarUrl} alt="Avatar" className="w-6 h-6 rounded-full object-cover border border-accent-2" />
                ) : (
                  <div className="w-6 h-6 rounded-full bg-accent-2 text-accent-contrast font-bold flex items-center justify-center text-[10px]">
                    {(currentUser.displayName || currentUser.email || currentUser.phoneNumber || 'P')[0].toUpperCase()}
                  </div>
                )}
                <span className="truncate max-w-[120px]">{currentUser.displayName || playerNameInput || 'Account'}</span>
              </button>
            ) : (
              <button
                onClick={onOpenRegister}
                className="text-xs font-bold text-accent-2 bg-surface hover:bg-surface-alt border border-line-strong px-3.5 py-1.5 rounded-full transition-all cursor-pointer flex items-center gap-1.5"
              >
                <Users className="w-3.5 h-3.5 text-accent-2" /> Account / Register
              </button>
            )
          )}

          <div className="text-[11px] text-text-muted font-medium tracking-wide hidden sm:flex items-center gap-1.5 bg-surface/80 border border-line px-3 py-1.5 rounded-full">
            <Shield className="w-3.5 h-3.5 text-accent-2" /> Private Room Digital Dealer
          </div>
        </div>
      </div>

      {/* Main Hero Content */}
      <div className="max-w-4xl mx-auto w-full my-auto py-8 text-center space-y-8">
        {activeTab === 'landing' && (
          <div className="space-y-6 animate-fade-in">
            <div className="inline-flex items-center gap-2 px-3.5 py-1 rounded-full bg-surface-alt/80 border border-line-strong text-accent-2 text-xs font-semibold tracking-wider uppercase">
              <Sparkles className="w-3.5 h-3.5" /> High Stakes Home Game Suite
            </div>

            <h1 className="text-4xl md:text-6xl font-black tracking-tight text-text uppercase leading-none">
              THE HOUSE <br className="hidden md:inline" />
              <span className="text-accent-2">KEEPS SCORE</span>
            </h1>

            <p className="max-w-2xl mx-auto text-xs md:text-sm text-text-muted leading-relaxed font-normal">
              Request banks, get them approved in seconds, and watch the night's standings move in real time. 
              Cryptographically secure cards, zero physical dealing, up to 11 players.
            </p>

            {/* Action Buttons */}
            <div className="max-w-md mx-auto space-y-3 pt-2">
              <button
                id="btn-create-table-tab"
                onClick={() => setActiveTab('create')}
                className="w-full bg-accent-2 hover:bg-accent-2 text-accent-contrast font-black py-4 px-6 rounded-2xl text-sm tracking-wider uppercase shadow-[0_0_25px_rgba(226,183,85,0.3)] transition-all duration-200 cursor-pointer flex items-center justify-center gap-2 active:scale-98"
              >
                <Crown className="w-5 h-5" /> CREATE A TABLE (HOST / ADMIN)
              </button>

              <button
                id="btn-join-table-tab"
                onClick={() => setActiveTab('join')}
                className="w-full bg-surface hover:bg-surface-alt text-text font-bold py-3.5 px-6 rounded-2xl text-xs tracking-wider uppercase border border-line-strong transition-all duration-200 cursor-pointer flex items-center justify-center gap-2"
              >
                <Users className="w-4 h-4 text-accent-2" /> JOIN A TABLE (PLAYER)
              </button>
            </div>
            <div className="flex items-center justify-center gap-2 pt-1">
              {currentUser ? (
                <div className="flex items-center gap-2 text-xs text-text-muted">
                  <span className="w-2 h-2 rounded-full bg-accent animate-pulse"></span>
                  <span>Signed in as <strong className="text-text">{currentUser.displayName || playerNameInput || currentUser.email || currentUser.phoneNumber}</strong></span>
                  {onOpenRegister && (
                    <button
                      onClick={onOpenRegister}
                      className="text-accent-2 hover:underline font-bold ml-1 cursor-pointer"
                    >
                      (Account & Avatar)
                    </button>
                  )}
                </div>
              ) : (
                <>
                  <span className="text-[11px] text-text-faint">Members only.</span>
                  {onOpenRegister && (
                    <button
                      onClick={onOpenRegister}
                      className="text-[11px] font-bold text-accent-2 hover:underline cursor-pointer"
                    >
                      Create Account / Sign In with Google, Phone or Email →
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        )}

        {/* Create Table Form */}
        {activeTab === 'create' && (
          <div className="max-w-md mx-auto bg-surface/95 border border-line p-6 rounded-3xl shadow-2xl text-left space-y-5 backdrop-blur-md animate-fade-in">
            <div className="flex items-center justify-between border-b border-line pb-3">
              <div className="flex items-center gap-2">
                <Crown className="w-5 h-5 text-accent-2" />
                <h2 className="text-lg font-bold text-text uppercase tracking-wide">Create Host Display</h2>
              </div>
              <button onClick={() => setActiveTab('landing')} className="text-xs text-text-muted hover:text-text cursor-pointer">
                <ArrowLeft className="w-4 h-4" />
              </button>
            </div>

            <div className="bg-bg border border-line p-4 rounded-xl text-xs text-text-muted space-y-2">
              <div className="text-accent-2 font-bold flex items-center gap-1.5 uppercase tracking-wider text-[11px]">
                <Shield className="w-4 h-4 text-accent-2" /> Digital Dealer & Admin Display
              </div>
              <p className="text-text leading-relaxed">
                As the Host, this screen acts as the table central board and dealer admin. You will display community cards, manage player seats, set the dealer button, and control dealing.
              </p>
              <p className="text-text-muted italic text-[11px]">
                Note: The host does not occupy a seat or get dealt cards.
              </p>
            </div>

            <button
              id="btn-launch-table"
              onClick={() => onCreateTable('Digital Dealer')}
              className="w-full bg-accent-2 hover:bg-accent-2 text-accent-contrast font-extrabold py-4 rounded-xl text-xs uppercase tracking-widest shadow-[0_0_20px_rgba(226,183,85,0.3)] transition-all cursor-pointer flex items-center justify-center gap-2"
            >
              <Crown className="w-4 h-4" /> LAUNCH HOST DISPLAY & GENERATE ROOM CODE
            </button>
          </div>
        )}

        {/* Join Table Form */}
        {activeTab === 'join' && (
          <div className="max-w-md mx-auto bg-surface/95 border border-line p-6 rounded-3xl shadow-2xl text-left space-y-5 backdrop-blur-md animate-fade-in">
            <div className="flex items-center justify-between border-b border-line pb-3">
              <div className="flex items-center gap-2">
                <Users className="w-5 h-5 text-accent-2" />
                <h2 className="text-lg font-bold text-text uppercase tracking-wide">Join Private Table</h2>
              </div>
              <button onClick={() => setActiveTab('landing')} className="text-xs text-text-muted hover:text-text cursor-pointer">
                <ArrowLeft className="w-4 h-4" />
              </button>
            </div>

            {errorMessage && (
              <div className="bg-danger/80 border border-danger/40 text-danger text-xs p-3 rounded-xl flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                <span>{errorMessage}</span>
              </div>
            )}

            <div className="space-y-4">
              <div>
                <label className="text-xs font-semibold text-text-muted uppercase tracking-wider block mb-1">Table Code</label>
                <input
                  id="input-table-code"
                  type="text"
                  placeholder="e.g. 7742"
                  value={tableCodeInput}
                  onChange={(e) => setTableCodeInput(e.target.value.toUpperCase())}
                  className="w-full bg-bg border border-line rounded-xl px-4 py-3 text-sm text-accent-2 font-mono font-bold tracking-widest uppercase focus:border-accent-2 outline-none"
                />
              </div>

              <div>
                <label className="text-xs font-semibold text-text-muted uppercase tracking-wider block mb-1">Your Player Name</label>
                <input
                  id="input-player-name"
                  type="text"
                  placeholder="e.g. Daniel N."
                  value={playerNameInput}
                  onChange={(e) => setPlayerNameInput(e.target.value)}
                  className="w-full bg-bg border border-line rounded-xl px-4 py-3 text-sm text-text font-bold focus:border-accent-2 outline-none"
                />
              </div>

              <div>
                <label className="text-xs font-semibold text-text-muted uppercase tracking-wider block mb-1">Select Seat (Max 11 Players)</label>
                <select
                  id="select-join-seat"
                  value={selectedJoinSeat}
                  onChange={(e) => setSelectedJoinSeat(Number(e.target.value))}
                  className="w-full bg-bg border border-line rounded-xl px-4 py-3 text-xs text-text font-bold outline-none cursor-pointer"
                >
                  {seats.map(s => (
                    <option key={s.seatNumber} value={s.seatNumber} disabled={!!s.player} className="bg-surface text-text">
                      Seat {s.seatNumber}: {s.player ? `Occupied by ${s.player.name}` : '(Vacant Seat)'}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="text-[11px] text-text-faint flex justify-between items-center bg-bg p-2.5 rounded-xl border border-line">
              <span>Table Occupancy:</span>
              <span className="font-mono text-accent-2 font-bold">{occupiedCount} / 11 Players</span>
            </div>

            <button
              id="btn-take-seat"
              onClick={() => onJoinTable(tableCodeInput, playerNameInput, selectedJoinSeat)}
              className="w-full bg-accent-2 hover:bg-accent-2 text-accent-contrast font-extrabold py-3.5 rounded-xl text-xs uppercase tracking-wider shadow-lg transition-all cursor-pointer"
            >
              TAKE SEAT & ENTER GAME
            </button>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="max-w-6xl mx-auto w-full text-center text-[10px] text-text-faint border-t border-line/30 pt-4 flex flex-col md:flex-row justify-between items-center gap-2">
        <div>The House Keeps Score © 2026 • Private Hold'em Club Suite</div>
        <div>No Real Money Gambling • Physical Chips & Cards Companion</div>
      </div>
    </div>
  );
};
