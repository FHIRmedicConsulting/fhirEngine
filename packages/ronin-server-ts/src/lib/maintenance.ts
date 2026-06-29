/**
 * Store maintenance — Delta compaction + vacuum across the whole store (Priority #1).
 *
 * Append-per-write (every create/update/delete, each AuditEvent, each terminology batch)
 * produces many small Delta files; left alone, scans degrade and tombstoned files pile up.
 * `runMaintenance` compacts every table and (optionally) vacuums; `startMaintenanceScheduler`
 * runs it on an interval, single-flight (Delta is single-writer — never overlap maintenance
 * with itself, and a compaction commit may retry if it races a write).
 *
 * Opt-in via env (`RONIN_MAINTENANCE_INTERVAL_MIN`, `RONIN_VACUUM_ENABLED`,
 * `RONIN_VACUUM_RETENTION_HOURS`); default off so dev/tests are unaffected.
 */
import type { DeltaWarehouse, OptimizeOpts } from "./delta-warehouse.js";

export interface MaintenanceLogger { info: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void }

/** Compact (+ optional vacuum) every Delta table in the store. */
export async function runMaintenance(wh: DeltaWarehouse, opts?: OptimizeOpts): Promise<unknown> {
  return wh.optimizeAll(opts);
}

/** Read maintenance options from env. */
export function maintenanceOptsFromEnv(): OptimizeOpts {
  return {
    vacuum: process.env.RONIN_VACUUM_ENABLED === "true",
    retentionHours: process.env.RONIN_VACUUM_RETENTION_HOURS ? Number(process.env.RONIN_VACUUM_RETENTION_HOURS) : 168,
  };
}

/**
 * Start a single-flight maintenance scheduler if `RONIN_MAINTENANCE_INTERVAL_MIN` is set.
 * Returns a stop() function, or null if disabled. Failures are logged, never thrown.
 */
export function startMaintenanceScheduler(wh: DeltaWarehouse, log?: MaintenanceLogger): (() => void) | null {
  const minutes = Number(process.env.RONIN_MAINTENANCE_INTERVAL_MIN ?? "0");
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  const opts = maintenanceOptsFromEnv();
  let running = false;
  const tick = async () => {
    if (running) return; // single-flight: skip if a prior run is still going
    running = true;
    try {
      const res = await runMaintenance(wh, opts);
      log?.info({ res }, "store maintenance (optimize" + (opts.vacuum ? "+vacuum" : "") + ") complete");
    } catch (err) {
      log?.error({ err: String((err as Error)?.message ?? err) }, "store maintenance failed");
    } finally {
      running = false;
    }
  };
  const handle = setInterval(tick, minutes * 60_000);
  handle.unref?.(); // don't keep the process alive solely for maintenance
  log?.info({ minutes, vacuum: opts.vacuum }, "store maintenance scheduler started");
  return () => clearInterval(handle);
}
