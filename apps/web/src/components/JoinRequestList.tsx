import React, { useState } from 'react';
import { Check, X, ChevronDown, ChevronUp, UserPlus, AlertCircle } from 'lucide-react';
import { ClubJoinRequest } from '../types';
import { Button } from './ui/Button';
import { useConfirm } from './ui/ConfirmDialog';
import { ApiError } from '../lib/api-client';

/**
 * People asking to join, and one place that decides.
 *
 * Rendered in two contexts from one implementation:
 *
 *   ClubDashboardView   every club this admin runs, so each row names its club
 *   ClubDetailView      one club, where repeating the name on every row is noise
 *
 * The difference is `showClubName` and nothing else. Two copies of this
 * interaction would drift the moment one of them grew a state the other did
 * not — which is exactly what happened to the settlement engine.
 *
 * THE INTERACTION IS #20's, and for the same reason. Collapsed is the state
 * this list spends its life in: an admin glances, recognises a name, decides.
 * The compact ticks are quick to reach and easy to mis-tap, so they ASK first.
 * The expanded buttons are labelled, deliberate and carry their weight in
 * their own size and wording, so they act directly.
 *
 * NO `alert()`. A browser dialog blocks the page, cannot be styled, and says
 * nothing useful — the screen this replaced used one for every failure,
 * including the failure that is not really a failure (below).
 *
 * BUILT TO BE REUSED. The row shape here — avatar, who, when, one pair of
 * decisions — is the same shape a historical bank correction will need. That
 * is why the decision handler is injected rather than assumed, and why the
 * empty and error copy are props. It is not, however, generic for its own
 * sake: nothing here is abstracted until a second caller actually needs it.
 */

/** What went wrong, in the only three ways that need different words. */
export type JoinRequestFailure =
  /** Somebody else decided it first. Not an error — the list is just stale. */
  | { kind: 'stale'; message: string }
  /** The API refused this admin. The UI showed an action it should not have. */
  | { kind: 'forbidden'; message: string }
  | { kind: 'unknown'; message: string };

export function classifyJoinRequestError(err: unknown): JoinRequestFailure {
  const status = err instanceof ApiError ? err.status : undefined;

  if (status === 409) {
    return {
      kind: 'stale',
      message: 'Another admin already handled that request.',
    };
  }
  if (status === 403) {
    return {
      kind: 'forbidden',
      // Deliberately not "you can't do that": the useful information is that
      // the screen was wrong, not that the person was.
      message: 'You do not have permission to decide this request.',
    };
  }
  return {
    kind: 'unknown',
    message: err instanceof Error && err.message ? err.message : 'Could not update that request.',
  };
}

export interface JoinRequestListProps {
  requests: ClubJoinRequest[];
  /** Never loaded yet — the only case that warrants a skeleton. */
  loading?: boolean;
  /** Failed to LOAD the list, as opposed to failing to decide one row. */
  loadError?: string | null;
  onRetryLoad?: () => void;
  /**
   * Decides one request. Throws to signal failure; the thrown error is
   * classified here so every caller reports the same three outcomes.
   */
  onDecide: (request: ClubJoinRequest, accept: boolean) => Promise<void>;
  /** Called after a stale decision, so the caller can refetch. */
  onStale?: () => void;
  /** Cross-club lists say which club; a club-scoped list already knows. */
  showClubName?: boolean;
  title?: string;
  emptyMessage?: string;
}

