import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { AppUser as User } from '../lib/auth-types';
import * as clubsApi from '../lib/clubs-api';
import { ApiClub } from '../lib/clubs-api';
import { Club, ClubJoinRequest } from '../types';
import { AccountSettingsModal } from './AccountSettingsModal';
import { BrandLogo } from './BrandLogo';
import { InfoHint } from './InfoHint';
import {
  Crown,
  Plus,
  Users,
  ShieldCheck,
  ArrowLeft,
  Coins,
  Sliders,
  ChevronUp,
  ChevronDown,
  Bell,
  Search,
  Check,
  X,
  Play,
  LogOut,
  Sparkles,
  CheckCircle2,
  Clock,
  Shield,
  UserCircle
} from 'lucide-react';

interface ClubDashboardViewProps {
  currentUser: User;
  playerAvatarUrl: string;
  onSelectClub: (club: Club) => void;
  onProceedToLobby: () => void;
  onSignOut: () => void;
}

// No live sync yet (that lands with the Socket.IO layer in a later phase) —
// a lightweight poll keeps club/request lists reasonably fresh in the
// meantime, on top of an immediate refresh after every action this view
// itself performs.
const POLL_INTERVAL_MS = 15_000;

export const ClubDashboardView: React.FC<ClubDashboardViewProps> = ({
  currentUser,
  playerAvatarUrl,
  onSelectClub,
  onProceedToLobby,
  onSignOut
}) => {
  const [rawClubs, setRawClubs] = useState<ApiClub[]>([]);
  const [requests, setRequests] = useState<ClubJoinRequest[]>([]);
  const [activeTab, setActiveTab] = useState<'myClubs' | 'browse' | 'create' | 'requests' | 'superuser'>('myClubs');
  const [showAccountSettings, setShowAccountSettings] = useState(false);

  // Create Club Form
  const [newClubName, setNewClubName] = useState('');
  const [newClubDesc, setNewClubDesc] = useState('');
  // Defaults are deliberately plain: 1 Chip = ₹1 and no rake. Anything more
  // opinionated is opt-in under Advanced Settings. A ratio of 1 means "no
  // valuation applied", so there's no separate enable flag to keep in sync.
  const [devaluationFactor, setDevaluationFactor] = useState(1);
  const enableDevaluation = devaluationFactor > 1;

  // Rake at creation time. The headline choice is a flat per-session amount,
  // which is how most home games actually charge. Anything percentage-based
  // (winners' cut) lives behind Advanced. Rake always funds the Club Pot.
  // How the table's buy-in ceiling is decided. MATCH_HIGHEST is the default
  // because it's what every existing club already does.
  const [buyInMode, setBuyInMode] = useState<'MATCH_HIGHEST' | 'UNCAPPED'>('MATCH_HIGHEST');
  const [sessionRake, setSessionRake] = useState(0);
  const [showAdvancedRake, setShowAdvancedRake] = useState(false);
  const [winnersCutPercent, setWinnersCutPercent] = useState(0);
  const [formError, setFormError] = useState('');
  const [formSuccess, setFormSuccess] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Search
  const [searchQuery, setSearchQuery] = useState('');

  const [expandedClubMembersId, setExpandedClubMembersId] = useState<string | null>(null);

  const isSuperUser = currentUser.isSuperAdmin;

  const clubs = useMemo(() => rawClubs.map(clubsApi.toClub), [rawClubs]);

  const refresh = useCallback(async () => {
    try {
      const [clubsList, requestsList] = await Promise.all([
        clubsApi.listClubsRaw(),
        clubsApi.listJoinRequests(),
      ]);
      setRawClubs(clubsList);
      setRequests(requestsList);
    } catch (err) {
      console.error('Failed to load clubs/requests:', err);
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [refresh]);

  // Filter My Clubs vs Browse
  const myClubs = clubs.filter(c =>
    c.memberUids?.includes(currentUser.uid) || c.adminUids?.includes(currentUser.uid)
  );

  const adminClubIds = clubs.filter(c => c.ownerUid === currentUser.uid || c.adminUids?.includes(currentUser.uid) || isSuperUser).map(c => c.id);

  // Pending requests for clubs I am admin of
  const pendingAdminRequests = requests.filter(
    r => r.status === 'pending' && (adminClubIds.includes(r.clubId) || isSuperUser)
  );

  // My sent join requests
  const mySentRequests = requests.filter(r => r.userId === currentUser.uid);

  // Create Club Handler
  const handleCreateClub = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');
    setFormSuccess('');

    const trimmedName = newClubName.trim();
    if (!trimmedName) {
      setFormError('Club name is required.');
      return;
    }

    if (trimmedName.length < 3) {
      setFormError('Club name must be at least 3 characters.');
      return;
    }

    const isDuplicate = clubs.some(c => c.name.toLowerCase() === trimmedName.toLowerCase());
    if (isDuplicate) {
      setFormError(`A club with the name "${trimmedName}" already exists! Please choose a unique name.`);
      return;
    }

    setIsSubmitting(true);
    try {
      // Both charges are independent now; the pot is enabled if either is set.
      const rakeCharged = sessionRake > 0 || winnersCutPercent > 0;

      await clubsApi.createClub({
        name: trimmedName,
        description: newClubDesc.trim() || undefined,
        enableDevaluation,
        devaluationFactor: enableDevaluation ? devaluationFactor : 1,
        buyInMode,
        sessionRakeAmount: sessionRake,
        winnersCutPercent,
        rakeEnabled: rakeCharged,
        potEnabled: rakeCharged,
      });

      setFormSuccess(`🎉 Club "${trimmedName}" created successfully! You are now the Owner.`);
      setNewClubName('');
      setNewClubDesc('');
      await refresh();
      setTimeout(() => {
        setActiveTab('myClubs');
        setFormSuccess('');
      }, 1500);
    } catch (err) {
      console.error('Failed to create club:', err);
      setFormError('Failed to create club. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  // Join Club Request
  const handleRequestJoinClub = async (club: Club) => {
    const capacity = club.maxCapacity || 50;
    if (club.memberUids?.length >= capacity) {
      alert(`This club has reached its maximum capacity of ${capacity} players.`);
      return;
    }

    const existingReq = requests.find(
      r => r.clubId === club.id && r.userId === currentUser.uid && r.status === 'pending'
    );
    if (existingReq) {
      alert('You already have a pending join request for this club.');
      return;
    }

    try {
      await clubsApi.requestJoinClub(club.id);
      alert(`✅ Request to join "${club.name}" sent to Club Admin!`);
      await refresh();
    } catch (err) {
      console.error('Failed to send join request:', err);
      alert('Failed to send join request. Please try again.');
    }
  };

  // Admin Approve / Reject Request
  const handleUpdateRequestStatus = async (requestId: string, clubId: string, newStatus: 'accepted' | 'rejected') => {
    try {
      await clubsApi.decideJoinRequest(clubId, requestId, newStatus === 'accepted');
      await refresh();
    } catch (err) {
      console.error('Failed to update request:', err);
      alert('Failed to process request.');
    }
  };

  return (
    <div className="min-h-screen bg-bg text-text font-sans flex flex-col">

      {/* Top Navigation Header */}
      <header className="bg-bg/95 border-b border-line sticky top-0 z-50 backdrop-blur-md px-4 py-3">
        <div className="max-w-7xl mx-auto flex items-center justify-between gap-4">

          {/* Logo & Brand */}
          <div className="flex items-center gap-3">
            <BrandLogo className="w-9 h-9" letterClassName="text-xl" suitClassName="w-1.5 h-1.5" />
            <div>
              <h1 className="text-sm md:text-base font-black tracking-wider text-text uppercase leading-none">
                THE HOUSE KEEPS SCORE
              </h1>
              <span className="text-[10px] text-text-muted font-medium tracking-widest uppercase">
                POKER CLUBS & LOBBY HUB
              </span>
            </div>
          </div>

          {/* User Profile Info & Badges */}
          <div className="flex items-center gap-3">
            {isSuperUser && (
              <span className="hidden sm:flex items-center gap-1.5 px-3 py-1 bg-warning/15 border border-accent rounded-full text-[10px] font-black text-accent uppercase tracking-wider animate-pulse">
                <Sparkles className="w-3.5 h-3.5 text-accent" /> SUPER USER DEVELOPER
              </span>
            )}

            {/* Profile — mobile users reach this via the bottom nav instead (md:hidden there) */}
            <button
              onClick={() => setShowAccountSettings(true)}
              className="hidden md:flex p-2 bg-surface hover:bg-surface-alt border border-line rounded-full text-text hover:text-accent transition-all cursor-pointer"
              title="Profile"
            >
              {playerAvatarUrl ? (
                <img src={playerAvatarUrl} alt="Avatar" className="w-4 h-4 rounded-full object-cover" />
              ) : (
                <UserCircle className="w-4 h-4" />
              )}
            </button>

            {/* Pending join requests. Desktop only — on mobile the bottom nav
                already carries a Requests item with the same badge and target,
                so showing both was pure duplication. */}
            <button
              onClick={() => setActiveTab('requests')}
              className="hidden md:flex relative p-2 bg-surface hover:bg-surface-alt border border-line rounded-full text-text hover:text-accent transition-all cursor-pointer"
              title="Pending Join Requests"
            >
              <Bell className="w-4 h-4" />
              {pendingAdminRequests.length > 0 && (
                <span className="absolute -top-1 -right-1 bg-danger text-white font-black text-[9px] w-4 h-4 rounded-full flex items-center justify-center border border-line animate-bounce">
                  {pendingAdminRequests.length}
                </span>
              )}
            </button>

            {/* Sign Out */}
            <button
              onClick={onSignOut}
              className="p-2 bg-surface/80 hover:bg-danger/15 border border-line hover:border-danger/40 text-text-muted hover:text-danger rounded-full transition-all cursor-pointer"
              title="Sign Out"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>

        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-grow max-w-7xl w-full mx-auto p-4 md:p-8 space-y-6 pb-28 md:pb-8">

        {/* TAB 1: MY CLUBS */}
        {activeTab === 'myClubs' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-base font-bold text-text uppercase tracking-wider flex items-center gap-2">
                  <Users className="w-5 h-5 text-accent" /> Your Poker Clubs
                  <InfoHint>
                    Clubs you're a member or admin of. Open one to join the table or host a game.
                  </InfoHint>
                </h2>
              </div>
            </div>

            {myClubs.length === 0 ? (
              <div className="p-8 bg-surface border border-dashed border-line rounded-2xl text-center space-y-3">
                <ShieldCheck className="w-10 h-10 text-text-muted mx-auto opacity-60" />
                <p className="text-sm text-text font-medium">You haven't joined any clubs yet.</p>
                <p className="text-xs text-text-muted">Browse public clubs to send a join request or create your own club!</p>
                <div className="flex gap-2 justify-center pt-2">
                  <button
                    onClick={() => setActiveTab('browse')}
                    className="bg-accent hover:bg-accent text-accent-contrast font-bold px-4 py-2 rounded-xl text-xs uppercase cursor-pointer"
                  >
                    Browse Clubs
                  </button>
                  <button
                    onClick={() => setActiveTab('create')}
                    className="bg-surface hover:bg-surface-alt border border-line text-text font-bold px-4 py-2 rounded-xl text-xs uppercase cursor-pointer"
                  >
                    Create Club
                  </button>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {myClubs.map((club) => {
                  const isOwner = club.ownerUid === currentUser.uid;
                  const isAdmin = !isOwner && (club.adminUids?.includes(currentUser.uid) || isSuperUser);
                  const memberCount = club.memberUids?.length || 0;

                  return (
                    <div
                      key={club.id}
                      className="bg-surface border border-line hover:border-accent/60 rounded-2xl p-5 space-y-4 shadow-xl transition-all relative overflow-hidden flex flex-col justify-between"
                    >
                      <div className="space-y-2">
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <div className="flex items-center gap-2">
                              <h3 className="text-lg font-black text-text uppercase tracking-wide">
                                {club.name}
                              </h3>
                              <span className="px-2 py-0.5 bg-bg border border-line font-mono text-accent font-black text-[11px] rounded-lg">
                                Code: #{club.code}
                              </span>
                            </div>
                            <p className="text-xs text-text-muted line-clamp-2 mt-0.5">
                              {club.description || 'Private Poker Club'}
                            </p>
                          </div>
                          {isOwner && (
                            <span className="px-2.5 py-1 bg-accent/10 border border-accent text-accent font-extrabold text-[10px] uppercase rounded-full flex items-center gap-1 shrink-0">
                              <Crown className="w-3 h-3" /> Owner
                            </span>
                          )}
                          {isAdmin && (
                            <span className="px-2.5 py-1 bg-accent/10 border border-accent text-accent font-extrabold text-[10px] uppercase rounded-full flex items-center gap-1 shrink-0">
                              <ShieldCheck className="w-3 h-3" /> Admin
                            </span>
                          )}
                        </div>

                        <div className="flex items-center gap-4 text-xs text-text-muted pt-1">
                          <span className="flex items-center gap-1 font-mono">
                            <Users className="w-3.5 h-3.5 text-accent" /> {memberCount} / {club.maxCapacity || 50} Players
                          </span>
                          <span className="flex items-center gap-1 font-mono">
                            <Shield className="w-3.5 h-3.5 text-text-muted" /> {club.adminUids?.length || 1}/3 Admins
                          </span>
                        </div>
                      </div>

                      <div className="pt-3 border-t border-line flex items-center gap-2">
                        <button
                          onClick={() => onSelectClub(club)}
                          className="flex-grow bg-accent hover:bg-accent text-accent-contrast font-black py-2.5 px-4 rounded-xl text-xs uppercase tracking-wider transition-all cursor-pointer flex items-center justify-center gap-2"
                        >
                          <Play className="w-3.5 h-3.5 fill-current" /> ENTER CLUB TABLE
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* TAB 2: BROWSE ALL CLUBS */}
        {activeTab === 'browse' && (
          <div className="space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-bold text-text uppercase tracking-wider flex items-center gap-2">
                  <Search className="w-5 h-5 text-accent" /> Public Clubs Directory
                </h2>
                <p className="text-xs text-text-muted">
                  Browse all active poker clubs. Send a request to the club admin to get approved!
                </p>
              </div>

              {/* Search Bar */}
              <div className="relative w-full sm:w-64">
                <Search className="w-4 h-4 text-text-muted absolute left-3 top-2.5" />
                <input
                  type="text"
                  placeholder="Search by club name..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full bg-bg border border-line rounded-xl pl-9 pr-4 py-2 text-xs text-text font-bold focus:border-accent outline-none"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {clubs
                .filter(c => c.name.toLowerCase().includes(searchQuery.toLowerCase()))
                .map((club) => {
                  const isMember = club.memberUids?.includes(currentUser.uid);
                  const memberCount = club.memberUids?.length || 0;
                  const isFull = memberCount >= (club.maxCapacity || 50);

                  const myPendingReq = requests.find(
                    r => r.clubId === club.id && r.userId === currentUser.uid && r.status === 'pending'
                  );

                  return (
                    <div
                      key={club.id}
                      className="bg-surface border border-line hover:border-accent/50 rounded-2xl p-5 space-y-4 shadow-xl transition-all flex flex-col justify-between"
                    >
                      <div className="space-y-2">
                        <div className="flex items-start justify-between gap-2">
                          <h3 className="text-lg font-black text-text uppercase tracking-wide">
                            {club.name}
                          </h3>
                          <div className="flex items-center gap-1.5 shrink-0">
                            <span className="px-2 py-0.5 bg-bg border border-line font-mono text-accent font-black text-[10px] rounded-lg">
                              #{club.code}
                            </span>
                            {isMember && (
                              <span className="px-2 py-0.5 bg-accent/15 border border-accent/50 text-accent font-bold text-[10px] uppercase rounded-full">
                                Joined
                              </span>
                            )}
                          </div>
                        </div>

                        <p className="text-xs text-text-muted line-clamp-2">
                          {club.description || 'Private Poker Club'}
                        </p>

                        <div className="flex items-center gap-4 text-xs text-text-muted pt-1 font-mono">
                          <span>Users: <strong className="text-text">{memberCount}/{club.maxCapacity || 50}</strong></span>
                          <span>Admins: <strong className="text-text">{club.adminUids?.length || 1}/3</strong></span>
                        </div>
                      </div>

                      <div className="pt-3 border-t border-line">
                        {isMember ? (
                          <button
                            onClick={() => onSelectClub(club)}
                            className="w-full bg-accent hover:bg-accent text-accent-contrast font-black py-2.5 px-4 rounded-xl text-xs uppercase tracking-wider transition-all cursor-pointer flex items-center justify-center gap-2"
                          >
                            <Play className="w-3.5 h-3.5 fill-current" /> ENTER CLUB
                          </button>
                        ) : myPendingReq ? (
                          <button
                            disabled
                            className="w-full bg-surface border border-line text-text-muted font-bold py-2.5 px-4 rounded-xl text-xs uppercase cursor-not-allowed flex items-center justify-center gap-2"
                          >
                            <Clock className="w-3.5 h-3.5 text-warning" /> JOIN REQUEST PENDING
                          </button>
                        ) : isFull ? (
                          <button
                            disabled
                            className="w-full bg-surface border border-line text-text-muted font-bold py-2.5 px-4 rounded-xl text-xs uppercase cursor-not-allowed"
                          >
                            CLUB FULL ({club.maxCapacity || 50}/{club.maxCapacity || 50})
                          </button>
                        ) : (
                          <button
                            onClick={() => handleRequestJoinClub(club)}
                            className="w-full bg-surface-alt hover:bg-line-strong border border-line-strong text-text font-bold py-2.5 px-4 rounded-xl text-xs uppercase tracking-wider transition-all cursor-pointer flex items-center justify-center gap-2"
                          >
                            <Plus className="w-3.5 h-3.5 text-accent" /> REQUEST TO JOIN
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
            </div>
          </div>
        )}

        {/* TAB 3: CREATE A CLUB */}
        {activeTab === 'create' && (
          <div className="max-w-xl mx-auto bg-surface border border-line p-6 md:p-8 rounded-3xl shadow-2xl space-y-5">
            <div className="border-b border-line pb-4">
              <div className="flex items-start gap-3">
                {/* Without this the only way out of the form is to actually
                    create a club, or to notice the bottom nav. */}
                <button
                  type="button"
                  onClick={() => setActiveTab('myClubs')}
                  aria-label="Back to my clubs"
                  className="shrink-0 w-9 h-9 rounded-xl border border-line text-text-muted hover:text-text hover:border-line-strong transition-colors flex items-center justify-center cursor-pointer mt-0.5"
                >
                  <ArrowLeft className="w-4 h-4" />
                </button>
                <div className="min-w-0">
                  <h2 className="text-lg font-black text-text uppercase tracking-wider flex items-center gap-2">
                    <Plus className="w-5 h-5 text-accent" /> Create a New Club
                    <InfoHint>
                      You become the Owner and first Admin. Names must be unique across the app.
                    </InfoHint>
                  </h2>
                </div>
              </div>
            </div>

            {formError && (
              <div className="p-3 bg-danger/15 border border-danger/40 text-danger text-xs rounded-xl font-medium text-center">
                {formError}
              </div>
            )}

            {formSuccess && (
              <div className="p-3 bg-accent/15 border border-accent/40 text-accent text-xs rounded-xl font-medium text-center flex items-center justify-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-accent" /> {formSuccess}
              </div>
            )}

            <form onSubmit={handleCreateClub} className="space-y-4">
              <div className="space-y-1">
                <label className="text-[11px] font-bold uppercase tracking-wider text-text-muted">
                  Unique Club Name <span className="text-danger">*</span>
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Royal Flush Syndicate"
                  value={newClubName}
                  onChange={(e) => setNewClubName(e.target.value)}
                  className="w-full bg-bg border border-line rounded-xl px-4 py-3 text-xs text-text font-bold focus:border-accent outline-none"
                />
              </div>

              <div className="space-y-1">
                <label className="text-[11px] font-bold uppercase tracking-wider text-text-muted">
                  Club Description
                </label>
                <textarea
                  rows={3}
                  placeholder="Private weekend Hold'em games and tournament leaderboards..."
                  value={newClubDesc}
                  onChange={(e) => setNewClubDesc(e.target.value)}
                  className="w-full bg-bg border border-line rounded-xl px-4 py-3 text-xs text-text font-bold focus:border-accent outline-none resize-none"
                />
              </div>

              {/* Everything below is optional. A club created without opening
                  this section gets plain defaults: 1 chip = ₹1 and no rake. */}
              <button
                type="button"
                onClick={() => setShowAdvancedRake((v) => !v)}
                className="w-full flex items-center justify-between p-3 bg-bg border border-line rounded-xl cursor-pointer hover:border-line-strong transition"
              >
                <span className="text-xs font-bold text-text flex items-center gap-2">
                  <Sliders className="w-4 h-4 text-accent" /> Advanced Settings
                  <span className="text-[10px] text-text-muted font-normal">Chips valuation & session rake</span>
                </span>
                {showAdvancedRake ? <ChevronUp className="w-4 h-4 text-accent" /> : <ChevronDown className="w-4 h-4 text-accent" />}
              </button>

              {showAdvancedRake && (
                <>
              {/* No enable/disable toggle — a ratio of 1 *is* "off", which
                  keeps the default (1 Chip = ₹1) self-evident. */}
              <div className="p-4 bg-bg border border-line rounded-2xl space-y-3">
                <div>
                  <p className="text-xs font-bold text-text uppercase tracking-wider flex items-center gap-1.5">
                    <Coins className="w-4 h-4 text-accent" /> Chips Valuation
                    <InfoHint>
                      What a chip is worth in cash when you settle up. Balances always display in Chips either way.
                    </InfoHint>
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="number"
                    min={1}
                    max={100}
                    value={devaluationFactor}
                    onChange={(e) => setDevaluationFactor(Math.max(1, parseInt(e.target.value) || 1))}
                    className="w-24 bg-surface border border-line rounded-xl px-3 py-2.5 text-sm text-text font-mono font-bold outline-none focus:border-accent"
                  />
                  <span className="text-sm text-text font-mono font-bold">Chips = ₹1</span>
                </div>

                <p className="text-[10px] text-text-muted">
                  {devaluationFactor === 1
                    ? 'Standard — a chip is worth a rupee. Leave as 1 unless your table plays otherwise.'
                    : `1,000 Chips = ₹${Math.round(1000 / devaluationFactor).toLocaleString()} real cash.`}
                </p>
              </div>

              {/* ---- Rake ---- */}
              <div className="p-4 bg-bg border border-line rounded-2xl space-y-3">
                <p className="text-xs font-bold text-text uppercase tracking-wider flex items-center gap-1.5">
                  <Coins className="w-4 h-4 text-accent" /> Buy-in Limit
                  <InfoHint>
                    How much a player may take in one go. The first buy-in of a session is never capped — it sets the reference the rest match.
                  </InfoHint>
                </p>

                <div className="space-y-2">
                  {([
                    ['MATCH_HIGHEST', 'Match the biggest bank',
                     "A player can take up to whatever the deepest player currently holds. Taking the maximum makes your bank the new reference."],
                    ['UNCAPPED', 'No limit',
                     'The app applies no ceiling at all. Players agree limits between themselves.'],
                  ] as const).map(([value, label, blurb]) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setBuyInMode(value)}
                      className={`w-full text-left p-3 rounded-xl border transition-colors cursor-pointer ${
                        buyInMode === value ? 'border-accent bg-accent/10' : 'border-line hover:border-line-strong'
                      }`}
                    >
                      <span className={`block text-xs font-bold ${buyInMode === value ? 'text-accent' : 'text-text'}`}>
                        {label}
                      </span>
                      <span className="block text-[10px] text-text-muted mt-0.5 leading-relaxed">{blurb}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Two independent charges. Either, both, or neither — both
                  fund the Club Pot. */}
              <div className="p-4 bg-bg border border-line rounded-2xl space-y-4">
                <p className="text-xs font-bold text-text uppercase tracking-wider flex items-center gap-1.5">
                  <Coins className="w-4 h-4 text-accent" /> House Rake
                  <InfoHint>
                    What the house takes. You can charge a flat fee, a cut of winnings, or both. Everything charged goes into the Club Pot.
                  </InfoHint>
                </p>

                <div className="space-y-1.5">
                  <label className="text-[10px] font-bold text-text-muted uppercase">
                    Session rake — flat amount
                  </label>
                  <input
                    type="number"
                    min={0}
                    step={50}
                    value={sessionRake}
                    onChange={(e) => setSessionRake(Math.max(0, Number(e.target.value)))}
                    className="w-full bg-surface border border-line rounded-xl px-3 py-2.5 text-sm font-mono font-bold text-text focus:border-accent outline-none"
                    placeholder="0"
                  />
                  <p className="text-[10px] text-text-muted">
                    {sessionRake > 0
                      ? `${sessionRake.toLocaleString()} Chips once per session — charged to the table, not to any one player.`
                      : 'Charged once per session, regardless of who wins. 0 for none.'}
                  </p>
                </div>

                <div className="space-y-1.5 pt-1 border-t border-line">
                  <label className="text-[10px] font-bold text-text-muted uppercase pt-2 block">
                    Winners&apos; cut — percentage
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={0}
                      max={100}
                      value={winnersCutPercent}
                      onChange={(e) => setWinnersCutPercent(Math.min(100, Math.max(0, Number(e.target.value))))}
                      className="w-24 bg-surface border border-line rounded-xl px-3 py-2.5 text-sm font-mono font-bold text-text focus:border-accent outline-none"
                    />
                    <span className="text-sm font-mono font-bold text-text">% of each winner&apos;s profit</span>
                  </div>
                  <p className="text-[10px] text-text-muted">
                    {winnersCutPercent > 0
                      ? `${winnersCutPercent}% taken from each winner's profit. Losers are never charged.`
                      : 'Taken only from players who finish up. 0 for none.'}
                  </p>
                </div>

                {(sessionRake > 0 || winnersCutPercent > 0) && (
                  <p className="text-[10px] text-accent font-bold pt-1 border-t border-line">
                    {[sessionRake > 0 ? `${sessionRake.toLocaleString()} Chips per session` : null,
                      winnersCutPercent > 0 ? `${winnersCutPercent}% of winnings` : null]
                      .filter(Boolean).join(' + ')} → Club Pot
                  </p>
                )}
              </div>
                </>
              )}

              <div className="p-3 bg-bg border border-line rounded-xl text-[11px] text-text-muted space-y-1">
                <p className="font-bold text-text flex items-center gap-1.5">
                  <ShieldCheck className="w-4 h-4 text-accent" /> Club Will Be Created With:
                </p>
                <ul className="list-disc list-inside space-y-0.5 text-[10px]">
                  <li>Maximum capacity: <strong>50 Players</strong></li>
                  <li>Maximum admins: <strong>2 Admins</strong> (plus you as Owner)</li>
                  <li>Join system: Players send a request that only the Club Owner can approve</li>
                  <li>Currency ratio: <strong>{enableDevaluation ? `${devaluationFactor} Chips = ₹1 INR` : '1 Chip = ₹1 INR (Standard)'}</strong></li>
                  <li>Buy-in limit: <strong>{buyInMode === 'UNCAPPED' ? 'No limit' : 'Match the biggest bank'}</strong></li>
                  <li>Rake: <strong>{[
                    sessionRake > 0 ? `${sessionRake.toLocaleString()} Chips per session` : null,
                    winnersCutPercent > 0 ? `${winnersCutPercent}% winners' cut` : null,
                  ].filter(Boolean).join(' + ') || 'None'}</strong></li>
                </ul>
              </div>

              <button
                type="submit"
                disabled={isSubmitting}
                className="w-full bg-accent hover:bg-accent text-accent-contrast font-black py-3.5 rounded-xl text-xs uppercase tracking-widest shadow-lg transition-all cursor-pointer flex items-center justify-center gap-2 disabled:opacity-50"
              >
                <Crown className="w-4 h-4" />
                {isSubmitting ? 'Creating Club...' : 'CREATE CLUB & BECOME OWNER'}
              </button>

              <button
                type="button"
                onClick={() => setActiveTab('myClubs')}
                disabled={isSubmitting}
                className="w-full text-center text-xs font-bold text-text-muted hover:text-text transition-colors cursor-pointer disabled:opacity-50 py-1"
              >
                Cancel
              </button>
            </form>
          </div>
        )}

        {/* TAB 4: JOIN REQUESTS & NOTIFICATIONS */}
        {activeTab === 'requests' && (
          <div className="space-y-6 max-w-3xl mx-auto">

            {/* Admin Notifications Box */}
            <div className="bg-surface border border-line p-6 rounded-3xl space-y-4 shadow-xl">
              <div className="flex items-center justify-between border-b border-line pb-3">
                <h2 className="text-base font-bold text-text uppercase tracking-wider flex items-center gap-2">
                  <Bell className="w-5 h-5 text-accent" /> Pending Club Requests (Admin Notifications)
                </h2>
                <span className="px-2.5 py-0.5 bg-accent text-accent-contrast font-black text-xs rounded-full">
                  {pendingAdminRequests.length}
                </span>
              </div>

              {pendingAdminRequests.length === 0 ? (
                <div className="p-6 text-center text-xs text-text-muted">
                  No pending join requests for your managed clubs right now.
                </div>
              ) : (
                <div className="space-y-3">
                  {pendingAdminRequests.map((req) => (
                    <div
                      key={req.id}
                      className="p-4 bg-bg border border-line rounded-2xl flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                    >
                      <div className="flex items-center gap-3">
                        {req.userAvatarUrl ? (
                          <img src={req.userAvatarUrl} alt="User" className="w-10 h-10 rounded-full object-cover border border-accent" />
                        ) : (
                          <div className="w-10 h-10 rounded-full bg-surface-alt text-accent font-bold flex items-center justify-center text-sm border border-line">
                            {(req.userDisplayName || 'P')[0].toUpperCase()}
                          </div>
                        )}
                        <div>
                          <div className="text-xs font-bold text-text">
                            {req.userDisplayName}
                          </div>
                          <div className="text-[10px] text-text-muted">
                            Wants to join <strong className="text-accent">{req.clubName}</strong>
                          </div>
                          <div className="text-[9px] text-text-muted font-mono">
                            Requested: {new Date(req.createdAt).toLocaleDateString()}
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => handleUpdateRequestStatus(req.id, req.clubId, 'accepted')}
                          className="bg-accent hover:bg-accent text-accent-contrast font-bold px-3 py-1.5 rounded-xl text-xs uppercase tracking-wider transition-all cursor-pointer flex items-center gap-1"
                        >
                          <Check className="w-3.5 h-3.5" /> Accept
                        </button>
                        <button
                          onClick={() => handleUpdateRequestStatus(req.id, req.clubId, 'rejected')}
                          className="bg-danger/15 hover:bg-danger/25 border border-danger/40 text-danger font-bold px-3 py-1.5 rounded-xl text-xs uppercase tracking-wider transition-all cursor-pointer flex items-center gap-1"
                        >
                          <X className="w-3.5 h-3.5" /> Reject
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* My Sent Requests Status */}
            <div className="bg-surface border border-line p-6 rounded-3xl space-y-4 shadow-xl">
              <h2 className="text-sm font-bold text-text uppercase tracking-wider border-b border-line pb-3">
                Your Sent Join Requests Status
              </h2>

              {mySentRequests.length === 0 ? (
                <p className="text-xs text-text-muted text-center py-2">
                  You haven't requested to join any clubs yet.
                </p>
              ) : (
                <div className="space-y-2">
                  {mySentRequests.map((req) => (
                    <div key={req.id} className="p-3 bg-bg border border-line rounded-xl flex items-center justify-between text-xs">
                      <div>
                        <span className="font-bold text-text">{req.clubName}</span>
                      </div>
                      <div>
                        {req.status === 'pending' && (
                          <span className="px-2.5 py-0.5 bg-warning/15 border border-warning/40 text-warning font-bold text-[10px] uppercase rounded-full flex items-center gap-1">
                            <Clock className="w-3 h-3" /> Pending Review
                          </span>
                        )}
                        {req.status === 'accepted' && (
                          <span className="px-2.5 py-0.5 bg-accent/15 border border-accent/40 text-accent font-bold text-[10px] uppercase rounded-full flex items-center gap-1">
                            <Check className="w-3 h-3" /> Accepted & Joined
                          </span>
                        )}
                        {req.status === 'rejected' && (
                          <span className="px-2.5 py-0.5 bg-danger/15 border border-danger/40 text-danger font-bold text-[10px] uppercase rounded-full flex items-center gap-1">
                            <X className="w-3 h-3" /> Rejected
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

          </div>
        )}

        {/* TAB 5: SUPER USER / DEVELOPER DASHBOARD */}
        {activeTab === 'superuser' && isSuperUser && (
          <div className="space-y-6">
            <div className="bg-surface border-2 border-accent p-6 md:p-8 rounded-3xl shadow-2xl space-y-5">

              <div className="flex items-center justify-between border-b border-line pb-4">
                <div>
                  <h2 className="text-lg font-black text-accent uppercase tracking-wider flex items-center gap-2">
                    <Sparkles className="w-5 h-5" /> SUPER USER DEVELOPER CONTROL PANEL
                  </h2>
                  <p className="text-xs text-text-muted mt-1">
                    Special developer privileges: Manage all clubs, bypass request approvals, override admins, and monitor network health.
                  </p>
                </div>
                <span className="px-3 py-1 bg-accent text-accent-contrast font-black text-xs uppercase rounded-full">
                  Developer Mode
                </span>
              </div>

              {/* Quick System Stats */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="p-4 bg-bg border border-line rounded-2xl text-center">
                  <div className="text-2xl font-black text-accent">{rawClubs.length}</div>
                  <div className="text-[10px] text-text-muted uppercase tracking-wider font-bold">Total Clubs</div>
                </div>
                <div className="p-4 bg-bg border border-line rounded-2xl text-center">
                  <div className="text-2xl font-black text-accent">
                    {rawClubs.reduce((acc, c) => acc + (c.members?.length || 0), 0)}
                  </div>
                  <div className="text-[10px] text-text-muted uppercase tracking-wider font-bold font-mono">Total Club Players</div>
                </div>
                <div className="p-4 bg-bg border border-line rounded-2xl text-center">
                  <div className="text-2xl font-black text-accent">{requests.filter(r => r.status === 'pending').length}</div>
                  <div className="text-[10px] text-text-muted uppercase tracking-wider font-bold font-mono">Pending System Reqs</div>
                </div>
                <div className="p-4 bg-bg border border-line rounded-2xl text-center">
                  <div className="text-2xl font-black text-accent">50 Max</div>
                  <div className="text-[10px] text-text-muted uppercase tracking-wider font-bold">Cap per Club</div>
                </div>
              </div>

              {/* All System Clubs Management */}
              <div className="space-y-3 pt-2">
                <h3 className="text-sm font-bold text-text uppercase tracking-wider">
                  Manage All System Clubs (Super User Override)
                </h3>

                <div className="space-y-3">
                  {rawClubs.map((c) => {
                    const isExpanded = expandedClubMembersId === c.id;
                    const membersList = c.members;

                    return (
                      <div key={c.id} className="p-4 bg-bg border border-line rounded-2xl space-y-3">
                        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
                          <div>
                            <div className="text-sm font-bold text-text flex items-center gap-2">
                              {c.name}
                              <span className="text-[10px] text-text-muted font-mono">({membersList.length}/{c.maxCapacity || 50} Members)</span>
                            </div>
                            <div className="text-xs text-text-muted">
                              Created by: {c.owner.displayName}
                            </div>
                          </div>

                          <div className="flex items-center gap-2 flex-wrap">
                            <button
                              type="button"
                              onClick={() => setExpandedClubMembersId(isExpanded ? null : c.id)}
                              className="bg-surface hover:bg-surface-alt text-accent border border-line font-bold px-3 py-1.5 rounded-xl text-xs uppercase cursor-pointer flex items-center gap-1"
                            >
                              <Users className="w-3.5 h-3.5" />
                              {isExpanded ? 'Hide Members' : `Manage Members (${membersList.length})`}
                            </button>

                            {!c.isMember && (
                              <button
                                onClick={async () => {
                                  await clubsApi.superuserJoin(c.id);
                                  alert(`Added yourself as Admin to ${c.name}`);
                                  await refresh();
                                }}
                                className="bg-accent text-accent-contrast font-black px-3 py-1.5 rounded-xl text-xs uppercase cursor-pointer"
                              >
                                Super Join as Admin
                              </button>
                            )}

                            <button
                              onClick={async () => {
                                if (confirm(`Are you sure you want to delete club "${c.name}"?`)) {
                                  await clubsApi.deleteClub(c.id);
                                  alert(`Deleted ${c.name}`);
                                  await refresh();
                                }
                              }}
                              className="bg-danger/15 hover:bg-danger/25 border border-danger/40 text-danger font-bold px-3 py-1.5 rounded-xl text-xs uppercase cursor-pointer"
                            >
                              Delete Club
                            </button>
                          </div>
                        </div>

                        {/* Expandable Member List for SuperUser Deletion */}
                        {isExpanded && (
                          <div className="pt-3 border-t border-line/60 space-y-2">
                            <div className="text-xs font-bold text-accent uppercase tracking-wider flex items-center gap-1.5">
                              <ShieldCheck className="w-4 h-4" /> Club Members ({membersList.length})
                            </div>

                            {membersList.length === 0 ? (
                              <div className="text-xs text-text-muted italic py-2">No members in this club.</div>
                            ) : (
                              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
                                {membersList.map((m) => {
                                  const isOwner = m.id === c.ownerId;
                                  const isAdmin = c.admins.some(a => a.id === m.id) || isOwner;

                                  return (
                                    <div key={m.id} className="p-2.5 bg-surface border border-line rounded-xl flex items-center justify-between gap-2 text-xs">
                                      <div className="space-y-0.5 truncate">
                                        <div className="font-bold text-text flex items-center gap-1.5 truncate">
                                          <span className="truncate">{m.displayName || m.email}</span>
                                          {isOwner && (
                                            <span className="text-[9px] bg-warning/15 text-warning border border-warning/40 px-1.5 py-0.2 rounded uppercase shrink-0 font-bold">
                                              Owner
                                            </span>
                                          )}
                                          {!isOwner && isAdmin && (
                                            <span className="text-[9px] bg-accent/15 text-accent border border-accent/40 px-1.5 py-0.2 rounded uppercase shrink-0 font-bold">
                                              Admin
                                            </span>
                                          )}
                                        </div>
                                        <div className="text-[10px] text-text-muted font-mono truncate">
                                          {m.email}
                                        </div>
                                      </div>

                                      {!isOwner && (
                                        <button
                                          type="button"
                                          onClick={async () => {
                                            if (confirm(`Are you sure you want to remove user "${m.displayName}" from club "${c.name}"?`)) {
                                              try {
                                                await clubsApi.removeMember(c.id, m.id);
                                                alert(`Removed ${m.displayName} from ${c.name}`);
                                                await refresh();
                                              } catch (err) {
                                                console.error('Failed to remove user:', err);
                                                alert('Failed to remove user from club.');
                                              }
                                            }
                                          }}
                                          className="px-2.5 py-1 bg-danger/15 hover:bg-danger/25 border border-danger/40 text-danger text-[10px] font-bold uppercase rounded-lg cursor-pointer transition-colors shrink-0"
                                        >
                                          Delete User
                                        </button>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

            </div>
          </div>
        )}

      </main>

      {/* MOBILE STICKY BOTTOM NAVIGATION BAR */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-50 bg-bg/95 backdrop-blur-xl border-t border-line py-2 px-1 flex items-center shadow-2xl">
        <button
          onClick={() => setActiveTab('myClubs')}
          className={`flex-1 min-w-0 flex flex-col items-center gap-1 px-0.5 py-1 rounded-xl transition-all cursor-pointer min-h-[48px] justify-center ${
            activeTab === 'myClubs' ? 'text-accent' : 'text-text-muted hover:text-text'
          }`}
        >
          <Users className="w-5 h-5" />
          <span className="text-[8px] font-bold uppercase tracking-tight font-sans leading-tight truncate max-w-full">My Clubs</span>
        </button>

        <button
          onClick={() => setActiveTab('browse')}
          className={`flex-1 min-w-0 flex flex-col items-center gap-1 px-0.5 py-1 rounded-xl transition-all cursor-pointer min-h-[48px] justify-center ${
            activeTab === 'browse' ? 'text-accent' : 'text-text-muted hover:text-text'
          }`}
        >
          <Search className="w-5 h-5" />
          <span className="text-[8px] font-bold uppercase tracking-tight font-sans leading-tight truncate max-w-full">Browse</span>
        </button>

        <button
          onClick={() => setActiveTab('create')}
          className={`flex-1 min-w-0 flex flex-col items-center gap-1 px-0.5 py-1 rounded-xl transition-all cursor-pointer min-h-[48px] justify-center ${
            activeTab === 'create' ? 'text-accent' : 'text-text-muted hover:text-text'
          }`}
        >
          <Plus className="w-5 h-5" />
          <span className="text-[8px] font-bold uppercase tracking-tight font-sans leading-tight truncate max-w-full">Create</span>
        </button>

        <button
          onClick={() => setActiveTab('requests')}
          className={`flex-1 min-w-0 flex flex-col items-center gap-1 px-0.5 py-1 rounded-xl transition-all cursor-pointer relative min-h-[48px] justify-center ${
            activeTab === 'requests' ? 'text-accent' : 'text-text-muted hover:text-text'
          }`}
        >
          <div className="relative">
            <Bell className="w-5 h-5" />
            {pendingAdminRequests.length > 0 && (
              <span className="absolute -top-1 -right-1.5 bg-danger text-white font-black text-[8px] w-3.5 h-3.5 rounded-full flex items-center justify-center">
                {pendingAdminRequests.length}
              </span>
            )}
          </div>
          <span className="text-[8px] font-bold uppercase tracking-tight font-sans leading-tight truncate max-w-full">Requests</span>
        </button>

        {isSuperUser && (
          <button
            onClick={() => setActiveTab('superuser')}
            className={`flex-1 min-w-0 flex flex-col items-center gap-1 px-0.5 py-1 rounded-xl transition-all cursor-pointer min-h-[48px] justify-center ${
              activeTab === 'superuser' ? 'text-accent' : 'text-text-muted hover:text-text'
            }`}
          >
            <Sparkles className="w-5 h-5" />
            <span className="text-[8px] font-bold uppercase tracking-tight font-sans leading-tight truncate max-w-full">Super</span>
          </button>
        )}

        <button
          onClick={() => setShowAccountSettings(true)}
          className="flex-1 min-w-0 flex flex-col items-center gap-1 px-0.5 py-1 rounded-xl transition-all cursor-pointer min-h-[48px] justify-center text-text-muted hover:text-text"
        >
          {playerAvatarUrl ? (
            <img src={playerAvatarUrl} alt="Avatar" className="w-5 h-5 rounded-full object-cover border border-accent" />
          ) : (
            <UserCircle className="w-5 h-5" />
          )}
          <span className="text-[8px] font-bold uppercase tracking-tight font-sans leading-tight truncate max-w-full">Profile</span>
        </button>
      </nav>

      {showAccountSettings && <AccountSettingsModal onClose={() => setShowAccountSettings(false)} />}
    </div>
  );
};
