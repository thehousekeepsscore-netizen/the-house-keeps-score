import React, { useEffect, useRef, useState } from 'react';
import { Sheet } from './ui/Sheet';
import { Button } from './ui/Button';

/**
 * Developer instrumentation, at /debug/sheet-keyboard. Same spirit as
 * /debug/table: unlinked, and inside the authenticated tree so it is not a
 * public endpoint.
 *
 * WHY THIS EXISTS
 *
 * The settlement redesign assumes a tall Sheet with a summary pinned at the top
 * and the commit control pinned at the bottom, on a screen that is almost
 * entirely numeric entry. Whether that survives an on-screen keyboard could not
 * be established from source: jsdom has no viewport and no keyboard, and iOS
 * Safari does not move the layout viewport when the keyboard opens — only the
 * visual viewport. `dvh` tracks the layout viewport, so it does not help here.
 *
 * Opening the real settlement screen would have answered it, and would also have
 * written settlingAt to a live session and frozen a real club's table. This
 * asks the same question of the same components with nothing behind it.
 *
 * WHAT IT IS NOT
 *
 * Not the redesign, and not a step toward it. It borrows the proposed SHAPE —
 * sticky summary, one compact row per player, pinned footer — because that shape
 * is what is being measured. It has no settlement logic, calls no API, touches
 * no session, and imports nothing from ClubDetailView. Delete it and nothing
 * else changes.
 *
 * WHAT IT MEASURES
 *
 * The readout is the point. "Does the keyboard cover the footer" is a question
 * people answer differently depending on which phone they are holding, so the
 * page computes it: visualViewport against the footer's own bounding box. A
 * screenshot of the readout is evidence; a screenshot of the layout is an
 * impression.
 */

type Row = { id: string; name: string; bank: string; cashOut: string };

const NAMES = [
  'Priya', 'Rahul', 'Aisha', 'Vikram', 'Meera', 'Arjun',
  'Nisha', 'Karan', 'Divya', 'Sameer', 'Tara', 'Rohan',
];

const makeRows = (n: number): Row[] =>
  NAMES.slice(0, n).map((name, i) => ({
    id: `p${i}`,
    name,
    bank: '5000',
    cashOut: '',
  }));

/** Live viewport facts. The whole reason the page exists. */
function useViewportReadout(footerRef: React.RefObject<HTMLElement | null>, summaryRef: React.RefObject<HTMLElement | null>) {
  const [readout, setReadout] = useState(() => ({
    innerHeight: 0, vvHeight: 0, vvOffsetTop: 0, keyboardInset: 0,
    footerBottom: 0, footerCovered: false, summaryTop: 0, summaryVisible: true,
    orientation: 'portrait',
  }));

  useEffect(() => {
    const vv = window.visualViewport;

    const measure = () => {
      const vvHeight = vv?.height ?? window.innerHeight;
      const vvOffsetTop = vv?.offsetTop ?? 0;
      // What the keyboard (and any other browser furniture) has taken away from
      // the visible area. Zero with the keyboard down.
      const keyboardInset = Math.max(0, Math.round(window.innerHeight - vvHeight - vvOffsetTop));

      const f = footerRef.current?.getBoundingClientRect();
      const s = summaryRef.current?.getBoundingClientRect();
      // getBoundingClientRect is in layout-viewport coordinates; the visible
      // band is [vvOffsetTop, vvOffsetTop + vvHeight].
      const visibleBottom = vvOffsetTop + vvHeight;

      setReadout({
        innerHeight: Math.round(window.innerHeight),
        vvHeight: Math.round(vvHeight),
        vvOffsetTop: Math.round(vvOffsetTop),
        keyboardInset,
        footerBottom: f ? Math.round(f.bottom) : 0,
        footerCovered: f ? f.bottom > visibleBottom + 1 : false,
        summaryTop: s ? Math.round(s.top) : 0,
        summaryVisible: s ? s.top >= vvOffsetTop - 1 && s.top < visibleBottom : true,
        orientation: window.innerWidth > window.innerHeight ? 'landscape' : 'portrait',
      });
    };

    measure();
    const id = window.setInterval(measure, 250); // focus/blur alone misses the keyboard animation
    vv?.addEventListener('resize', measure);
    vv?.addEventListener('scroll', measure);
    window.addEventListener('resize', measure);
    return () => {
      window.clearInterval(id);
      vv?.removeEventListener('resize', measure);
      vv?.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
    };
  }, [footerRef, summaryRef]);

  return readout;
}

