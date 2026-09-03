import type { Socket } from 'socket.io-client';

/**
 * Is this socket actually alive, or only saying so?
 *
 * A phone that locks its screen, or hops from wifi to cellular, loses its TCP
 * session without a close frame. socket.io-client learns nothing from that: it
 * keeps reporting `connected` until the transport heartbeat deadline passes —
 * pingInterval + pingTimeout, 45 seconds with the server's defaults. Every
 * event the room emits in that window is lost to this client, and nothing
 * refetches until the next resume. That is the "I have to refresh the other
 * phone" report.
 *
 * So a resume asks the server a question and waits for the answer. The
 * question is the club room join the club screen already sends on every
 * resume and every connect, with the acknowledgement the server already
 * attaches to it (`{ ok: true }` when joined, `{ ok: false }` when denied or
 * when the join could not be evaluated). ANY acknowledgement proves the
 * transport carried a frame there and back and the server's handler ran;
 * whether the join was granted is a separate matter that the existing
 * `room:denied` path already reports. Only silence within the timeout means
 * the socket is dead.
 *
 * WHY THIS IS NOT THE HEARTBEAT, AND CANNOT BE MISTAKEN FOR IT
 *
 * engine.io's heartbeat is a transport-level exchange: the server sends a
 * "2" (ping) frame every pingInterval, the client answers "3" (pong), and the
 * client closes the socket itself if no ping arrives within
 * pingInterval + pingTimeout. It is server-initiated, periodic, invisible to
 * application code, and slow by design. This probe is an application-level
 * Socket.IO event with an acknowledgement: client-initiated, on demand at the
 * moment of resume, answered by a handler in socket.ts, and bounded by its own
 * short timeout. The two share a socket and nothing else. The probe does not
 * reset, shorten or replace the heartbeat, and the heartbeat's 45-second
 * deadline is unchanged for every other client.
 *
 * No new server event is introduced. Reusing the join means there is one
 * mechanism for "am I in the room", not a second connection architecture.
 */

/**
 * How long a live socket is given to answer.
 *
 * The join runs a membership query, so the answer includes a database round
 * trip: a few hundred milliseconds from a phone in India to a Mumbai pooler,
 * measured in production request logs. Three seconds is an order of magnitude
 * of headroom over that and still an order of magnitude under the heartbeat
 * deadline the probe exists to beat.
 */
export const LIVENESS_TIMEOUT_MS = 3000;

/**
 * Resolves true if the server acknowledged the join within the timeout —
 * granted or denied alike — and false if it did not. Never rejects: a probe
 * is a question about the transport, and the transport failing to answer is
 * the answer.
 */
export async function probeSocketLiveness(
  socket: Socket,
  clubId: string,
  timeoutMs: number = LIVENESS_TIMEOUT_MS
): Promise<boolean> {
  try {
    await socket.timeout(timeoutMs).emitWithAck('club:join', clubId);
    return true;
  } catch {
    // socket.io-client rejects with "operation has timed out" when the ack
    // does not arrive in time. Anything else it could throw here — a socket
    // torn down mid-flight, say — is equally an unanswered question.
    return false;
  }
}
