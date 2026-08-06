import React from 'react';
import { Coins, AlertCircle } from 'lucide-react';
import { Club } from '../types';
import { SettlementResult } from '../lib/settlementEngine';

/**
 * The one place a settlement is shown to a human.
 *
 * Three flows end in the same question — "here is what the club's rules say
 * everyone owes, do you want to commit it?" — and each used to answer it with
 * its own layout: settling a live night, recording a back-dated one, and
 * editing a night already recorded. Same engine, same figures, three different
 * shapes on screen, which made them read as three unrelated features.
 *
 * Everything here is driven by a `SettlementResult`, so the three callers can
 * keep the input controls that genuinely differ (a live table has locked
 * cash-outs, a back-dated night needs a date and a member picker, an edit
 * needs account links) and share the part that shouldn't differ at all.
 *
 * Amounts are always in Chips. The Chips/₹ switch belongs to History and the
 * Leaderboard, where you are reading past results; these screens are where you
 * enter and commit chip counts, so showing rupees would invite entering them.
 */

/** Right-aligned amount column with tabular figures so digits line up. */
function Row({
  label,
  amount,
  tone = 'muted',
  indent = false,
  strong = false,
}: {
  label: React.ReactNode;
  amount: string;
  tone?: 'muted' | 'good' | 'bad' | 'accent';
  indent?: boolean;
  strong?: boolean;
}) {
  const toneClass =
    tone === 'good' ? 'text-accent' : tone === 'bad' ? 'text-danger' : tone === 'accent' ? 'text-accent' : 'text-text';
  return (
    <div className={`flex items-baseline gap-3 ${indent ? 'pl-2 text-text-faint' : 'text-text-muted'}`}>
      <span className="flex-1 min-w-0 truncate">{label}</span>
      <span className={`shrink-0 text-right ${strong ? 'font-semibold' : ''} ${indent ? '' : toneClass}`}>{amount}</span>
    </div>
  );
}

export interface SettlementPreviewProps {
  result: SettlementResult;
  club: Club;
  /** Chips formatter, e.g. "1,350 Chips". */
  formatAmount: (chips: number) => string;
  /** Signed chips formatter, e.g. "+1,350 Chips". */
  formatSigned: (chips: number) => string;
  /**
   * 'balance' projects the club pot after committing — right when the pot is
   * gaining this night's share for the first time.
   * 'share' shows only what this night contributes, which is what an edit can
   * honestly say: saving reverses the session's previous share before applying
   * the new one, and the old figure isn't known here.
   */
  potDisplay?: 'balance' | 'share';
  /** Supplied only where the admin can acknowledge a manual mismatch. */
  mismatchAcknowledgement?: { checked: boolean; onChange: (checked: boolean) => void };
}

