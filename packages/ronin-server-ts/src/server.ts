/**
 * Standalone (OSS-Delta) server entry — TS/Hono on DeltaWarehouse.
 *
 * Requires the delta sidecar (sidecar/delta_sidecar.py) running. Run:
 *   python sidecar/delta_sidecar.py --port 8077 --base ./.delta &
 *   RONIN_DELTA_SIDECAR_URL=http://127.0.0.1:8077 RONIN_DELTA_BASE=./.delta \
 *     npx tsx src/server.ts
 */

import { serve } from "@hono/node-server";
import pino from "pino";
import { DeltaWarehouse } from "./lib/delta-warehouse.js";
import { createDeltaApp } from "./app.js";
import { startMaintenanceScheduler } from "./lib/maintenance.js";

const log = pino({ level: process.env.RONIN_LOG_LEVEL ?? "info" });

async function main(): Promise<void> {
  const sidecarUrl = process.env.RONIN_DELTA_SIDECAR_URL ?? "http://127.0.0.1:8077";
  const base = process.env.RONIN_DELTA_BASE ?? "./.delta";
  const port = parseInt(process.env.PORT ?? "3000", 10);
  const publicUrl = process.env.RONIN_PUBLIC_URL ?? `http://localhost:${port}`;

  const warehouse = new DeltaWarehouse({ sidecarUrl, base });
  if (!(await warehouse.health())) {
    log.warn({ sidecarUrl }, "delta sidecar not reachable — start sidecar/delta_sidecar.py first");
  }
  // Register tables already on disk so reads work immediately after a restart (registration
  // is otherwise in-memory, populated only on write).
  const existing = await warehouse.registerExistingTables();
  if (existing.length) log.info({ tables: existing.length }, "registered existing Delta tables on startup");

  const app = createDeltaApp({ warehouse, baseUrl: publicUrl });
  serve({ fetch: app.fetch, port }, (info) =>
    log.info({ port: info.port, sidecarUrl, base }, "ronin-standalone (delta) listening"),
  );

  // Opt-in store maintenance: Delta compaction (+ optional vacuum) on an interval
  // (RONIN_MAINTENANCE_INTERVAL_MIN). Keeps small files in check as the store grows.
  startMaintenanceScheduler(warehouse, log);
}

main().catch((err) => {
  log.fatal({ err }, "fatal startup error");
  process.exit(1);
});
