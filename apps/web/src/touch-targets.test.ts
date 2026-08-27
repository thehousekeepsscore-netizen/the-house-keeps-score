import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * What `tap-44` promises, checked against what it actually declares.
 *
 * The component tests assert that three controls carry the class. On their own
 * that proves nothing about pixels: a class named `tap-44` that declared 20px
 * would pass every one of them. This file is the other half — it reads the
 * stylesheet and checks the rule really produces a 44px target, so the two
 * together mean "these controls have a 44px target" rather than "these controls
 * have a class whose name contains 44".
 *
 * It is still a contract test, and deliberately labelled as one. jsdom performs
 * no layout, so nothing in this suite can measure a rendered box; the pixels
 * were verified by measuring the real app in a browser at 320, 375, 390, 402,
 * 430 and 768. What this protects is the thing that silently rots between those
 * manual checks — someone trimming the rule, or dropping the class from a
 * control while its behaviour tests carry on passing.
 *
 * 44 is not an outside opinion. ui/Button.tsx already states it as this
 * project's floor: "min-height 44px — the smallest reliable touch target."
 */

const WEB_ROOT = resolve(__dirname, '..');
const css = readFileSync(join(WEB_ROOT, 'src/index.css'), 'utf8');

/** The `.tap-44::before` body — the pseudo-element that IS the target. */
function targetRule(): string {
  const start = css.indexOf('.tap-44::before');
  expect(start, '.tap-44::before is missing from index.css').toBeGreaterThan(-1);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}

describe('the shared tap target is actually 44px', () => {
  it('declares a 44px square', () => {
    const rule = targetRule();

    const width = /width:\s*(\d+)px/.exec(rule);
    const height = /height:\s*(\d+)px/.exec(rule);

    expect(width, 'no width in .tap-44::before').not.toBeNull();
    expect(height, 'no height in .tap-44::before').not.toBeNull();
    expect(Number(width![1])).toBeGreaterThanOrEqual(44);
    expect(Number(height![1])).toBeGreaterThanOrEqual(44);
  });

  it('is positioned out of flow, so it cannot move the layout', () => {
    // The reason this is a pseudo-element rather than padding. Every one of
    // these controls sits in a flex row; a target that occupied space would
    // push its neighbours and change the design it was meant to leave alone.
    const rule = targetRule();

    expect(rule).toMatch(/position:\s*absolute/);
    expect(rule).toMatch(/content:\s*''/);
  });

  it('is centred on the control it belongs to', () => {
    // Without the translate the 44px box hangs off the icon's top-left corner,
    // so the target sits up and to the left of the thing being pressed.
    const rule = targetRule();

    expect(rule).toMatch(/left:\s*50%/);
    expect(rule).toMatch(/top:\s*50%/);
    expect(rule).toMatch(/translate\(-50%,\s*-50%\)/);
  });

  it('anchors the target to the control by making it a positioning context', () => {
    // `.tap-44` itself must be relative, or the absolutely positioned target
    // centres on some ancestor and lands somewhere unrelated to the icon.
    const start = css.indexOf('.tap-44 {');
    expect(start, '.tap-44 base rule is missing').toBeGreaterThan(-1);
    const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));

    expect(body).toMatch(/position:\s*relative/);
  });
});