export function SettlementPreview({
  result,
  club,
  formatAmount,
  formatSigned,
  potDisplay = 'balance',
  mismatchAcknowledgement,
}: SettlementPreviewProps) {
  const cutPercent = club.winnersCutPercent ?? 0;
  const flatRake = club.sessionRakeAmount ?? 0;
  const showHouseTake = flatRake > 0 || result.totalRakeCollected > 0;

  return (
    <div className="p-4 bg-bg border border-line rounded-2xl space-y-3">
      {/* Who ends up with what, and what came off them on the way. */}
      <div className="space-y-2 text-[11px] font-mono tabular-nums">
        {result.players.map((p) => (
          <div key={p.userId} className="space-y-0.5">
            <Row
              label={
                <span className="flex items-center gap-1.5">
                  {p.userDisplayName}
                  {p.isWinner && (
                    <span className="px-1.5 py-0.5 bg-accent/15 border border-accent/40 text-accent text-[8px] font-semibold uppercase rounded-full shrink-0">
                      Winner
                    </span>
                  )}
                </span>
              }
              amount={formatSigned(p.netResult)}
              tone={p.netResult >= 0 ? 'good' : 'bad'}
              strong
            />
            {p.mismatchDeduction !== 0 && (
              <Row indent label="Mismatch share" amount={formatSigned(-p.mismatchDeduction)} />
            )}
            {p.rakeDeduction !== 0 && (
              <Row indent label={`Winners' cut${cutPercent > 0 ? ` (${cutPercent}%)` : ''}`} amount={formatSigned(-p.rakeDeduction)} />
            )}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-2.5 text-center font-mono pt-1 border-t border-line">
        <div className="p-2.5 bg-surface rounded-xl">
          <div className="text-[9px] text-text-muted">Total buy-ins</div>
          <div className="text-xs font-medium text-text tabular-nums">{formatAmount(result.totalBuyIns)}</div>
        </div>
        <div className="p-2.5 bg-surface rounded-xl">
          <div className="text-[9px] text-text-muted">Total cash-outs</div>
          <div className="text-xs font-medium text-text tabular-nums">{formatAmount(result.totalCashOuts)}</div>
        </div>
      </div>

      {/* House take, split by source. The flat session rake is charged to the
          table rather than any one player, so it has no per-player row above
          and would otherwise be invisible. */}
      {showHouseTake && (
        <div className="space-y-1 text-[11px] font-mono tabular-nums pt-1 border-t border-line">
          {cutPercent > 0 && (
            <Row
              label={`Winners' cut (${cutPercent}%)`}
              amount={formatAmount(Math.max(0, result.totalRakeCollected - flatRake))}
            />
          )}
          {flatRake > 0 && <Row label="Session rake (flat)" amount={formatAmount(flatRake)} />}
          <div className="pt-1 border-t border-line">
            <Row label="House take" amount={formatAmount(result.totalRakeCollected)} tone="accent" strong />
          </div>
        </div>
      )}

      {/* The engine's own account of which rule fired and why — generated, not
          hand-written per case, so it can't drift from the maths. */}
      {result.steps.length > 0 && (
        <div className="space-y-1.5">
          {result.steps.map((s, idx) => (
            <div key={idx} className="p-2.5 bg-surface border border-line rounded-xl text-[11px] font-mono">
              <span className="text-accent font-semibold ">{s.step}: </span>
              <span className="text-text-muted">{s.detail}</span>
            </div>
          ))}
        </div>
      )}

      {result.requiresManualResolution && (
        <div className="p-3 bg-warning/15 border border-warning/40 rounded-xl space-y-2">
          <p className="text-warning text-[11px] font-mono">
            This club requires manual mismatch resolution. Reconcile the {Math.abs(result.mismatchAmount)} difference
            outside the app{mismatchAcknowledgement ? ', then confirm below.' : ' before saving.'}
          </p>
          {mismatchAcknowledgement && (
            <label className="flex items-center gap-2 text-[11px] font-medium text-text cursor-pointer">
              <input
                type="checkbox"
                checked={mismatchAcknowledgement.checked}
                onChange={(e) => mismatchAcknowledgement.onChange(e.target.checked)}
                className="w-4 h-4 accent-warning rounded cursor-pointer"
              />
              I've manually reconciled this mismatch
            </label>
          )}
        </div>
      )}

      {club.potEnabled && (
        <div className="p-3 bg-surface border border-accent/30 rounded-xl flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs font-medium text-text min-w-0 flex-1">
            <Coins className="w-4 h-4 text-accent shrink-0" />
            <span className="truncate">{potDisplay === 'share' ? 'Pot share' : 'Club Pot'}</span>
          </div>
          <div className="text-right font-mono tabular-nums shrink-0">
            {potDisplay === 'share' ? (
              <>
                <div className="text-sm font-semibold text-accent">{formatAmount(result.potContribution)}</div>
                <div className="text-[10px] text-text-muted">replaces previous</div>
              </>
            ) : (
              <>
                <div className="text-[10px] text-text-muted">
                  {formatAmount(club.clubPotBalance || 0)} {result.potContribution >= 0 ? '+' : '-'}{' '}
                  {formatAmount(Math.abs(result.potContribution))}
                </div>
                <div className="text-sm font-semibold text-accent">
                  {formatAmount((club.clubPotBalance || 0) + result.potContribution)}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export interface SettlementConfirmProps {
  result: SettlementResult;
  title: string;
  warning: string;
  formatSigned: (chips: number) => string;
}

/**
 * The last look before committing. All three flows write results that can't be
 * casually undone, so each restates the final per-player figures rather than
 * relying on the admin remembering the panel above.
 */
export function SettlementConfirm({ result, title, warning, formatSigned }: SettlementConfirmProps) {
  return (
    <div className="space-y-3 p-4 bg-bg border-2 border-warning rounded-2xl">
      <div className="flex items-start gap-2">
        <AlertCircle className="w-5 h-5 text-warning shrink-0 mt-0.5" />
        <div>
          <p className="text-sm font-semibold text-text ">{title}</p>
          <p className="text-[11px] text-text-muted mt-0.5">{warning}</p>
        </div>
      </div>
      <div className="space-y-1 text-[11px] font-mono tabular-nums border-t border-line pt-2.5">
        {result.players.map((p) => (
          <Row
            key={p.userId}
            label={p.userDisplayName}
            amount={formatSigned(p.netResult)}
            tone={p.netResult >= 0 ? 'good' : 'bad'}
            strong
          />
        ))}
        {result.potContribution !== 0 && (
          <div className="border-t border-line pt-1.5 mt-1.5">
            <Row label="To Club Pot" amount={formatSigned(result.potContribution)} tone="accent" strong />
          </div>
        )}
      </div>
    </div>
  );
}
