/**
 * Standalone (OSS-Delta) server entry — TS/Hono on DeltaWarehouse.
 *
 * Requires the delta sidecar (sidecar/delta_sidecar.py) running. Run:
 *   python sidecar/delta_sidecar.py --port 8077 --base ./.delta &
 *   RONIN_DELTA_SIDECAR_URL=http://127.0.0.1:8077 RONIN_DELTA_BASE=./.delta \
 *     npx tsx src/server.ts
 */

import { serve } from "@hono/node-server";
import { createServer as createHttpsServer } from "node:https";
import pino from "pino";
import { DeltaWarehouse } from "./lib/delta-warehouse.js";
import { createDeltaApp } from "./app.js";
import { startMaintenanceScheduler } from "./lib/maintenance.js";
import type { Server as HttpsServer } from "node:https";
import { buildTlsConfig, watchTlsCert } from "./security/tls.js";
import { evaluateSecurityPosture } from "./security/profile.js";

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

  // Opt-in one-time migration: backfill is_current on Bronze tables populated before it existed
  // (fresh stores don't need it). Set RONIN_MIGRATE_IS_CURRENT=true once when upgrading.
  if (process.env.RONIN_MIGRATE_IS_CURRENT === "true") {
    const migrated = await warehouse.migrateAllBronzeIsCurrent();
    log.info({ migrated }, "is_current schema migration complete");
  }

  const app = createDeltaApp({ warehouse, baseUrl: publicUrl });

  // Transmission security (45 CFR §164.312(e)): hardened in-process HTTPS when RONIN_TLS_CERT/KEY
  // are set (NIST SP 800-52r2 ciphers, TLS 1.2 min), OR terminate TLS at a reverse proxy.
  const tlsCfg = buildTlsConfig();
  const tls = tlsCfg.enabled ? { createServer: createHttpsServer, serverOptions: tlsCfg.serverOptions! } : {};

  // Fail-closed security posture check. In the `production` profile the server REFUSES TO BOOT
  // when required controls (auth/audit/TLS/non-ephemeral keys) are missing (ADR-0032).
  const posture = evaluateSecurityPosture({ tlsInProcess: tlsCfg.enabled });
  for (const w of posture.warnings) log.warn({ security: true }, w);
  if (!posture.ok) {
    for (const e of posture.errors) log.fatal({ security: true }, e);
    log.fatal(`security profile '${posture.profile}': refusing to start with an insecure posture (${posture.errors.length} unmet control(s))`);
    process.exit(1);
  }

  const server = serve({ fetch: app.fetch, port, ...tls }, (info) =>
    log.info({ port: info.port, sidecarUrl, base, tls: tlsCfg.enabled, profile: posture.profile }, "ronin-standalone (delta) listening"),
  );

  // Hot-reload the TLS cert on renewal (ACME/cert-manager) — no restart needed (ADR-0031).
  if (tlsCfg.enabled) {
    watchTlsCert(server as unknown as HttpsServer, (err) =>
      err ? log.error({ err }, "TLS cert reload failed — keeping previous certificate")
          : log.info("TLS certificate reloaded"),
    );
  }

  // Opt-in store maintenance: Delta compaction (+ optional vacuum) on an interval
  // (RONIN_MAINTENANCE_INTERVAL_MIN). Keeps small files in check as the store grows.
  startMaintenanceScheduler(warehouse, log);
}

main().catch((err) => {
  log.fatal({ err }, "fatal startup error");
  process.exit(1);
});
