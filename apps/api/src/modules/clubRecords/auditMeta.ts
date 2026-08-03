/**
 * Provenance stamped onto every audit record that captures money movement.
 *
 * `AuditLog.changes` is a free-form Json column, which is convenient now and a
 * liability later: two years from now nobody will remember which shape a given
 * row is in, or which engine decided its numbers. Both are cheap to record at
 * write time and effectively impossible to reconstruct afterwards, so they are
 * written alongside the figures rather than inferred from `createdAt`.
 *
 * Bump `AUDIT_SCHEMA_VERSION` whenever the shape of a `changes` payload
 * changes in a way a reader would need to branch on. The settlement engine
 * carries its own version (`SETTLEMENT_ENGINE_VERSION`) so the two can move
 * independently — a payload reshuffle is not an engine behaviour change.
 *
 * History:
 *   1 — settle_session / record_past_session gain structured payloads
 */
export const AUDIT_SCHEMA_VERSION = 1;

/** Which code path produced the record, for filtering and forensics. */
export type AuditOrigin = 'settleSession' | 'createPastSession';
