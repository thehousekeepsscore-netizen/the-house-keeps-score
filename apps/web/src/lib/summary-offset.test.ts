import { describe, it, expect } from 'vitest';
import { computeSummaryOffset } from './summary-offset';

/**
 * The keyboard arithmetic, tested where a keyboard is not required.
 *
 * jsdom has no viewport to shrink and no keyboard to open, so the browser can
 * never exercise this in a test. Keeping the maths in a pure function is what
 * makes it checkable at all — the device run then only has to confirm that the
 * numbers fed in are the right ones.
 *
 * The figures below are the ones actually measured on an iPhone: a 656px
 * viewport becoming 356px, with the visual viewport offset 263px down.
 */
describe('where the summary has to move to stay visible', () => {
  const base = { summaryBaseTop: 120, summaryHeight: 40, viewportOffsetTop: 0, focusedTop: null };

  it('does nothing at all when the viewport has not moved', () => {
    // Desktop, and every phone with the keyboard down. Sticky is already right.
    expect(computeSummaryOffset(base)).toBe(0);
  });

  it('moves it down by exactly what the keyboard displaced', () => {
    // Visible band now starts at 263; the summary sits at 120, so it is 143
    // above the band.
    expect(computeSummaryOffset({ ...base, viewportOffsetTop: 263 })).toBe(143);
  });

  it('leaves it alone when it is already inside the visible band', () => {
    expect(
      computeSummaryOffset({ ...base, summaryBaseTop: 400, viewportOffsetTop: 263 })
    ).toBe(0);
  });

  it('NEVER covers the field being typed into', () => {
    // It would like to travel 143. The focused input is at 200, so anything
    // past 40 would put the bar over the caret.
    const offset = computeSummaryOffset({
      ...base,
      viewportOffsetTop: 263,
      focusedTop: 200,
    });
    expect(offset).toBe(40);
    expect(120 + offset + 40, 'bottom edge stops at the input').toBeLessThanOrEqual(200);
  });

  it('stays put rather than moving up when there is no room at all', () => {
    // Field above where the summary already is: the honest answer is to be
    // scrolled past, not to move up and hide something else.
    expect(
      computeSummaryOffset({ ...base, viewportOffsetTop: 263, focusedTop: 100 })
    ).toBe(0);
  });

  it('stays at zero with no displacement even if the bar reads above the origin', () => {
    /*
     * The `viewportOffsetTop <= 0` guard, on its own.
     *
     * Found by a surviving mutant: relaxing that guard still passed every other
     * case here, because `needed` goes negative for a positive base and the
     * second check catches it. It does NOT catch a negative base — the mutant
     * then translated a bar that nothing had displaced.
     */
    expect(
      computeSummaryOffset({ ...base, summaryBaseTop: -50, viewportOffsetTop: 0 })
    ).toBe(0);
  });

  it('is unaffected by a focused field once the viewport is back', () => {
    expect(computeSummaryOffset({ ...base, focusedTop: 200 })).toBe(0);
  });
});
