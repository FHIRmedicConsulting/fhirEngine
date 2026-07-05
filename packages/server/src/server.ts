/**
 * Standalone (OSS-Delta) server entry — TS/Hono on DeltaWarehouse.
 *
 * Requires the delta sidecar (sidecar/delta_sidecar.py) running. Run:
 *   python sidecar/delta_sidecar.py --port 8077 --base ./.delta &
 *   FHIRENGINE_DELTA_SIDECAR_URL=http://127.0.0.1:8077 FHIRENGINE_DELTA_BASE=./.delta \
 *     npx tsx src/server.ts
 */

import { serve } from "@hono/node-server";
import { createServer as createHttpsServer } from "node:https";
import { log } from "./lib/log.js";
import { DeltaWarehouse } from "./lib/delta-warehouse.js";
import { createDeltaApp } from "./app.js";
import { startMaintenanceScheduler } from "./lib/maintenance.js";
import type { Server as HttpsServer } from "node:https";
import { buildTlsConfig, watchTlsCert } from "./security/tls.js";
import { evaluateSecurityPosture } from "./security/profile.js";
import { startAuditAnchorScheduler } from "./audit/audit-anchor.js";
import { udapEnabled } from "./auth/udap/udap-routes.js";
import { loadRegisteredClients } from "./auth/udap/registered-clients.js";
import type { RateLimitStore } from "./security/rate-limit.js";
import { RedisRateLimitStore, type RedisEvalClient } from "./security/redis-rate-limit-store.js";



/** Build a Redis-backed rate-limit store when FHIRENGINE_RATE_LIMIT_STORE=redis; else undefined
 *  (in-process store). Lazy-imports `ioredis` so it isn't a dependency for single-node deploys. */
async function buildSharedRateLimitStore(logger: typeof log): Promise<RateLimitStore | undefined> {
  if (process.env.FHIRENGINE_RATE_LIMIT_STORE !== "redis") return undefined;
  const url = process.env.FHIRENGINE_REDIS_URL;
  if (!url) { logger.error("FHIRENGINE_RATE_LIMIT_STORE=redis but FHIRENGINE_REDIS_URL is unset — using per-node store"); return undefined; }
  try {
    const mod = "ioredis"; // non-literal → not statically resolved (optional runtime dep)
    const { default: Redis } = (await import(mod)) as { default: new (url: string) => RedisEvalClient };
    logger.info("rate limiting: shared Redis store enabled");
    return new RedisRateLimitStore(new Redis(url));
  } catch {
    logger.error("FHIRENGINE_RATE_LIMIT_STORE=redis but `ioredis` is not installed (run `npm i ioredis`) — using per-node store");
    return undefined;
  }
}

async function main(): Promise<void> {
  const sidecarUrl = process.env.FHIRENGINE_DELTA_SIDECAR_URL ?? "http://127.0.0.1:8077";
  const base = process.env.FHIRENGINE_DELTA_BASE ?? "./.delta";
  const port = parseInt(process.env.PORT ?? "3000", 10);
  const publicUrl = process.env.FHIRENGINE_PUBLIC_URL ?? `http://localhost:${port}`;

  const warehouse = new DeltaWarehouse({ sidecarUrl, base });
  if (!(await warehouse.health())) {
    log.warn({ sidecarUrl }, "delta sidecar not reachable — start sidecar/delta_sidecar.py first");
  }
  // Register tables already on disk so reads work immediately after a restart (registration
  // is otherwise in-memory, populated only on write).
  const existing = await warehouse.registerExistingTables();
  if (existing.length) log.info({ tables: existing.length }, "registered existing Delta tables on startup");

  // UDAP: repopulate the DCR client registry from its durable Delta store (ADR-0036).
  if (udapEnabled()) {
    const n = await loadRegisteredClients(warehouse);
    if (n) log.info({ clients: n }, "loaded UDAP registered clients");
  }

  // Opt-in one-time migration: backfill is_current on Bronze tables populated before it existed
  // (fresh stores don't need it). Set FHIRENGINE_MIGRATE_IS_CURRENT=true once when upgrading.
  if (process.env.FHIRENGINE_MIGRATE_IS_CURRENT === "true") {
    const migrated = await warehouse.migrateAllBronzeIsCurrent();
    log.info({ migrated }, "is_current schema migration complete");
  }

  // Optional shared rate-limit store for multi-node deployments (FHIRENGINE_RATE_LIMIT_STORE=redis).
  // Lazy-loads a Redis client so single-node deployments carry no Redis dependency.
  const rateLimitStore = await buildSharedRateLimitStore(log);

  const app = createDeltaApp({ warehouse, baseUrl: publicUrl, rateLimitStore });

  // Transmission security (45 CFR §164.312(e)): hardened in-process HTTPS when FHIRENGINE_TLS_CERT/KEY
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
    log.info({ port: info.port, sidecarUrl, base, tls: tlsCfg.enabled, profile: posture.profile }, "fhirengine (delta) listening"),
  );

  // Hot-reload the TLS cert on renewal (ACME/cert-manager) — no restart needed (ADR-0031).
  const stopCertWatch = tlsCfg.enabled
    ? watchTlsCert(server as unknown as HttpsServer, (err) =>
        err ? log.error({ err }, "TLS cert reload failed — keeping previous certificate")
            : log.info("TLS certificate reloaded"))
    : undefined;

  // Opt-in store maintenance: Delta compaction (+ optional vacuum) on an interval
  // (FHIRENGINE_MAINTENANCE_INTERVAL_MIN). Keeps small files in check as the store grows.
  const stopMaintenance = startMaintenanceScheduler(warehouse, log);

  // Opt-in external audit-chain anchoring (FHIRENGINE_AUDIT_ANCHOR_INTERVAL_MIN + _WEBHOOK) — publishes
  // signed chain-tip snapshots to an external sink so a rewritten/truncated audit log is detectable.
  const stopAnchor = startAuditAnchorScheduler(warehouse, log);

  // Graceful shutdown: stop background timers, stop accepting new connections, and let in-flight
  // requests (incl. single-writer Delta commits) drain before exit — so `docker stop` / SIGTERM
  // doesn't cut a write mid-commit. Force-exit after a grace window if draining stalls.
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, "shutting down — draining connections");
    stopMaintenance?.();
    stopAnchor?.();
    stopCertWatch?.();
    const force = setTimeout(() => { log.warn("shutdown grace elapsed — forcing exit"); process.exit(1); }, 15_000);
    force.unref();
    server.close(() => { log.info("closed cleanly"); clearTimeout(force); process.exit(0); });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  log.fatal({ err }, "fatal startup error");
  process.exit(1);
});
