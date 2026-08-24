import React, { StrictMode } from 'react';
import { describe, it, expect } from 'vitest';
import { render, act } from '@testing-library/react';
import type { Socket } from 'socket.io-client';
import {
  initialSocketConnection,
  reduceSocketConnection,
  useSocketConnection,
  type SocketConnection,
} from './socket-connection';

/**
 * The socket is a singleton that outlives every view, so a screen mounting knows
 * nothing about it until it asks. The flag this replaces initialised to `true`,
 * which meant a socket that had never connected once still displayed as live —
 * the header said everything was fine while the table quietly stopped changing.
 *
 * The distinction that carries the most weight here is `auth-error` versus
 * `disconnected`. socket.io-client retries a transport failure forever but
 * destroys the socket outright on a rejected handshake, so calling the second
 * one "reconnecting" promises a recovery that will never arrive.
 */

/** Minimal stand-in for a Socket: records listeners so cleanup can be counted. */
function makeFakeSocket({ connected = false, active = true } = {}) {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  return {
    connected,
    active,
    on(event: string, fn: (...args: unknown[]) => void) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(fn);
    },
    off(event: string, fn: (...args: unknown[]) => void) {
      listeners.get(event)?.delete(fn);
    },
    fire(event: string, ...args: unknown[]) {
      [...(listeners.get(event) ?? [])].forEach((fn) => fn(...args));
    },
    countFor(event: string) {
      return listeners.get(event)?.size ?? 0;
    },
    totalListeners() {
      return [...listeners.values()].reduce((n, set) => n + set.size, 0);
    },
  };
}

type FakeSocket = ReturnType<typeof makeFakeSocket>;

function mountHook(socket: FakeSocket, { strict = false } = {}) {
  let seen!: SocketConnection;
  const Probe = () => {
    seen = useSocketConnection(socket as unknown as Socket);
    return null;
  };
  const tree = <Probe />;
  const utils = render(strict ? <StrictMode>{tree}</StrictMode> : tree);
  return { get: () => seen, ...utils };
}

describe('the transition table, without a socket or a component', () => {
  const AT = (state: SocketConnection['state'], message: string | null = null): SocketConnection => ({
    state,
    message,
  });

  it('starts from what the socket reports, never from an assumption', () => {
    expect(initialSocketConnection(true)).toEqual({ state: 'connected', message: null });
    expect(initialSocketConnection(false)).toEqual({ state: 'never-connected', message: null });
  });

  it('connecting clears any earlier diagnostic', () => {
    expect(reduceSocketConnection(AT('auth-error', 'Invalid or expired access token'), { type: 'connect' })).toEqual(
      { state: 'connected', message: null }
    );
  });

  it('a refused handshake is auth-error, not disconnected', () => {
    expect(
      reduceSocketConnection(AT('never-connected'), {
        type: 'connect_error',
        willRetry: false,
        message: 'Invalid or expired access token',
      })
    ).toEqual({ state: 'auth-error', message: 'Invalid or expired access token' });
  });

  it('a transport failure the client will retry is disconnected, not auth-error', () => {
    expect(
      reduceSocketConnection(AT('connected'), {
        type: 'connect_error',
        willRetry: true,
        message: 'xhr poll error',
      })
    ).toEqual({ state: 'disconnected', message: 'xhr poll error' });
  });

  it('a later disconnect cannot downgrade auth-error to the retrying state', () => {
    const refused = AT('auth-error', 'Missing access token');
    expect(reduceSocketConnection(refused, { type: 'disconnect' })).toEqual(refused);
  });

  it('an ordinary disconnect drops the previous diagnostic', () => {
    expect(reduceSocketConnection(AT('connected', 'xhr poll error'), { type: 'disconnect' })).toEqual({
      state: 'disconnected',
      message: null,
    });
  });
});

