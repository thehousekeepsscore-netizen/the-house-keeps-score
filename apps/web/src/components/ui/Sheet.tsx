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
 * Mounted only while the sheet is open, so its lifecycle *is* the sheet's:
 *
 *   mount      push an entry at the current URL, marked with this sheet's id
 *   Back       the marker disappears, so the sheet closes and nothing navigates
 *   unmount    if the entry is still ours, pop it, so closing by button,
 *              backdrop or Escape leaves the history stack as it found it
 *
 * A separate component rather than a hook inside Sheet, because Sheet must keep
 * working outside a router — every existing Sheet test renders it bare, and
 * hooks cannot be called conditionally while components can be rendered so.
 */
const SheetHistoryEntry: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const navigate = useNavigate();
  const location = useLocation();

  const idRef = useRef(`sheet-${Math.random().toString(36).slice(2, 9)}`);
  const pushedRef = useRef(false);
  // Only treat a missing marker as a Back press once the marker has actually
  // been seen. The push below is asynchronous, so this effect runs once against
  // the pre-push location — without this the sheet would close the instant it
  // opened.
  const sawMarkerRef = useRef(false);

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const locationRef = useRef(location);
  locationRef.current = location;

  useEffect(() => {
    const { pathname, search, hash, state } = locationRef.current;
    // Same URL, new entry. The address bar is unchanged — a sheet is not a
    // place, it is a thing open on top of one — but the stack gains a step for
    // Back to consume.
    navigate(
      { pathname, search, hash },
      { state: { ...(state as Record<string, unknown> | null), __sheet: idRef.current } }
    );
    pushedRef.current = true;

    return () => {
      // Closed by something other than Back, so our entry is still on the
      // stack. Leaving it there would make the next Back a no-op that looks
      // like the gesture broke.
      if (pushedRef.current) navigate(-1);
    };
  }, [navigate]);

  useEffect(() => {
    const isOurs =
      (location.state as { __sheet?: string } | null)?.__sheet === idRef.current;

    if (isOurs) {
      sawMarkerRef.current = true;
      return;
    }
    if (!sawMarkerRef.current) return;

    // The marker was there and is gone: Back popped our entry. The history is
    // already where it should be, so close without navigating again.
    pushedRef.current = false;
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

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Rendered under the title. Keep it short — this is read at a table. */
  description?: string;
  children?: React.ReactNode;
  /** The action row. Buttons here are within thumb reach by construction. */
  footer?: React.ReactNode;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export const Sheet: React.FC<SheetProps> = ({ open, onClose, title, description, children, footer }) => {
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
        className="
 relative w-full sm:max-w-md
 furniture furniture-raised
 rounded-t-3xl sm:rounded-3xl
 outline-none
 max-h-[90vh] flex flex-col
 animate-[sheet-up_220ms_cubic-bezier(0.32,0.72,0,1)]
 sm:animate-[fade-in_160ms_ease-out]
 safe-bottom
 "
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
