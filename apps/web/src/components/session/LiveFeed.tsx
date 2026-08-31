import React, { useEffect, useRef, useState } from 'react';
import {
  Timer, Flag, Play, UserRound, CirclePlus, Coins, Banknote,
  CircleCheck, ArrowUp, ClipboardList, Undo2, type LucideIcon,
} from 'lucide-react';
import { FeedEvent, FeedKind, agoLabel, feedLine } from '../../lib/night-feed';

/**
 * The story rendered in the room's own hand.
 *
 * These were emoji, and emoji are the one glyph set the app cannot light: they
 * arrive pre-coloured in the OS's style, differently on every phone at the
 * table, in a feed whose job is to look the same to everyone. Line icons take
 * the room's palette like everything else.
 */
const GLYPH: Record<FeedKind, LucideIcon> = {
  'timer-started': Timer,
  'timer-extended': Timer,
  'timer-extended-many': Timer,
  'timer-reached': Flag,
  'timer-lifted': Play,
  joined: UserRound,
  'bought-in': CirclePlus,
  'topped-up': Coins,
  // A correction, not an event in the game — the only line here that undoes
  // something rather than reporting it.
  voided: Undo2,
  'stood-up': Banknote,
  left: CircleCheck,
  ceiling: ArrowUp,
  settled: Flag,
  'rules-set': ClipboardList,
};

/**
 * The story of the night, under the table.
 *
 * The bottom half of a PLAYER's screen used to say "You're in for 3,000" and
 * then nothing at all, for hours. Players do not approve anything — they watch
 * — and the honest thing to put in that space is not statistics but the room:
 * who sat down, who topped up, who has gone home, and what the maximum is now.
 * Four lines of it and you know how the evening is going without anyone saying
 * a word.
 *
 * Deliberately not chat and not notifications. Nothing here can be replied to,
 * nothing here is unread, and nothing here is about a workflow — see
 * night-feed.ts, which refuses to say "requested" or "pending" at all.
 *
 * ONE THING MOVES. Only the newest line animates, and only when it is genuinely
 * new rather than on first paint. Everything else holds absolutely still. The
 * rule the whole app keeps (PRODUCT-BRIEF §2.6, the eye never has to choose)
 * matters most in the one region that changes on its own while nobody is
 * looking at it.
 */

export const LiveFeed: React.FC<{
  events: FeedEvent[];
  nameOf: (userId: string) => string;
  formatAmount: (n: number) => string;
}> = ({ events, nameOf, formatAmount }) => {
  // Coarse on purpose. The labels are "just now" / "18 sec ago" / "3 min ago",
  // so a one-second timer would re-render the list sixty times to change one
  // word — the same reasoning as the header's clock.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(id);
  }, []);

  // What was at the top last time. On first paint there is no "last time", so
  // nothing animates — arriving at a table is not an event.
  const newest = events[0]?.id ?? null;
  const seenRef = useRef<string | null>(null);
  const settledRef = useRef(false);
  const animateId = settledRef.current && newest !== seenRef.current ? newest : null;
  useEffect(() => {
    seenRef.current = newest;
    settledRef.current = true;
  }, [newest]);

  if (events.length === 0) return null;

  return (
    <section
      aria-label="Tonight"
      className="flex-1 min-h-0 flex flex-col px-4 pt-3"
    >
      <div className="shrink-0 flex items-center gap-3 pb-2">
        <span className="h-px flex-1 bg-line" />
        <span className="text-[10px] uppercase tracking-[0.22em] text-text-faint">Tonight</span>
        <span className="h-px flex-1 bg-line" />
      </div>

      {/*
        aria-live is deliberately absent. A screen reader announcing every
        buy-in at a poker table would talk over the room all evening; the feed
        is a place you look, not a thing that interrupts.
      */}
      <ul className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
        {events.map((event) => {
          const { text } = feedLine(event, nameOf, formatAmount);
          const Glyph = GLYPH[event.kind];
          return (
            <li
              key={event.id}
              className={`flex items-start gap-2.5 py-1.5 ${
                event.id === animateId
                  ? 'animate-[feed-in_var(--motion-enter)_cubic-bezier(0.32,0.72,0,1)]'
                  : ''
              }`}
            >
              <span aria-hidden="true" className="shrink-0 w-5 flex justify-center pt-[3px]">
                <Glyph className="w-3.5 h-3.5 text-accent/80" strokeWidth={1.75} />
              </span>
              <p className="min-w-0 flex-1 text-[13px] text-text-muted leading-5">
                {text}
                <span className="ml-2 text-[11px] text-text-faint tabular-nums whitespace-nowrap">
                  {agoLabel(event.at, now)}
                </span>
              </p>
            </li>
          );
        })}
      </ul>
    </section>
  );
};
