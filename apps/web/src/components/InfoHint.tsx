import React, { useEffect, useRef, useState } from 'react';
import { Info } from 'lucide-react';

interface InfoHintProps {
  /** The explanation. Keep it to a sentence or two. */
  children: React.ReactNode;
  /** Which side of the icon the bubble opens on. */
  align?: 'left' | 'right';
  className?: string;
  label?: string;
}

// Tap-to-reveal explanation, so screens can carry a short label instead of a
// paragraph. Tap rather than hover: the app is mobile-first, and hover
// tooltips are unreachable on touch.
//
// Not for anything the user must not miss — irreversible actions and errors
// stay as visible text.
export const InfoHint: React.FC<InfoHintProps> = ({
  children,
  align = 'left',
  className = '',
  label = 'More info',
}) => {
  const [open, setOpen] = useState(false);
  // Resolved at open time: an icon near the right edge must open leftwards or
  // the bubble runs off screen and clips its own text.
  const [side, setSide] = useState<'left' | 'right'>(align);
  const wrapRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open || !wrapRef.current) return;
    const BUBBLE = 224; // w-56
    const x = wrapRef.current.getBoundingClientRect().left;
    setSide(x + BUBBLE + 16 > window.innerWidth ? 'right' : 'left');
  }, [open]);

  // Dismiss on outside tap or Escape — a popover that traps the user is worse
  // than the paragraph it replaced.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <span ref={wrapRef} className={`relative inline-flex align-middle ${className}`}>
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        // tap-44: the icon stays 14px; only the hit area grows. See index.css.
        className={`tap-44 inline-flex items-center justify-center rounded-full transition cursor-pointer ${
 open ? 'text-accent' : 'text-text-faint hover:text-text-muted'
        }`}
      >
        <Info className="w-3.5 h-3.5" />
      </button>

      {open && (
        <span
          role="tooltip"
          className={`absolute top-full mt-1.5 z-50 w-56 max-w-[calc(100vw-2rem)] p-2.5 rounded-xl bg-surface border border-line-strong shadow-2xl text-[11px] leading-relaxed text-text-muted font-normal normal-case tracking-normal text-left ${
 side === 'right' ? 'right-0' : 'left-0'
          }`}
        >
          {children}
        </span>
      )}
    </span>
  );
};