export function SheetKeyboardProbe() {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Row[]>(() => makeRows(8));
  const footerRef = useRef<HTMLDivElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  const r = useViewportReadout(footerRef, summaryRef);

  const num = (v: string) => (v.trim() === '' ? 0 : Number(v) || 0);
  const totalIn = rows.reduce((s, x) => s + num(x.bank), 0);
  const allCounted = rows.every((x) => x.cashOut.trim() !== '');
  const totalOut = rows.reduce((s, x) => s + num(x.cashOut), 0);
  const diff = totalOut - totalIn;

  const set = (id: string, field: 'bank' | 'cashOut', value: string) =>
    setRows((prev) => prev.map((x) => (x.id === id ? { ...x, [field]: value } : x)));

  const fmt = (n: number) => n.toLocaleString();

  return (
    <div className="min-h-screen bg-bg text-text p-5 space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Sheet keyboard probe</h1>
        <p className="text-xs text-text-muted mt-1 leading-relaxed">
          Nothing here talks to a session. Open the sheet, tap a cash-out field, and read the
          numbers below — they update while the keyboard is open.
        </p>
      </div>

      <div className="flex gap-2">
        {[4, 8, 12].map((n) => (
          <Button key={n} variant={rows.length === n ? 'primary' : 'secondary'} size="sm"
                  onClick={() => setRows(makeRows(n))}>
            {n} players
          </Button>
        ))}
      </div>

      <Button variant="primary" size="lg" fullWidth onClick={() => setOpen(true)}>
        Open the sheet
      </Button>

      <Readout r={r} where="page" />

      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        size="lg"
        title="Settle night"
        description="Probe · no session, no writes"
        footer={
          <div ref={footerRef} className="w-full">
            <Button variant="primary" size="lg" fullWidth disabled={!allCounted}>
              {allCounted ? 'Review & settle' : 'Count everyone first'}
            </Button>
          </div>
        }
      >
        <div
          ref={summaryRef}
          className="sticky top-0 z-10 -mx-5 px-5 py-2.5 bg-bg/95 backdrop-blur-xl border-b border-line"
        >
          <div className="flex items-baseline justify-between text-xs font-mono tabular-nums">
            <span>IN {fmt(totalIn)}</span>
            <span>OUT {allCounted ? fmt(totalOut) : '—'}</span>
            <span className={diff === 0 ? '' : 'text-warning'}>
              DIFF {allCounted ? fmt(Math.abs(diff)) : '—'}
            </span>
          </div>
        </div>

        <div className="divide-y divide-line">
          {rows.map((row) => {
            const counted = row.cashOut.trim() !== '';
            const net = num(row.cashOut) - num(row.bank);
            return (
              <div key={row.id} className="py-2.5 space-y-1.5">
                <div className="flex items-baseline justify-between">
                  <span className="text-sm">{row.name}</span>
                  <span className="text-sm font-mono tabular-nums">
                    {counted ? (net >= 0 ? `+${fmt(net)}` : fmt(net)) : '—'}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2.5">
                  <label className="flex items-center gap-2 min-h-[44px] px-3 rounded-[var(--radius-sm)] bg-bg">
                    <span className="text-[10px] uppercase text-text-muted shrink-0">Bank</span>
                    <input
                      type="number"
                      inputMode="decimal"
                      value={row.bank}
                      onChange={(e) => set(row.id, 'bank', e.target.value)}
                      className="w-full min-w-0 bg-transparent text-base font-mono tabular-nums text-text outline-none focus-visible:ring-1 focus-visible:ring-accent"
                    />
                  </label>
                  <label className="flex items-center gap-2 min-h-[44px] px-3 rounded-[var(--radius-sm)] bg-bg">
                    <span className="text-[10px] uppercase text-text-muted shrink-0">Out</span>
                    <input
                      type="number"
                      inputMode="decimal"
                      value={row.cashOut}
                      onChange={(e) => set(row.id, 'cashOut', e.target.value)}
                      placeholder="—"
                      className="w-full min-w-0 bg-transparent text-base font-mono tabular-nums text-text placeholder:text-text-faint outline-none focus-visible:ring-1 focus-visible:ring-accent"
                    />
                  </label>
                </div>
              </div>
            );
          })}
        </div>

        <div className="pt-3">
          <Readout r={r} where="sheet" />
        </div>
      </Sheet>
    </div>
  );
}

function Readout({ r, where }: { r: ReturnType<typeof useViewportReadout>; where: string }) {
  const rows: [string, string, boolean?][] = [
    ['orientation', r.orientation],
    ['window.innerHeight', `${r.innerHeight}px`],
    ['visualViewport.height', `${r.vvHeight}px`],
    ['visualViewport.offsetTop', `${r.vvOffsetTop}px`],
    ['keyboard inset', `${r.keyboardInset}px`, r.keyboardInset > 0],
    ['footer bottom', `${r.footerBottom}px`],
    ['FOOTER COVERED', r.footerCovered ? 'YES' : 'no', r.footerCovered],
    ['SUMMARY VISIBLE', r.summaryVisible ? 'yes' : 'NO', !r.summaryVisible],
  ];
  return (
    <div className="furniture rounded-xl p-3 space-y-1">
      <p className="text-[10px] uppercase tracking-[0.18em] text-text-faint">readout · {where}</p>
      {rows.map(([k, v, warn]) => (
        <div key={k} className="flex items-baseline justify-between text-[11px] font-mono tabular-nums">
          <span className="text-text-muted">{k}</span>
          <span className={warn ? 'text-warning font-semibold' : 'text-text'}>{v}</span>
        </div>
      ))}
    </div>
  );
}
