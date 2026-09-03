import React, { StrictMode } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import type { Socket } from 'socket.io-client';
import { useForegroundRecovery } from './use-foreground-recovery';

/**
 * Coming back to the app has to make the data current again.
 *
 * The club screen has no polling and no timer, so a socket that dies silently
 * while the tab is in the background leaves it stale with nothing to correct it
 * — the reported bug, where returning to the app shows old approvals until the
 * browser is manually refreshed.
 *
 * The central test here is "refetches even while the socket claims to be
 * connected". Every other test in this file could pass with an implementation
 * that still has the bug; that one cannot.
 */

/** jsdom reports 'visible' and has no way to change it, so it is stubbed. */
function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', {
    value: state,
    configurable: true,
  });
}

function fireVisibilityChange(state: DocumentVisibilityState) {
  setVisibility(state);
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

function makeFakeSocket({ connected = false } = {}) {
  return {
    connected,
    connect: vi.fn(function (this: { connected: boolean }) {
      return this;
    }),
    disconnect: vi.fn(function (this: { connected: boolean }) {
      this.connected = false;
      return this;
    }),
  };
}

type FakeSocket = ReturnType<typeof makeFakeSocket>;

function mountRecovery(
  socket: FakeSocket,
  {
    authFailed = false,
    strict = false,
    verifyAlive,
  }: { authFailed?: boolean; strict?: boolean; verifyAlive?: () => Promise<boolean> } = {}
) {
  const onResume = vi.fn();
  const Probe = () => {
    useForegroundRecovery({ socket: socket as unknown as Socket, authFailed, onResume, verifyAlive });
    return null;
  };
  const tree = <Probe />;
  const utils = render(strict ? <StrictMode>{tree}</StrictMode> : tree);
  return { onResume, ...utils };
}

afterEach(() => {
  setVisibility('visible');
});

describe('returning to the app', () => {
  it('refetches when the socket says it is connected', () => {
    // Case A. Mandatory: a connected socket is not evidence the data is current.
    const socket = makeFakeSocket({ connected: true });
    const { onResume } = mountRecovery(socket);

    fireVisibilityChange('hidden');
    fireVisibilityChange('visible');

    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it('resumes without touching a socket that is already up', () => {
    // The suspended-socket case: the OS killed the connection but the client
    // still reports `connected: true`. Nothing is reconnected, and the refetch
    // still runs — which is what makes the data correct itself.
    //
    // Note what this test does NOT prove. `if (socket.connected) refetch()`
    // passes it too, because `connected` is true here. The requirement "refetch
    // regardless of socket.connected" is only pinned by the pair of this test
    // and the disconnected one below; the disconnected one is what kills that
    // mutant. Discovered by mutation testing, and recorded here so the pair is
    // never split up on the assumption that this test alone is the guard.
    const socket = makeFakeSocket({ connected: true });
    const { onResume } = mountRecovery(socket);

    fireVisibilityChange('visible');

    expect(onResume).toHaveBeenCalledTimes(1);
    expect(socket.connect).not.toHaveBeenCalled();
  });

  it('THE CENTRAL REQUIREMENT: refetches even though the socket is down', () => {
    // Case B, and the test that actually protects "refetch regardless of
    // socket.connected". Gating the refetch on `socket.connected` — the exact
    // shape of the original bug — is caught here and nowhere else, because this
    // is the only state where the flag and the requirement disagree.
    //
    // The refetch must also not be chained to the handshake: HTTP works even
    // when the socket does not, and waiting would make recovery hostage to the
    // slower, less reliable path.
    const socket = makeFakeSocket({ connected: false });
    const { onResume } = mountRecovery(socket);

    fireVisibilityChange('visible');

    expect(socket.connect).toHaveBeenCalledTimes(1);
    expect(onResume).toHaveBeenCalledTimes(1);

    // Still disconnected — the refetch already happened regardless.
    expect(socket.connected).toBe(false);
  });

  it('does nothing when the page goes away', () => {
    const socket = makeFakeSocket({ connected: true });
    const { onResume } = mountRecovery(socket);

    fireVisibilityChange('hidden');

    expect(onResume).not.toHaveBeenCalled();
    expect(socket.connect).not.toHaveBeenCalled();
  });
});

describe('an authentication failure must not become a reconnect loop', () => {
  it('refetches but does not touch the socket when the handshake was refused', () => {
    // Case D. socket.io has destroyed a socket the server refused, and the same
    // credentials will be refused again. Refetch over HTTP — apiFetch refreshes
    // its own token on a 401 — and leave the handshake alone.
    const socket = makeFakeSocket({ connected: false });
    const { onResume } = mountRecovery(socket, { authFailed: true });

    fireVisibilityChange('visible');

    expect(socket.connect).not.toHaveBeenCalled();
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it('does not accumulate connection attempts across repeated resumes', () => {
    const socket = makeFakeSocket({ connected: false });
    const { onResume } = mountRecovery(socket, { authFailed: true });

    for (let i = 0; i < 5; i += 1) {
      fireVisibilityChange('hidden');
      fireVisibilityChange('visible');
    }

    expect(socket.connect).toHaveBeenCalledTimes(0);
    // The data path still runs every time — that is the recovery.
    expect(onResume).toHaveBeenCalledTimes(5);
  });

  it('reads authFailed at resume time, not at registration time', () => {
    // The state can change between mounting and returning to the app, and the
    // value that matters is the one true when the user comes back.
    const socket = makeFakeSocket({ connected: false });
    let authFailed = true;
    const onResume = vi.fn();
    const Probe = () => {
      useForegroundRecovery({ socket: socket as unknown as Socket, authFailed, onResume });
      return null;
    };
    const { rerender } = render(<Probe />);

    fireVisibilityChange('visible');
    expect(socket.connect).not.toHaveBeenCalled();

    authFailed = false;
    rerender(<Probe />);
    fireVisibilityChange('hidden');
    fireVisibilityChange('visible');

    expect(socket.connect).toHaveBeenCalledTimes(1);
  });
});

describe('repeated and overlapping events', () => {
  it('refetches once per return, not once per event', () => {
    const socket = makeFakeSocket({ connected: true });
    const { onResume } = mountRecovery(socket);

    fireVisibilityChange('hidden');
    fireVisibilityChange('visible');
    fireVisibilityChange('hidden');
    fireVisibilityChange('visible');
    fireVisibilityChange('hidden');

    // Three hidden events contributed nothing; two returns did.
    expect(onResume).toHaveBeenCalledTimes(2);
  });

  it('runs once per visible event, with no artificial dedup', () => {
    // Documents the deliberate absence of a guard. Two consecutive 'visible'
    // events without an intervening 'hidden' do not occur in a browser, and
    // adding a timing window to suppress a case that does not arise would be
    // untestable machinery hiding a problem nobody has.
    const socket = makeFakeSocket({ connected: true });
    const { onResume } = mountRecovery(socket);

    fireVisibilityChange('visible');
    fireVisibilityChange('visible');

    expect(onResume).toHaveBeenCalledTimes(2);
  });

  it('a resume and a socket connect are independent — neither suppresses the other', () => {
    // Case C. Both paths issue forced refreshes and can overlap; response
    // ordering is already guaranteed by the cache (#56), so the overlap is a
    // cost question, not a correctness one. Nothing here serialises them.
    const socket = makeFakeSocket({ connected: true });
    const { onResume } = mountRecovery(socket);

    fireVisibilityChange('visible');
    expect(onResume).toHaveBeenCalledTimes(1);

    // A socket 'connect' would call the same resync through its own listener;
    // this hook neither knows nor cares.
    fireVisibilityChange('hidden');
    fireVisibilityChange('visible');
    expect(onResume).toHaveBeenCalledTimes(2);
  });
});

describe('listener hygiene', () => {
  it('removes the listener on unmount', () => {
    const socket = makeFakeSocket({ connected: true });
    const { onResume, unmount } = mountRecovery(socket);

    unmount();
    fireVisibilityChange('visible');

    expect(onResume).not.toHaveBeenCalled();
  });

  it('does not double-fire under StrictMode', () => {
    // StrictMode runs effects twice on mount. Without paired cleanup the
    // listener is registered twice and every resume refetches twice — which on
    // this screen means sixteen forced requests instead of eight.
    const socket = makeFakeSocket({ connected: true });
    const { onResume } = mountRecovery(socket, { strict: true });

    fireVisibilityChange('visible');

    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it('does not leak across mount/unmount/remount under StrictMode', () => {
    const socket = makeFakeSocket({ connected: true });

    const first = mountRecovery(socket, { strict: true });
    first.unmount();

    const second = mountRecovery(socket, { strict: true });
    fireVisibilityChange('visible');

    expect(first.onResume).not.toHaveBeenCalled();
    expect(second.onResume).toHaveBeenCalledTimes(1);
  });
});

/**
 * A socket that SAYS connected after a resume is asked to prove it.
 *
 * The refetch above makes the screen right for the instant of resume. If the
 * socket underneath died with the screen lock, every event until the transport
 * heartbeat notices — 45 seconds — is lost and nothing refetches again. The
 * probe closes that window: an answered acknowledgement leaves the socket
 * alone, an unanswered one forces it through disconnect → connect so the
 * existing `connect` listener re-joins and refetches.
 */
describe('a socket that claims to be connected is verified, not trusted', () => {
  /** Resolves the probe on demand, so each test decides the verdict and when. */
  function deferredProbe() {
    let resolve!: (alive: boolean) => void;
    const verifyAlive = vi.fn(
      () => new Promise<boolean>((r) => { resolve = r; })
    );
    return { verifyAlive, answer: (alive: boolean) => act(async () => { resolve(alive); }) };
  }

  it('leaves a socket alone when the server answers', async () => {
    const socket = makeFakeSocket({ connected: true });
    const { verifyAlive, answer } = deferredProbe();
    const { onResume } = mountRecovery(socket, { verifyAlive });

    fireVisibilityChange('visible');
    expect(verifyAlive).toHaveBeenCalledTimes(1);
    await answer(true);

    expect(socket.disconnect).not.toHaveBeenCalled();
    expect(socket.connect).not.toHaveBeenCalled();
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it('forces disconnect → connect when the server does not answer in time', async () => {
    const socket = makeFakeSocket({ connected: true });
    const { verifyAlive, answer } = deferredProbe();
    mountRecovery(socket, { verifyAlive });

    fireVisibilityChange('visible');
    await answer(false);

    // Through the ordinary path, in the ordinary order: the `connect` that
    // follows is what re-joins the room and refetches, via the listener that
    // already handles every other reconnect.
    expect(socket.disconnect).toHaveBeenCalledTimes(1);
    expect(socket.connect).toHaveBeenCalledTimes(1);
    expect(socket.disconnect.mock.invocationCallOrder[0])
      .toBeLessThan(socket.connect.mock.invocationCallOrder[0]);
  });

  it('never disconnects without reconnecting', async () => {
    // A disconnect on its own would turn a zombie into a corpse: socket.io
    // does not auto-reconnect after a manual disconnect.
    const socket = makeFakeSocket({ connected: true });
    const { verifyAlive, answer } = deferredProbe();
    mountRecovery(socket, { verifyAlive });

    fireVisibilityChange('visible');
    await answer(false);

    expect(socket.connect).toHaveBeenCalledTimes(socket.disconnect.mock.calls.length);
  });

  it('still refetches immediately, without waiting for the verdict', async () => {
    // The data path must not be hostage to the probe any more than to the
    // handshake. The refetch has already run while the probe is still open.
    const socket = makeFakeSocket({ connected: true });
    const { verifyAlive } = deferredProbe();
    const { onResume } = mountRecovery(socket, { verifyAlive });

    fireVisibilityChange('visible');

    expect(onResume).toHaveBeenCalledTimes(1);
    expect(verifyAlive).toHaveBeenCalledTimes(1);
  });

  it('does not probe a socket that already says it is down — that path is unchanged', () => {
    const socket = makeFakeSocket({ connected: false });
    const verifyAlive = vi.fn(async () => true);
    const { onResume } = mountRecovery(socket, { verifyAlive });

    fireVisibilityChange('visible');

    // Exactly the behaviour before the probe existed.
    expect(socket.connect).toHaveBeenCalledTimes(1);
    expect(socket.disconnect).not.toHaveBeenCalled();
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(verifyAlive).not.toHaveBeenCalled();
  });

  it('does not probe, and does not reconnect, a socket the server refused', () => {
    // auth-error is terminal: the same credentials would be refused again,
    // and a probe on a destroyed socket could only time out and reconnect it
    // into another refusal. Refetch over HTTP, leave the socket alone.
    const socket = makeFakeSocket({ connected: true });
    const verifyAlive = vi.fn(async () => false);
    const { onResume } = mountRecovery(socket, { authFailed: true, verifyAlive });

    fireVisibilityChange('visible');

    expect(verifyAlive).not.toHaveBeenCalled();
    expect(socket.disconnect).not.toHaveBeenCalled();
    expect(socket.connect).not.toHaveBeenCalled();
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it('reads auth-error at verdict time: a refusal that lands mid-probe stops the reconnect', async () => {
    const socket = makeFakeSocket({ connected: true });
    const { verifyAlive, answer } = deferredProbe();
    let authFailed = false;
    const onResume = vi.fn();
    const Probe = () => {
      useForegroundRecovery({ socket: socket as unknown as Socket, authFailed, onResume, verifyAlive });
      return null;
    };
    const { rerender } = render(<Probe />);

    fireVisibilityChange('visible');
    authFailed = true;
    rerender(<Probe />);
    await answer(false);

    expect(socket.disconnect).not.toHaveBeenCalled();
    expect(socket.connect).not.toHaveBeenCalled();
  });

  it('does not reconnect a socket that dropped and recovered on its own while the probe was open', async () => {
    // The verdict arrives after a wait. If the transport heartbeat closed and
    // reopened the socket meanwhile, `connected` is a fresh claim about a
    // fresh socket, and the stale verdict must not tear that one down.
    const socket = makeFakeSocket({ connected: true });
    const { verifyAlive, answer } = deferredProbe();
    mountRecovery(socket, { verifyAlive });

    fireVisibilityChange('visible');
    socket.connected = false; // heartbeat closed the dead one...
    await answer(false);

    expect(socket.disconnect).not.toHaveBeenCalled();
  });

  it('runs one probe at a time', async () => {
    // Two resumes inside one timeout window must not stack two verdicts: the
    // second could reconnect a socket the first had just brought back.
    const socket = makeFakeSocket({ connected: true });
    const { verifyAlive, answer } = deferredProbe();
    mountRecovery(socket, { verifyAlive });

    fireVisibilityChange('visible');
    fireVisibilityChange('hidden');
    fireVisibilityChange('visible');
    expect(verifyAlive).toHaveBeenCalledTimes(1);

    await answer(true);
    fireVisibilityChange('hidden');
    fireVisibilityChange('visible');
    expect(verifyAlive).toHaveBeenCalledTimes(2);
  });

  it('behaves exactly as before when no probe is supplied', () => {
    const socket = makeFakeSocket({ connected: true });
    const { onResume } = mountRecovery(socket);

    fireVisibilityChange('visible');

    expect(onResume).toHaveBeenCalledTimes(1);
    expect(socket.disconnect).not.toHaveBeenCalled();
    expect(socket.connect).not.toHaveBeenCalled();
  });
});
