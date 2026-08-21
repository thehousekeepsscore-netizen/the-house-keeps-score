import React, { useCallback, useEffect, useRef } from 'react';
import { useInRouterContext, useLocation, useNavigate } from 'react-router-dom';

/**
 * Makes an open sheet a history entry, so the platform's own Back closes it.
 *
 * On a phone Back is the edge swipe, and it is the gesture people reach for
 * first to dismiss anything that slid up over the screen. Without this it does
 * the one thing nobody wants: leaves the screen behind the sheet — or the app —
 * while the sheet itself was the only thing they meant to dismiss.
 *
 * The obvious implementation is push-on-mount, pop-on-cleanup. It is wrong, and
 * wrong in a way no jsdom test caught. React double-invokes effects, and
 * `navigate` is queued rather than applied, so opening one sheet in a real
 * browser produced:
 *
 *     push · push · go(-1) · push
 *
 * The cleanup's pop ran against the index from *before* the push had committed,
 * so it consumed the entry for the page underneath — and the push that followed
 * truncated that page off the stack for good. Closing the sheet by backdrop,
 * button or Escape then stepped back onto whatever preceded it. From a club
 * table, that was the dashboard.
 *
 * So mounting and unmounting do not touch history at all. They only move a
 * count, and a task later one reconciliation step moves the stack to match it.
 * That makes mount → unmount → mount collapse into a single push, which is what
 * React's double invocation actually means. And an entry is only ever given
 * back when the live history state still shows it is ours, so a pop can never
 * consume a page somebody is standing on.
 *
 * A separate component rather than a hook inside Sheet, because Sheet must keep
 * working outside a router — every existing Sheet test renders it bare, and
 * hooks cannot be called conditionally while components can be rendered so.
 */
type NavigateFn = ReturnType<typeof useNavigate>;

const MARKER = '__sheet';

/** Sheets mounted right now. */
let want = 0;
/** Entries we have pushed and not yet given back. */
let have = 0;
let scheduled = false;

const markerOf = (state: unknown): number =>
  Number((state as Record<string, unknown> | null)?.[MARKER] ?? 0);

/**
 * True when this entry is still the one we pushed.
 *
 * `have` alone is nearly enough — the location effect below decrements it the
 * moment Back takes our entry away — but it cannot see a Back press that lands
 * in the gap between unmount and the reconciliation below. So when a real
 * browser history is underneath, confirm against the entry the browser is
 * actually sitting on before giving anything back.
 *
 * react-router's browser history stamps every entry with `idx`; a memory router
 * never touches `window.history` at all. Checking for that rather than for the
 * marker is what keeps the two paths honest: a guard that quietly did nothing
 * under a memory router is how the original bug survived five passing tests.
 */
function stillOurs(): boolean {
  const state = window.history.state as { usr?: unknown; idx?: number } | null;
  if (state == null || typeof state.idx !== 'number') return true;
  return markerOf(state.usr) > have;
}

/**
 * Move the stack one step towards `want`, then look again.
 *
 * One step per task, never a loop: `navigate` does not apply synchronously, so
 * a second step decided in the same tick would be reading a stack that has not
 * moved yet — the exact mistake that caused the bug above.
 */
function schedule(navigate: NavigateFn) {
  if (scheduled) return;
  scheduled = true;
  setTimeout(() => {
    scheduled = false;
    if (have === want) return;

    if (have < want) {
      // Same URL, new entry. The address bar is unchanged — a sheet is not a
      // place, it is a thing open on top of one — but the stack gains a step
      // for Back to consume.
      const { pathname, search, hash } = window.location;
      const usr = (window.history.state as { usr?: Record<string, unknown> } | null)?.usr;
      have += 1;
      navigate({ pathname, search, hash }, { state: { ...usr, [MARKER]: have } });
    } else {
      have -= 1;
      if (stillOurs()) navigate(-1);
    }

    schedule(navigate);
  }, 0);
}

/** Test seam: module state outlives a single test, and a leak fails the next. */
export function __resetSheetHistory() {
  want = 0;
  have = 0;
  scheduled = false;
}

const SheetHistoryEntry: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const navigate = useNavigate();
  const location = useLocation();

  const depthRef = useRef(0);
  // Only treat a missing marker as a Back press once our own entry has actually
  // arrived. The push is asynchronous, so this runs first against the pre-push
  // location — without this the sheet would close the instant it opened.
  const landedRef = useRef(false);

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    depthRef.current = want += 1;
    schedule(navigate);
    return () => {
      want -= 1;
      schedule(navigate);
    };
  }, [navigate]);

  useEffect(() => {
    if (markerOf(location.state) >= depthRef.current) {
      landedRef.current = true;
      return;
    }
    if (!landedRef.current) return;

    // Our entry was there and is gone: Back consumed it. The browser has
    // already done the popping, so close without navigating again — and stop
    // counting an entry that no longer exists.
    landedRef.current = false;
    have = Math.max(0, have - 1);
    onCloseRef.current();
  }, [location]);

  return null;
};

