import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { InfoHint } from './InfoHint';

/**
 * The hint still behaves like a hint, now that its target is bigger than it is.
 *
 * The icon is drawn at 14px on purpose — it is a hint, and a hint should
 * recede. Measured in production at six viewport widths, the button box was
 * also 14px, so the drawn size was the entire tap target: the thing the thumb
 * had to hit was a third of a thumb wide.
 *
 * `tap-44` grows the target with an invisible centred pseudo-element rather
 * than padding, because this control is inline inside sentences and headings
 * where a wider box shifts the text around it. The behaviour below is what that
 * must not break — an expanded hit area is worthless if the popover it opens
 * stops closing.
 *
 * Note on what is NOT asserted here: jsdom performs no layout, so
 * getBoundingClientRect returns zeroes and nothing in this file can prove the
 * target is 44px on a real screen. The pixels are checked two ways instead —
 * a contract test over index.css in touch-targets.test.ts, and measurement in
 * a real browser at six widths.
 */

describe('the info hint still opens and closes', () => {
  it('is labelled and starts closed', () => {
    render(<InfoHint>Rake is taken from the pot.</InfoHint>);

    const button = screen.getByRole('button', { name: 'More info' });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('opens its explanation on tap', () => {
    render(<InfoHint>Rake is taken from the pot.</InfoHint>);

    fireEvent.click(screen.getByRole('button', { name: 'More info' }));

    expect(screen.getByRole('tooltip')).toHaveTextContent('Rake is taken from the pot.');
    expect(screen.getByRole('button', { name: 'More info' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('closes again on a second tap', () => {
    render(<InfoHint>Rake is taken from the pot.</InfoHint>);
    const button = screen.getByRole('button', { name: 'More info' });

    fireEvent.click(button);
    fireEvent.click(button);

    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('closes on Escape', () => {
    // A popover that traps the reader is worse than the paragraph it replaced.
    render(<InfoHint>Rake is taken from the pot.</InfoHint>);
    fireEvent.click(screen.getByRole('button', { name: 'More info' }));

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('closes when something outside it is pressed', () => {
    render(
      <div>
        <InfoHint>Rake is taken from the pot.</InfoHint>
        <button type="button">elsewhere</button>
      </div>
    );
    fireEvent.click(screen.getByRole('button', { name: 'More info' }));

    fireEvent.pointerDown(screen.getByRole('button', { name: 'elsewhere' }));

    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('does not fire the surrounding control when tapped', () => {
    // The hint usually sits inside a row that is itself pressable. Without the
    // stopPropagation this button carries, asking what something means would
    // also do the thing it means.
    let outerPresses = 0;
    render(
      // A pressable row, which is what these sit inside — not a nested button,
      // which is invalid HTML and would warn rather than reproduce anything.
      <div role="button" tabIndex={0} onClick={() => { outerPresses += 1; }}>
        Rake
        <InfoHint>Taken from the pot.</InfoHint>
      </div>
    );

    fireEvent.click(screen.getByRole('button', { name: 'More info' }));

    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    expect(outerPresses).toBe(0);
  });
});

describe('the hit area is expanded without changing the icon', () => {
  it('carries the tap-44 target and keeps the icon at w-3.5', () => {
    // A contract test, not a measurement: it asserts the control opts into the
    // shared target and that the icon was not enlarged to reach it. What 44
    // actually means is pinned in touch-targets.test.ts.
    render(<InfoHint>Rake is taken from the pot.</InfoHint>);

    const button = screen.getByRole('button', { name: 'More info' });
    expect(button.className).toContain('tap-44');

    const icon = button.querySelector('svg');
    expect(icon?.getAttribute('class')).toContain('w-3.5');
    expect(icon?.getAttribute('class')).toContain('h-3.5');
  });
});
