/**
 * Keeping the running total on screen while the keyboard is up.
 *
 * MEASURED, NOT ASSUMED. On an iPhone in Safari, with the numeric keyboard open
 * on a cash-out field: visualViewport.height 656 → 356, offsetTop 0 → 263. The
 * footer survived. The pinned IN/OUT/DIFF summary did not — Safari shifts the
 * VISUAL viewport to keep the focused field in view, which carries the top of
 * the panel out of the visible band.
 *
 * `dvh` cannot help: it tracks the LAYOUT viewport, and the layout viewport is
 * not what moved. `position: sticky` cannot help either — it sticks to the
 * scroller, and the scroller is the thing that left.
 *
 * The summary is the element that has to survive, not the footer. IN/OUT/DIFF is
 * what the host reads WHILE typing; the commit control is reached only after
 * typing stops, when the keyboard is down and the footer is back anyway.
 *
 * This is the arithmetic, kept apart from the listeners so it can be tested
 * without a viewport to shrink.
 */

export interface SummaryOffsetInput {
  /** Where the summary sits with NO translation applied, in layout coordinates. */
  summaryBaseTop: number;
  summaryHeight: number;
  /** visualViewport.offsetTop — how far down the visible band now starts. */
  viewportOffsetTop: number;
  /**
   * The field being typed into, in layout coordinates, or null when nothing is
   * focused. The summary must never be pushed over it: solving visibility by
   * covering the caret trades one problem for a worse one.
   */
  focusedTop: number | null;
}

export function computeSummaryOffset({
  summaryBaseTop,
  summaryHeight,
  viewportOffsetTop,
  focusedTop,
}: SummaryOffsetInput): number {
  // Nothing displaced: leave sticky to do its job untouched. This is the
  // ordinary case — desktop, and any phone with the keyboard down.
  if (viewportOffsetTop <= 0) return 0;

  const needed = viewportOffsetTop - summaryBaseTop;
  // Already inside the visible band.
  if (needed <= 0) return 0;

  if (focusedTop === null) return needed;

  // How far it can travel before its bottom edge reaches the focused field.
  const beforeCovering = focusedTop - summaryHeight - summaryBaseTop;

  // Math.max(0, …) matters: when the field is already above where the summary
  // would land, `beforeCovering` goes negative and the honest answer is to stay
  // put and be scrolled past, rather than to move UP and hide something else.
  return Math.max(0, Math.min(needed, beforeCovering));
}