/**
 * A bottom sheet. The app's one dialog surface.
 *
 * Bottom-anchored rather than centred, and that is the whole point rather than a
 * style preference. A centred dialog puts its actions in the middle of the
 * screen and its close button in the top-right corner — the two positions a
 * thumb reaches least well on a phone held in one hand. A sheet rising from the
 * bottom puts its actions where the thumb already is.
 *
 * The app is used standing at a poker table, one-handed, mid-conversation. That
 * is the situation this component is designed for; see PRODUCT-PRINCIPLES.md.
 *
 * Replaces eleven hand-rolled `fixed inset-0` blocks that shared no structure,
 * and the forty native alert()/confirm() dialogs that shared none of the app's
 * design at all.
 *
 * What it handles that hand-rolled dialogs did not:
 *
 *   safe areas    padding-bottom of env(safe-area-inset-bottom), so the actions
 *                 clear the iPhone home indicator instead of sitting under it
 *   focus trap    Tab cannot escape into the page behind
 *   Escape        closes, as every dialog on every platform does
 *   restore       focus returns to whatever opened the sheet
 *   scroll lock   the page behind does not scroll under the sheet
 *   labelling     role="dialog" + aria-modal + aria-labelledby
 *
 * On viewports at `sm` and above it centres and behaves as a conventional
 * dialog: desktop is an adaptation of the phone design, not its source.
 */

type Size = 'md' | 'lg';

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Rendered under the title. Keep it short — this is read at a table. */
  description?: string;
  children?: React.ReactNode;
  /** The action row. Buttons here are within thumb reach by construction. */
  footer?: React.ReactNode;
  /**
   * How wide the panel is allowed to get ON DESKTOP, and nothing else.
   *
   * Not the same axis as Button's `size`, which is control height and type
   * scale. Below `sm` the panel is `w-full` either way, so this changes nothing
   * in the hand — reach for it when a surface has genuinely more to say at a
   * desk, never to win room for a layout that is tight on a phone.
   */
  size?: Size;
}

/*
 * Written out in full rather than composed, because Tailwind v4 scans the
 * source for class names: `sm:max-w-${size}` generates no CSS at all. Exactly
 * one of these reaches the panel — there is no class-merge helper in this app,
 * so two max-widths would be settled by stylesheet order rather than by intent.
 */
const SIZES: Record<Size, string> = {
  md: 'sm:max-w-md',
  lg: 'sm:max-w-lg',
};

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export const Sheet: React.FC<SheetProps> = ({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
}) => {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const titleId = useRef(`sheet-${Math.random().toString(36).slice(2, 9)}`);
  // Sheet is used in tests and stories with no router around it, and a missing
  // Back gesture is a far smaller loss than a component that refuses to render.
  const inRouter = useInRouterContext();

  // Remember what had focus so it can be given back. Without this, closing a
  // sheet dumps focus onto <body> and a keyboard user restarts from the top of
  // the page every time.
  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    return () => restoreRef.current?.focus?.();
  }, [open]);

  // Move focus into the sheet on open, preferring the first control over the
  // panel itself so the first Tab does something useful.
  useEffect(() => {
    if (!open) return;
    const first = panelRef.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panelRef.current)?.focus();
  }, [open]);

  // The page behind must not scroll. On iOS a sheet over a scrolling page is the
  // clearest sign that something is a web page rather than an app.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;

      // Focus trap. Without it, Tab walks out of the sheet and into the page
      // behind, where the user cannot see what is focused.
      const nodes = Array.from(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
      if (nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [onClose]
  );

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center sm:justify-center"
      onKeyDown={onKeyDown}
    >
      {inRouter && <SheetHistoryEntry onClose={onClose} />}
      {/*
        The backdrop closes on tap, which is what every native sheet does and
        what none of the replaced native dialogs could do. aria-hidden because it
        is decoration; the real close paths are Escape, the button, and this tap.
      */}
      <div
        className="absolute inset-0 bg-black/72 backdrop-blur-[3px] animate-[fade-in_160ms_ease-out]"
        onClick={onClose}
        aria-hidden="true"
      />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId.current}
        tabIndex={-1}
        className={`
 relative w-full ${SIZES[size]}
 furniture furniture-raised
 rounded-t-3xl sm:rounded-3xl
 outline-none
 max-h-[90vh] flex flex-col
 animate-[sheet-up_220ms_cubic-bezier(0.32,0.72,0,1)]
 sm:animate-[fade-in_160ms_ease-out]
 safe-bottom
 `}
      >
        {/* Grab handle. Purely a signifier that this surface came from the
            bottom and can be dismissed downward — the convention every native
            sheet uses to say so without words. */}
        <div className="sm:hidden pt-3 pb-1 flex justify-center shrink-0">
          <div className="w-9 h-1 rounded-full bg-line-strong" />
        </div>

        <div className="px-5 pt-3 pb-4 shrink-0">
          <h2 id={titleId.current} className="text-base font-semibold text-text">
            {title}
          </h2>
          {description && (
            <p className="mt-1.5 text-sm text-text-muted leading-relaxed">{description}</p>
          )}
        </div>

        {children && <div className="px-5 pb-4 overflow-y-auto">{children}</div>}

        {footer && <div className="px-5 pt-1 flex flex-col-reverse sm:flex-row gap-2 shrink-0">{footer}</div>}
      </div>
    </div>
  );
};