describe('the hook, against a socket', () => {
  it('initial state reflects a socket that is not connected', () => {
    const socket = makeFakeSocket({ connected: false });
    const { get } = mountHook(socket);
    expect(get().state).toBe('never-connected');
  });

  it('initial state reflects a socket that is already connected', () => {
    const socket = makeFakeSocket({ connected: true });
    const { get } = mountHook(socket);
    expect(get().state).toBe('connected');
  });

  it('connect transitions to connected', () => {
    const socket = makeFakeSocket({ connected: false });
    const { get } = mountHook(socket);
    act(() => socket.fire('connect'));
    expect(get().state).toBe('connected');
  });

  it('disconnect transitions to disconnected', () => {
    const socket = makeFakeSocket({ connected: true });
    const { get } = mountHook(socket);
    act(() => socket.fire('disconnect', 'transport close'));
    expect(get().state).toBe('disconnected');
  });

  it('a rejected handshake produces auth-error and keeps the server message', () => {
    const socket = makeFakeSocket({ connected: false, active: false });
    const { get } = mountHook(socket);

    act(() => socket.fire('connect_error', new Error('Invalid or expired access token')));

    expect(get().state).toBe('auth-error');
    expect(get().message).toBe('Invalid or expired access token');
  });

  it('a rejected handshake does not read as an ordinary disconnect', () => {
    const socket = makeFakeSocket({ connected: false, active: false });
    const { get } = mountHook(socket);

    act(() => socket.fire('connect_error', new Error('Missing access token')));
    expect(get().state).not.toBe('disconnected');

    // Even if a disconnect follows, the terminal state has to survive it.
    act(() => socket.fire('disconnect', 'transport close'));
    expect(get().state).toBe('auth-error');
  });

  it('a transport error the client will retry stays disconnected', () => {
    const socket = makeFakeSocket({ connected: false, active: true });
    const { get } = mountHook(socket);

    act(() => socket.fire('connect_error', new Error('xhr poll error')));

    expect(get().state).toBe('disconnected');
  });

  it('reconnecting returns to connected', () => {
    const socket = makeFakeSocket({ connected: true });
    const { get } = mountHook(socket);

    act(() => socket.fire('disconnect', 'transport close'));
    expect(get().state).toBe('disconnected');

    act(() => socket.fire('connect'));
    expect(get().state).toBe('connected');
  });

  it('recovers from auth-error if a later handshake succeeds', () => {
    const socket = makeFakeSocket({ connected: false, active: false });
    const { get } = mountHook(socket);

    act(() => socket.fire('connect_error', new Error('Invalid or expired access token')));
    expect(get().state).toBe('auth-error');

    act(() => socket.fire('connect'));
    expect(get().state).toBe('connected');
    expect(get().message).toBeNull();
  });

  it('picks up a connection that landed between render and effect', () => {
    // The socket is shared: it can connect in the gap, and that 'connect' fires
    // before any listener of ours exists.
    const socket = makeFakeSocket({ connected: false });
    const { get } = mountHook(socket);
    expect(get().state).toBe('never-connected');

    socket.connected = true;
    const second = mountHook(socket);
    expect(second.get().state).toBe('connected');
  });
});

describe('listener hygiene', () => {
  it('removes every listener it registered on unmount', () => {
    const socket = makeFakeSocket();
    const { unmount } = mountHook(socket);

    expect(socket.countFor('connect')).toBe(1);
    expect(socket.countFor('disconnect')).toBe(1);
    expect(socket.countFor('connect_error')).toBe(1);

    unmount();

    expect(socket.totalListeners()).toBe(0);
  });

  it('does not accumulate listeners under StrictMode mount/unmount/remount', () => {
    const socket = makeFakeSocket();

    // StrictMode runs effects twice on mount. Without paired cleanup this is
    // where duplicates appear -- and a doubled listener means a doubled resync
    // once this sits next to one.
    const first = mountHook(socket, { strict: true });
    expect(socket.countFor('connect')).toBe(1);
    expect(socket.countFor('disconnect')).toBe(1);
    expect(socket.countFor('connect_error')).toBe(1);

    first.unmount();
    expect(socket.totalListeners()).toBe(0);

    const second = mountHook(socket, { strict: true });
    expect(socket.countFor('connect')).toBe(1);
    second.unmount();
    expect(socket.totalListeners()).toBe(0);
  });
});
