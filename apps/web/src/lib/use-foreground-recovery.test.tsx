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
  };
}

type FakeSocket = ReturnType<typeof makeFakeSocket>;

function mountRecovery(
  socket: FakeSocket,
  { authFailed = false, strict = false }: { authFailed?: boolean; strict?: boolean } = {}
) {
  const onResume = vi.fn();
  const Probe = () => {
    useForegroundRecovery({ socket: socket as unknown as Socket, authFailed, onResume });
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
