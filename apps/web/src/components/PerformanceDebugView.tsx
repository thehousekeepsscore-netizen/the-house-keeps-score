import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { snapshot, resetMetrics, type CacheSnapshot } from '../lib/cache-metrics';
import { getSocket } from '../lib/socket';

/**
 * Developer instrumentation, at /debug/performance.
 *
 * Exists because every performance claim in this project is supposed to be
 * measured rather than estimated, and cache behaviour was the one thing that
 * could not be. The only evidence available was counting rows in a DevTools
 * network panel, which twice produced the wrong conclusion: poll ticks read as
 * remount refetches, and a request count read as elapsed time when two of the
 * three calls were parallel.
 *
 * Deliberately not linked from anywhere in the UI. It reads counters that live
 * outside React, and polls them on a timer rather than subscribing, so the panel
 * cannot influence what it is measuring.
 */

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="p-3 bg-surface border border-line rounded-xl">
      <div className="text-[10px] font-medium uppercase tracking-wider text-text-muted">{label}</div>
      <div className="text-lg font-mono font-semibold text-text mt-0.5">{value}</div>
      {hint && <div className="text-[10px] text-text-muted mt-0.5 leading-tight">{hint}</div>}
    </div>
  );
}

export const PerformanceDebugView: React.FC = () => {
  const navigate = useNavigate();
  const [snap, setSnap] = useState<CacheSnapshot>(() => snapshot());
  const [apiMs, setApiMs] = useState<number | null>(null);
  const [socketState, setSocketState] = useState<string>('unknown');

  useEffect(() => {
    const id = setInterval(() => setSnap(snapshot()), 500);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    try {
      const s = getSocket();
      const sync = () => setSocketState(s.connected ? 'connected' : 'disconnected');
      sync();
      s.on('connect', sync);
      s.on('disconnect', sync);
      return () => {
        s.off('connect', sync);
        s.off('disconnect', sync);
      };
    } catch {
      setSocketState('unavailable');
    }
  }, []);

  // Measured on demand rather than continuously: a panel that pings the API on a
  // timer would add exactly the load it is meant to report on.
  const measureApi = useCallback(async () => {
    const t0 = performance.now();
    try {
      await fetch('/api/health', { cache: 'no-store' });
      setApiMs(Math.round(performance.now() - t0));
    } catch {
      setApiMs(-1);
    }
  }, []);

  const reads = snap.hits + snap.misses;

  return (
    <div className="min-h-screen bg-bg text-text p-4 md:p-8 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold ">Performance</h1>
          <p className="text-xs text-text-muted mt-0.5">
            Counters since this tab loaded. Not persisted, not linked from the app.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => { resetMetrics(); setSnap(snapshot()); }}
            className="px-3 py-1.5 bg-surface border border-line rounded-xl text-xs font-medium cursor-pointer hover:border-line-strong"
          >
            Reset
          </button>
          <button
            onClick={() => navigate('/')}
            className="px-3 py-1.5 bg-accent text-accent-contrast rounded-xl text-xs font-medium cursor-pointer"
          >
            Back
          </button>
        </div>
      </div>

      <section className="space-y-2">
        <h2 className="text-xs font-medium text-text-muted">Cache</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Stat
            label="Hit rate"
            value={snap.hitRatePercent === null ? '—' : `${snap.hitRatePercent}%`}
            hint={reads === 0 ? 'no reads yet' : `${snap.hits} of ${reads} reads`}
          />
          <Stat label="Hits" value={snap.hits} hint="rendered without waiting" />
          <Stat label="Misses" value={snap.misses} hint="showed a skeleton" />
          <Stat label="Revalidations" value={snap.revalidations} hint="stale, refreshed behind content" />
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-xs font-medium text-text-muted">Network</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Stat label="Requests" value={snap.networkRequests} hint="fetches that hit the wire" />
          <Stat label="Deduped" value={snap.dedupedRequests} hint="joined one already in flight" />
          <Stat label="Failed" value={snap.failedRequests} />
          <Stat label="Superseded" value={snap.supersededResponses} hint="a newer response had already written" />
          <Stat
            label="API latency"
            value={apiMs === null ? '—' : apiMs < 0 ? 'error' : `${apiMs}ms`}
            hint="/api/health, on demand"
          />
        </div>
        <button
          onClick={measureApi}
          className="px-3 py-1.5 bg-surface border border-line rounded-xl text-xs font-medium cursor-pointer hover:border-line-strong"
        >
          Measure API latency
        </button>
      </section>

      <section className="space-y-2">
        <h2 className="text-xs font-medium text-text-muted">Mutations</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Stat label="Write-throughs" value={snap.writeThroughs} hint="cache.update, no GET" />
          <Stat label="Refreshes" value={snap.refreshes} hint="forced refetch" />
          <Stat label="Invalidations" value={snap.invalidations} />
          <Stat label="Cache clears" value={snap.clears} hint="identity changed" />
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-xs font-medium text-text-muted">Socket</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Stat label="Connection" value={socketState} />
        </div>
        <p className="text-[10px] text-text-muted leading-relaxed">
          Round-trip socket latency is not shown: measuring it needs the server to echo a
          timestamped ping, which does not exist yet. Reporting a fabricated number would be
          worse than reporting none.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-xs font-medium text-text-muted">Slowest resources</h2>
        {snap.slowest.length === 0 ? (
          <p className="text-xs text-text-muted">No requests recorded yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs font-mono">
              <thead>
                <tr className="text-text-muted text-left">
                  <th className="py-1.5 pr-4 font-semibold">Key</th>
                  <th className="py-1.5 pr-4 font-semibold">Avg</th>
                  <th className="py-1.5 pr-4 font-semibold">Last</th>
                  <th className="py-1.5 font-semibold">Count</th>
                </tr>
              </thead>
              <tbody>
                {snap.slowest.map((r) => (
                  <tr key={r.key} className="border-t border-line">
                    <td className="py-1.5 pr-4 truncate max-w-[22rem]">{r.key}</td>
                    <td className="py-1.5 pr-4">{r.avgMs}ms</td>
                    <td className="py-1.5 pr-4">{r.lastMs}ms</td>
                    <td className="py-1.5">{r.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
};
