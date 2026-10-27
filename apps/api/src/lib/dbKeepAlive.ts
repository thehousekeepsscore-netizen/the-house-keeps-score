/**
 * A heartbeat to the database, so a quiet week cannot pause it.
 *
 * Supabase pauses a Free-plan project that sees too little database activity
 * over seven days — "a few user requests each day" is the stated floor. This
 * club plays once a week at most, and in October 2026 one quiet stretch was
 * enough: the project paused, the pooler stopped recognising it, and every
 * sign-in failed for six days while the process itself stayed up and healthy.
 *
 * The heartbeat is a single `SELECT 1` on a timer, run inside the API process
 * that is already always on. No cron service, no extra deploy surface, nothing
 * that can drift from the code. It never throws: a failed beat is logged and
 * the next one is tried, because the readiness probe is the place that reports
 * trouble, not this.
 *
 * The timer is unref'd so it can never keep a shutting-down process alive.
 */
export interface KeepAliveOptions {
  /** Milliseconds between beats. 0 disables the heartbeat entirely. */
  intervalMs: number;
  /** The beat itself. Defaults are wired by the caller so this stays testable. */
  probe: () => Promise<unknown>;
  log?: Pick<Console, "log" | "warn">;
}

/** Four times a day: comfortably above "a few requests a day", trivially cheap. */
export const DEFAULT_KEEPALIVE_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Starts the heartbeat and returns the function that stops it. */
export function startDbKeepAlive({ intervalMs, probe, log = console }: KeepAliveOptions): () => void {
  if (!(intervalMs > 0)) {
    log.log("Database keep-alive: disabled");
    return () => {};
  }

  const beat = async () => {
    const started = Date.now();
    try {
      await probe();
      log.log(`Database keep-alive: ok (${Date.now() - started}ms)`);
    } catch (err) {
      const reason = err instanceof Error ? err.message.split("\n")[0] : String(err);
      log.warn(`Database keep-alive: FAILED — ${reason}`);
    }
  };

  const timer = setInterval(() => void beat(), intervalMs);
  timer.unref();
  log.log(`Database keep-alive: every ${Math.round(intervalMs / 60_000)} min`);
  return () => clearInterval(timer);
}
