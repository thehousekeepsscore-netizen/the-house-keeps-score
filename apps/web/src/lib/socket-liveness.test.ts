import { describe, it, expect, vi } from 'vitest';
import type { Socket } from 'socket.io-client';
import { probeSocketLiveness, LIVENESS_TIMEOUT_MS } from './socket-liveness';

/**
 * The probe asks one question — did the server answer the join in time — and
 * reports only that. Whether the join was granted is somebody else's job.
 */

function fakeSocket(outcome: 'ok' | 'denied' | 'timeout' | 'throw') {
  const emitWithAck = vi.fn(async (_event: string, _arg: unknown) => {
    if (outcome === 'ok') return { ok: true };
    if (outcome === 'denied') return { ok: false, error: 'Not a member of this club' };
    if (outcome === 'timeout') throw new Error('operation has timed out');
    throw new Error('socket closed');
  });
  const timeout = vi.fn((_ms: number) => ({ emitWithAck }));
  return { socket: { timeout } as unknown as Socket, timeout, emitWithAck };
}

describe('probing a socket that claims to be connected', () => {
  it('reports alive when the server acknowledges the join', async () => {
    const { socket } = fakeSocket('ok');
    await expect(probeSocketLiveness(socket, 'c1')).resolves.toBe(true);
  });

  it('reports alive when the server answers with a denial — an answer is an answer', async () => {
    // A denied join proves the transport and the handler both work. Treating
    // it as dead would reconnect on every resume for a socket that is fine,
    // and would hide the denial the room:denied path already surfaces.
    const { socket } = fakeSocket('denied');
    await expect(probeSocketLiveness(socket, 'c1')).resolves.toBe(true);
  });

  it('reports dead when the acknowledgement times out', async () => {
    const { socket } = fakeSocket('timeout');
    await expect(probeSocketLiveness(socket, 'c1')).resolves.toBe(false);
  });

  it('reports dead, never rejects, when the emit itself throws', async () => {
    const { socket } = fakeSocket('throw');
    await expect(probeSocketLiveness(socket, 'c1')).resolves.toBe(false);
  });

  it('asks the existing club:join with the club id, under the bounded timeout', async () => {
    // Pins the mechanism: the room join the screen already sends, not a new
    // event, and always through socket.timeout() so silence has a deadline.
    const { socket, timeout, emitWithAck } = fakeSocket('ok');
    await probeSocketLiveness(socket, 'club-42');

    expect(timeout).toHaveBeenCalledWith(LIVENESS_TIMEOUT_MS);
    expect(emitWithAck).toHaveBeenCalledWith('club:join', 'club-42');
  });

  it('honours a caller-supplied timeout', async () => {
    const { socket, timeout } = fakeSocket('ok');
    await probeSocketLiveness(socket, 'c1', 750);
    expect(timeout).toHaveBeenCalledWith(750);
  });

  it('keeps the deadline well under the transport heartbeat it exists to beat', () => {
    // engine.io closes a dead socket only after pingInterval + pingTimeout,
    // 25s + 20s with the server's defaults. The whole point of the probe is
    // to answer sooner than that.
    expect(LIVENESS_TIMEOUT_MS).toBeLessThan(25_000 + 20_000);
    expect(LIVENESS_TIMEOUT_MS).toBeGreaterThan(0);
  });
});