/** "3 Feb, 19:40" — the date AND the time, because two requests can share a day. */
function requestedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export const JoinRequestList: React.FC<JoinRequestListProps> = ({
  requests,
  loading = false,
  loadError = null,
  onRetryLoad,
  onDecide,
  onStale,
  showClubName = false,
  title = 'Join requests',
  emptyMessage = 'Nobody is waiting to join.',
}) => {
  const [expanded, setExpanded] = useState(false);
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const [failure, setFailure] = useState<JoinRequestFailure | null>(null);
  const confirm = useConfirm();

  const pendingRequests = requests.filter((r) => r.status === 'pending');

  const decide = async (request: ClubJoinRequest, accept: boolean) => {
    // A second tap on a row already in flight is a double decision, and the
    // API would answer the second one with a 409 it never needed to see.
    if (pending.has(request.id)) return;

    setFailure(null);
    setPending((prev) => new Set(prev).add(request.id));
    try {
      await onDecide(request, accept);
    } catch (err) {
      const classified = classifyJoinRequestError(err);
      setFailure(classified);
      // A stale row is not a failed action — somebody decided it, just not
      // this admin. Refetching is the correct response, and it is what makes
      // the row disappear rather than sit there looking broken.
      if (classified.kind === 'stale') onStale?.();
    } finally {
      setPending((prev) => {
        const next = new Set(prev);
        next.delete(request.id);
        return next;
      });
    }
  };

  const askThenDecide = (request: ClubJoinRequest, accept: boolean) =>
    confirm({
      title: accept ? 'Accept this request?' : 'Reject this request?',
      // Names the person and the club, because a tick in a small target is
      // easy to hit by accident and "are you sure?" does not say who.
      description: `${request.userDisplayName}${showClubName ? ` · ${request.clubName}` : ''}`,
      confirmLabel: accept ? 'Accept' : 'Reject',
      onConfirm: () => decide(request, accept),
    });

  return (
    <section
      aria-label={title}
      className="furniture rounded-[var(--radius-lg)] overflow-hidden"
      data-testid="join-request-list"
    >
      <div className="px-4 pt-3 pb-2 flex items-center gap-2">
        <UserPlus className="w-4 h-4 text-text-muted" aria-hidden="true" />
        <h2 className="text-[11px] uppercase tracking-[0.18em] text-text-muted">{title}</h2>
        {pendingRequests.length > 0 && (
          <span className="text-[11px] font-semibold text-accent tabular-nums">
            {pendingRequests.length}
          </span>
        )}
        {pendingRequests.length > 0 && (
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            className="ml-auto flex items-center gap-1 text-[10px] uppercase tracking-[0.14em] text-text-muted hover:text-text cursor-pointer"
          >
            {expanded ? 'Collapse' : 'Expand'}
            {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </button>
        )}
      </div>

      {/* Announced rather than only drawn: an admin who just acted needs to be
          told the outcome even if the row has already left the list. */}
      {failure && (
        <div
          role="status"
          className={`mx-4 mb-2 px-3 py-2 rounded-[var(--radius-md)] text-xs flex items-start gap-2 ${
            failure.kind === 'stale'
              ? 'bg-surface-alt text-text-muted'
              : 'bg-danger/10 border border-danger/30 text-danger'
          }`}
        >
          <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />
          <span>{failure.message}</span>
        </div>
      )}

      {loading ? (
        <div className="px-4 pb-4 space-y-2" data-testid="join-requests-loading">
          {[0, 1].map((i) => (
            <div key={i} className="h-12 rounded-[var(--radius-md)] bg-surface-alt animate-pulse" />
          ))}
        </div>
      ) : loadError ? (
        <div className="px-4 pb-4">
          <p className="text-xs text-danger mb-2">{loadError}</p>
          {onRetryLoad && (
            <Button variant="ghost" size="sm" onClick={onRetryLoad}>
              Try again
            </Button>
          )}
        </div>
      ) : pendingRequests.length === 0 ? (
        <p className="px-4 pb-4 text-xs text-text-muted">{emptyMessage}</p>
      ) : (
        <ul>
          {pendingRequests.map((request) => {
            const busy = pending.has(request.id);
            return (
              <li
                key={request.id}
                className="px-4 py-2.5 flex items-center gap-3 border-t border-line/30"
              >
                {request.userAvatarUrl ? (
                  <img
                    src={request.userAvatarUrl}
                    alt=""
                    className="w-9 h-9 rounded-full object-cover border border-line shrink-0"
                  />
                ) : (
                  <div
                    aria-hidden="true"
                    className="w-9 h-9 rounded-full bg-surface-alt text-accent font-medium flex items-center justify-center text-sm border border-line shrink-0"
                  >
                    {(request.userDisplayName || 'P')[0].toUpperCase()}
                  </div>
                )}

                <div className="min-w-0 flex-1">
                  <p
                    title={request.userDisplayName}
                    className="text-sm font-semibold text-text truncate leading-tight"
                  >
                    {request.userDisplayName}
                  </p>
                  <p className="mt-0.5 flex items-baseline gap-2 text-[11px] text-text-muted leading-tight">
                    {showClubName && (
                      <span className="text-accent truncate">{request.clubName}</span>
                    )}
                    <span className="shrink-0 tabular-nums">{requestedAt(request.createdAt)}</span>
                  </p>
                </div>

                {!expanded ? (
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      aria-label={`Reject ${request.userDisplayName}`}
                      disabled={busy}
                      onClick={() => askThenDecide(request, false)}
                      className="w-9 h-9 rounded-full flex items-center justify-center text-text-muted hover:text-warning disabled:opacity-40 cursor-pointer"
                    >
                      <X className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      aria-label={`Accept ${request.userDisplayName}`}
                      disabled={busy}
                      onClick={() => askThenDecide(request, true)}
                      className="w-9 h-9 rounded-full bg-accent text-accent-contrast flex items-center justify-center disabled:opacity-40 cursor-pointer"
                    >
                      <Check className="w-4 h-4" />
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => decide(request, false)}
                      className="whitespace-nowrap"
                    >
                      Reject
                    </Button>
                    <Button
                      variant="primary"
                      size="sm"
                      loading={busy}
                      onClick={() => decide(request, true)}
                      className="whitespace-nowrap"
                    >
                      Accept
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {confirm.dialog}
    </section>
  );
};
