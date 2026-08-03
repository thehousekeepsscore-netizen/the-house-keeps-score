import React, { useEffect, useState } from 'react';
import { X, Check, Palette, Settings, ChevronRight, ChevronDown, Trophy, UserCircle, Pencil, LogOut } from 'lucide-react';
import { useAuth } from '../lib/auth-context';
import { THEMES } from '../lib/theme';
import * as clubRecordsApi from '../lib/clubRecords-api';
import { LeaderboardRow } from '../lib/clubRecords-api';
import { Club } from '../types';
import { InfoHint } from './InfoHint';

const ordinal = (n: number) => {
  const r = n % 100;
  if (r >= 11 && r <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
};

const chips = (n: number) => `${Math.round(n).toLocaleString()}`;
const signed = (n: number) => `${n > 0 ? '+' : n < 0 ? '-' : ''}${Math.abs(Math.round(n)).toLocaleString()}`;

interface AccountSettingsModalProps {
  onClose: () => void;
  // Passed only when opened from within a specific club's page — shows a
  // Club Settings entry point scoped to that club, admins only.
  club?: Club;
  isClubAdmin?: boolean;
  onOpenClubSettings?: () => void;
}

export const AccountSettingsModal: React.FC<AccountSettingsModalProps> = ({ onClose, club, isClubAdmin, onOpenClubSettings }) => {
  const { user, updateProfile, logout } = useAuth();
  const [saving, setSaving] = useState<string | null>(null);
  const [showThemes, setShowThemes] = useState(false);

  // Details editing. Phone matters most — it was captured once at signup with
  // no way to change it, and player notifications route to it.
  const [editing, setEditing] = useState(false);
  const [savingDetails, setSavingDetails] = useState(false);
  const [detailsError, setDetailsError] = useState('');
  const [form, setForm] = useState({ displayName: '', username: '', phoneNumber: '' });

  const startEditing = () => {
    setForm({
      displayName: user?.displayName || '',
      username: user?.username || '',
      phoneNumber: user?.phoneNumber || '',
    });
    setDetailsError('');
    setEditing(true);
  };

  const saveDetails = async () => {
    const displayName = form.displayName.trim();
    const username = form.username.trim();
    const phoneNumber = form.phoneNumber.trim();

    if (displayName.length < 2 || displayName.length > 60) {
      setDetailsError('Name must be between 2 and 60 characters.');
      return;
    }
    // Mirrors what a handle can safely be in a URL or an @mention.
    if (username && !/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
      setDetailsError('Username must be 3–20 characters, letters, numbers or underscores only.');
      return;
    }
    // Validated against the same E.164 rules the messaging layer applies, so a
    // number accepted here is one that can actually be delivered to.
    if (phoneNumber) {
      const digits = phoneNumber.replace(/\D/g, '');
      if (digits.length < 8 || digits.length > 15) {
        setDetailsError('Enter a valid phone number, with country code if outside India.');
        return;
      }
    }

    setSavingDetails(true);
    setDetailsError('');
    try {
      await updateProfile({ displayName, username: username || undefined, phoneNumber });
      setEditing(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      // The username column is unique — surface the collision in plain terms
      // rather than leaking the raw constraint error.
      setDetailsError(
        /409|unique|taken|already/i.test(msg)
          ? 'That username is already taken.'
          : msg || 'Could not save. Try again.'
      );
    } finally {
      setSavingDetails(false);
    }
  };

  // Reuses the club leaderboard rather than a bespoke endpoint — it already
  // carries every figure needed, and rank is just position in the sorted list.
  const [record, setRecord] = useState<{ row: LeaderboardRow; rank: number; total: number } | null>(null);

  useEffect(() => {
    if (!club) return;
    let cancelled = false;
    clubRecordsApi
      .getLeaderboard(club.id)
      .then((rows) => {
        if (cancelled) return;
        // Match on account id, not display name — names aren't unique and
        // change when a player renames themselves.
        const i = rows.findIndex((r) => r.userId && r.userId === user?.uid);
        if (i >= 0) setRecord({ row: rows[i], rank: i + 1, total: rows.length });
      })
      // Clubs can hide the leaderboard from players (403) — in that case the
      // record section simply doesn't render.
      .catch(() => {});
    return () => { cancelled = true; };
  }, [club, user?.uid]);

  const activeTheme = THEMES.find((t) => t.id === user?.themePreference);

  const handleSelectTheme = async (themeId: string) => {
    if (saving || themeId === user?.themePreference) return;
    setSaving(themeId);
    try {
      await updateProfile({ themePreference: themeId });
    } catch (err) {
      console.error('Failed to save theme:', err);
      alert('Failed to save theme preference.');
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] bg-bg/80 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-5">
      <div className="w-full sm:max-w-md bg-surface border border-line rounded-t-3xl sm:rounded-3xl shadow-2xl max-h-[85vh] overflow-y-auto">
        <div className="sticky top-0 bg-surface border-b border-line px-5 py-4 flex items-center justify-between">
          <h2 className="text-sm font-bold text-text uppercase tracking-wider flex items-center gap-2">
            <UserCircle className="w-4 h-4 text-accent" /> Profile
          </h2>
          <button onClick={onClose} className="text-text-muted hover:text-text cursor-pointer">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-5">
          <div className="flex items-center gap-3">
            {user?.photoURL ? (
              <img src={user.photoURL} alt="Avatar" className="w-14 h-14 rounded-full object-cover border-2 border-accent shrink-0" />
            ) : (
              <div className="w-14 h-14 rounded-full bg-accent text-accent-contrast font-black flex items-center justify-center text-lg shrink-0">
                {(user?.displayName || user?.email || 'P')[0].toUpperCase()}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <div className="text-sm font-black text-text truncate">{user?.displayName || user?.username || 'Player'}</div>
              {user?.username && <div className="text-xs text-text-muted truncate">@{user.username}</div>}
              {user?.email && <div className="text-xs text-text-faint truncate">{user.email}</div>}
              <div className="text-xs text-text-faint truncate">
                {user?.phoneNumber || <span className="text-warning">No phone number saved</span>}
              </div>
            </div>
            {!editing && (
              <button
                onClick={startEditing}
                className="shrink-0 flex items-center gap-1 text-[11px] font-bold text-accent hover:opacity-80 cursor-pointer"
              >
                <Pencil className="w-3.5 h-3.5" /> Edit
              </button>
            )}
          </div>

          {editing && (
            <div className="p-4 bg-bg border border-line rounded-2xl space-y-3">
              <div className="space-y-1">
                <label className="text-[10px] font-bold text-text-muted uppercase">Display name</label>
                <input
                  value={form.displayName}
                  onChange={(e) => setForm({ ...form, displayName: e.target.value })}
                  className="w-full bg-surface border border-line rounded-xl px-3 py-2.5 text-sm text-text focus:border-accent outline-none"
                />
              </div>
              <div className="space-y-1">
                <label className="text-[10px] font-bold text-text-muted uppercase">Username</label>
                <input
                  value={form.username}
                  onChange={(e) => setForm({ ...form, username: e.target.value })}
                  className="w-full bg-surface border border-line rounded-xl px-3 py-2.5 text-sm text-text focus:border-accent outline-none"
                />
              </div>
              <div className="space-y-1">
                <label className="text-[10px] font-bold text-text-muted uppercase flex items-center gap-1">
                  Phone number
                  <InfoHint>
                    Where result and buy-in notifications are sent. Leave blank to receive none.
                  </InfoHint>
                </label>
                <input
                  type="tel"
                  value={form.phoneNumber}
                  onChange={(e) => setForm({ ...form, phoneNumber: e.target.value })}
                  placeholder="+91 98765 43210"
                  className="w-full bg-surface border border-line rounded-xl px-3 py-2.5 text-sm text-text placeholder:text-text-faint focus:border-accent outline-none"
                />
              </div>

              {detailsError && <p className="text-[11px] text-danger">{detailsError}</p>}

              <div className="flex gap-2">
                <button
                  onClick={() => setEditing(false)}
                  disabled={savingDetails}
                  className="flex-1 bg-surface-alt border border-line-strong text-text font-bold py-2.5 rounded-xl text-xs uppercase tracking-wider cursor-pointer disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={saveDetails}
                  disabled={savingDetails}
                  className="flex-1 bg-accent text-accent-contrast font-black py-2.5 rounded-xl text-xs uppercase tracking-wider cursor-pointer disabled:opacity-50"
                >
                  {savingDetails ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          )}

          {/* My Record — the reason to open this screen. */}
          {record && (
            <div className="p-4 bg-bg border border-line rounded-2xl space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-bold text-text uppercase tracking-wider flex items-center gap-1.5">
                  <Trophy className="w-4 h-4 text-accent" /> My Record
                </h3>
                <span className="text-[10px] text-text-muted truncate max-w-[45%]">{club?.name}</span>
              </div>

              <div className="flex items-end justify-between gap-3">
                <div>
                  <div className="text-[10px] text-text-muted uppercase tracking-wider">All time</div>
                  <div className={`text-2xl font-black ${record.row.netProfit >= 0 ? 'text-accent' : 'text-danger'}`}>
                    {signed(record.row.netProfit)}
                    <span className="text-xs font-bold text-text-muted ml-1">Chips</span>
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-[10px] text-text-muted uppercase tracking-wider">Rank</div>
                  <div className="text-2xl font-black text-accent">{ordinal(record.rank)}</div>
                  <div className="text-[10px] text-text-faint">of {record.total}</div>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2 pt-2 border-t border-line text-center">
                <div>
                  <div className="text-sm font-bold text-text">{record.row.sessionsPlayed}</div>
                  <div className="text-[9px] text-text-muted uppercase tracking-wide">Sessions</div>
                </div>
                <div>
                  <div className="text-sm font-bold text-accent">{signed(record.row.biggestWin)}</div>
                  <div className="text-[9px] text-text-muted uppercase tracking-wide">Best</div>
                </div>
                <div>
                  <div className="text-sm font-bold text-danger">{signed(record.row.biggestLoss)}</div>
                  <div className="text-[9px] text-text-muted uppercase tracking-wide">Worst</div>
                </div>
              </div>
            </div>
          )}

          {/* Appearance — collapsed; it's a preference, not the main event. */}
          <button
            type="button"
            onClick={() => setShowThemes((v) => !v)}
            className="w-full flex items-center justify-between p-3 bg-bg border border-line rounded-xl hover:border-line-strong transition-colors cursor-pointer"
          >
            <span className="flex items-center gap-2 text-xs font-bold text-text">
              <Palette className="w-4 h-4 text-accent" /> Appearance
            </span>
            <span className="flex items-center gap-1.5 text-xs text-text-muted">
              {activeTheme?.label ?? 'Default'}
              {showThemes ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
            </span>
          </button>

          <div className={`space-y-2.5 ${showThemes ? '' : 'hidden'}`}>
            {THEMES.map((theme) => {
              const isActive = user?.themePreference === theme.id;
              return (
                <button
                  key={theme.id}
                  onClick={() => handleSelectTheme(theme.id)}
                  disabled={saving !== null}
                  className={`w-full flex items-center gap-3 p-3 rounded-2xl border transition-all cursor-pointer text-left ${
                    isActive ? 'border-accent bg-accent/10' : 'border-line hover:border-line-strong'
                  } disabled:opacity-60`}
                >
                  <div
                    className="w-11 h-11 rounded-xl border border-line-strong shrink-0 flex overflow-hidden"
                    style={{ background: theme.swatch.bg }}
                  >
                    <div className="w-1/2 h-full" style={{ background: theme.swatch.surface }} />
                    <div className="w-1/4 h-full" style={{ background: theme.swatch.accent }} />
                    <div className="w-1/4 h-full" style={{ background: theme.swatch.accent2 }} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-bold text-text">{theme.label}</div>
                    <div className="text-xs text-text-muted truncate">{theme.description}</div>
                  </div>
                  {saving === theme.id ? (
                    <div className="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin shrink-0" />
                  ) : isActive ? (
                    <Check className="w-4 h-4 text-accent shrink-0" />
                  ) : null}
                </button>
              );
            })}
          </div>

          {/* Admin tools live below personal settings — they're club-scoped,
              not part of this player's own account. */}
          {club && isClubAdmin && onOpenClubSettings && (
            <div className="pt-1 space-y-2">
              <h3 className="text-[10px] font-bold text-text-faint uppercase tracking-wider">Admin</h3>
              <button
                onClick={onOpenClubSettings}
                className="w-full flex items-center justify-between p-3 bg-bg border border-line rounded-xl text-xs font-bold text-text hover:border-line-strong transition-colors cursor-pointer"
              >
                <span className="flex items-center gap-2 min-w-0">
                  <Settings className="w-4 h-4 text-accent shrink-0" />
                  <span className="truncate">{club.name} — Club Settings</span>
                </span>
                <ChevronRight className="w-4 h-4 text-text-muted shrink-0" />
              </button>
            </div>
          )}

          <button
            onClick={() => logout()}
            className="w-full flex items-center justify-center gap-2 p-3 border border-line rounded-xl text-xs font-bold text-text-muted hover:text-danger hover:border-danger/50 transition-colors cursor-pointer"
          >
            <LogOut className="w-4 h-4" /> Sign Out
          </button>
        </div>
      </div>
    </div>
  );
};
