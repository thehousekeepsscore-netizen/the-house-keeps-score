import { describe, it, expect } from 'vitest';
import {
  GRACE_MS,
  coarseLabel,
  durationPhrase,
  nightClock,
  preciseLabel,
  scheduledMinutes,
} from './night-clock';
import { PokerSession } from '../types';

/**
 * The scheduled game is a plan. The poker night is not.
 *
 * Everything here follows from that: the clock reaching zero starts a
 * conversation and ends nothing, extensions are additive and uncapped, and the
 * one thing that is irreversible is the host deciding the plan is over.
 */

const NOW = Date.parse('2026-08-06T23:00:00.000Z');
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const mins = (n: number) => n * 60_000;

function session(over: Partial<PokerSession> = {}): PokerSession {
  return {
    id: 's1', clubId: 'c1', sessionName: 'Fri 8 Aug', status: 'active',
    activePlayerUids: [], pendingSitInUids: [], sitInRequestedAt: {}, cashOuts: [],
    startedBy: 'host', createdAt: at(mins(200)),
    startedPlayingAt: at(mins(60)),
    durationMinutes: 120,
    timeExtensions: [],
    timeLimitLiftedAt: null,
    ...over,
  };
}

describe('a night with no clock to watch', () => {
  it('has nothing to count when no length was set', () => {
    expect(nightClock(session({ durationMinutes: undefined }), NOW).phase).toBe('none');
  });

  it('has nothing to count in the lobby, before play has started', () => {
    expect(nightClock(session({ startedPlayingAt: null }), NOW).phase).toBe('none');
  });

  it('has nothing to count once the host lifts the limit', () => {
    // One-way for the rest of the night, and the whole reason it exists: a game
    // running three hours over must not open a grace period every five minutes
    // for the last two of them.
    const on = session({ startedPlayingAt: at(mins(300)), timeLimitLiftedAt: at(mins(30)) });
    expect(nightClock(on, NOW).phase).toBe('none');
  });
});

describe('counting down', () => {
  it('counts from when play began, not from when the table opened', () => {
    const clock = nightClock(session(), NOW);
    expect(clock.phase).toBe('running');
    expect(clock.msRemaining).toBe(mins(60));
    expect(clock.ending).toBe(false);
  });

  it('marks the last fifteen minutes without changing anything else', () => {
    const clock = nightClock(session({ startedPlayingAt: at(mins(110)) }), NOW);
    expect(clock.phase).toBe('running');
    expect(clock.ending).toBe(true);
  });
});

describe('the grace period', () => {
  it('opens the moment the plan runs out, and ends nothing', () => {
    const clock = nightClock(session({ startedPlayingAt: at(mins(121)) }), NOW);
    expect(clock.phase).toBe('grace');
    expect(clock.msOfGraceLeft).toBe(GRACE_MS - mins(1));
  });

  it('lasts five minutes and then asks the host what they want', () => {
    const clock = nightClock(session({ startedPlayingAt: at(mins(126)) }), NOW);
    expect(clock.phase).toBe('complete');
  });
});

describe('extending', () => {
  it('adds to the plan rather than replacing it', () => {
    const s = session({ timeExtensions: [{ minutes: 30, at: at(0) }] });
    expect(scheduledMinutes(s)).toBe(150);
  });

  it('pulls a night out of grace and back into play', () => {
    // Ten minutes past a two-hour plan: past the grace period entirely. Half an
    // hour added puts twenty minutes back on the clock.
    const overrun = session({ startedPlayingAt: at(mins(130)) });
    expect(nightClock(overrun, NOW).phase).toBe('complete');

    const extended = session({
      startedPlayingAt: at(mins(130)),
      timeExtensions: [{ minutes: 30, at: at(0) }],
    });
    const clock = nightClock(extended, NOW);
    expect(clock.phase).toBe('running');
    expect(clock.msRemaining).toBe(mins(20));
  });

  it('stacks without limit, because capping it would end somebody else’s evening', () => {
    const s = session({
      startedPlayingAt: at(mins(200)),
      timeExtensions: [
        { minutes: 30, at: at(mins(80)) },
        { minutes: 30, at: at(mins(50)) },
        { minutes: 60, at: at(mins(20)) },
      ],
    });
    expect(scheduledMinutes(s)).toBe(240);
    expect(nightClock(s, NOW).msRemaining).toBe(mins(40));
  });
});

describe('how it reads', () => {
  it('is coarse while there is time and precise once there is not', () => {
    // An hour out the seconds are noise. Inside the grace period they are the
    // whole point, because five minutes is a decision window.
    expect(coarseLabel(mins(72))).toBe('1h 12m');
    expect(coarseLabel(mins(120))).toBe('2h');
    expect(coarseLabel(mins(9))).toBe('9m');
    expect(preciseLabel(299_000)).toBe('04:59');
    expect(preciseLabel(-5_000)).toBe('00:00');
  });

  it('says a duration the way somebody would', () => {
    expect(durationPhrase(120)).toBe('2-hour');
    expect(durationPhrase(60)).toBe('1-hour');
    expect(durationPhrase(30)).toBe('30-minute');
  });
});