describe('the controls measured as too small opt into the target', () => {
  const clubDetail = readFileSync(join(WEB_ROOT, 'src/components/ClubDetailView.tsx'), 'utf8');
  const infoHint = readFileSync(join(WEB_ROOT, 'src/components/InfoHint.tsx'), 'utf8');

  /**
   * The class list of the button whose `title` matches.
   *
   * Deliberately looks only *behind* the marker. The first version searched a
   * window either side of it, and the nearest `className=` after the title is
   * the icon's — so it read `w-4 h-4`, reported the control as unfixed, and the
   * failure looked like a missing class rather than a broken helper.
   */
  function classesFor(source: string, marker: string): string {
    const at = source.indexOf(marker);
    expect(at, `${marker} not found`).toBeGreaterThan(-1);
    const before = source.slice(Math.max(0, at - 400), at);
    const start = before.lastIndexOf('className=');
    expect(start, `no className before ${marker}`).toBeGreaterThan(-1);
    const cls = /className=[{`"]([^`"}]*)/.exec(before.slice(start));
    expect(cls, `unparsable className before ${marker}`).not.toBeNull();
    return cls![1];
  }

  it('the header back arrow — primary navigation on every club screen', () => {
    expect(classesFor(clubDetail, 'title="Back to Clubs List"')).toContain('tap-44');
  });

  it('the club rules icon', () => {
    expect(classesFor(clubDetail, 'title="Club Rules & Info"')).toContain('tap-44');
  });

  it('the add-player stud on the felt', () => {
    // 34x34 measured in production; the + on the table is how players join a
    // live night, which makes it the most-pressed admin control on the felt.
    const pokerTable = readFileSync(join(WEB_ROOT, 'src/components/session/PokerTable.tsx'), 'utf8');
    expect(pokerTable).toMatch(/className="tap-44 table-stud/);
  });

  it('the ask-for-bank pill', () => {
    // 30px tall at widths >= 375 -- and only there: at 320 its label wraps to
    // two lines and the pill accidentally clears 44. A control whose target
    // shrinks as the phone grows is exactly what the shared utility is for.
    const liveSession = readFileSync(join(WEB_ROOT, 'src/components/session/LiveSession.tsx'), 'utf8');
    expect(liveSession).toMatch(/className="tap-44 inline-flex items-center gap-1\.5 rounded-full/);
  });

  it('the profile sheet\u2019s Edit and Close', () => {
    // Edit measured 39x17 in production — the smallest interactive control
    // found anywhere in the app — and the sheet\u2019s close glyph 20x20.
    const sheet = readFileSync(join(WEB_ROOT, 'src/components/AccountSettingsModal.tsx'), 'utf8');
    expect(sheet).toMatch(/aria-label="Close account settings" className="tap-44 /);
    expect(sheet).toMatch(/className="tap-44 shrink-0 flex items-center gap-1 text-\[11px\]/);
  });

  it('the info hint, which carries all of its call sites with it', () => {
    // Twelve usages across the dashboard, club detail and account settings.
    // Fixing the component is what makes this one line worth more than three.
    expect(infoHint).toMatch(/tap-44/);
  });
});

describe('the icons were not enlarged to reach the target', () => {
  const clubDetail = readFileSync(join(WEB_ROOT, 'src/components/ClubDetailView.tsx'), 'utf8');
  const infoHint = readFileSync(join(WEB_ROOT, 'src/components/InfoHint.tsx'), 'utf8');

  it('the info hint icon is still 14px', () => {
    // The whole point of the pseudo-element approach: growing the icon would
    // have been the easy way to 44 and would have changed what the app looks
    // like in twelve places.
    expect(infoHint).toMatch(/<Info className="w-3\.5 h-3\.5" \/>/);
  });

  it('the header icons are still 16px', () => {
    expect(clubDetail).toMatch(/<ArrowLeft className="w-4 h-4" \/>/);
    expect(clubDetail).toMatch(/<Info className="w-4 h-4" \/>/);
  });
});

describe('the faint token clears AA where it is smallest', () => {
  /*
   * Computed, not eyeballed — the same WCAG arithmetic that found the old
   * #6a6659 sitting at 3.43:1 against the page, below the 4.5:1 floor, on
   * precisely the smallest type in the app (10px stamps and section labels).
   * This pins the repaired value so a future palette pass cannot quietly
   * drop it back below the line.
   */
  const lum = (hex: string) => {
    const chan = (c: number) => {
      const v = c / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    const n = parseInt(hex.slice(1), 16);
    return 0.2126 * chan(n >> 16) + 0.7152 * chan((n >> 8) & 255) + 0.0722 * chan(n & 255);
  };
  const ratio = (a: string, b: string) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };

  it('is at least 4.5:1 on the page and on furniture', () => {
    const faint = /--color-text-faint:\s*(#[0-9a-fA-F]{6})/.exec(css);
    const bg = /--color-bg:\s*(#[0-9a-fA-F]{6})/.exec(css);
    const surface = /--color-surface:\s*(#[0-9a-fA-F]{6})/.exec(css);
    expect(faint && bg && surface).toBeTruthy();
    expect(ratio(faint![1], bg![1])).toBeGreaterThanOrEqual(4.5);
    expect(ratio(faint![1], surface![1])).toBeGreaterThanOrEqual(4.5);
  });
});
