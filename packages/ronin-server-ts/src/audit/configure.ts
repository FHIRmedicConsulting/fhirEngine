/**
 * Audit-gate wiring (ADR-0030 control #2). Opt-in via `RONIN_AUDIT_ENABLED` (default off →
 * dev/tests unaffected; production enablement is a deploy gate). Mount BEFORE the auth gate
 * so failed-access attempts (401/403) are also audited; the verified identity is read
 * post-handler from `c.var.auth`.
 */
import type { MiddlewareHandler } from "hono";
import { auditMiddleware } from "./audit-middleware.js";
import { DeltaAuditSink } from "./delta-audit-sink.js";
import type { DeltaWarehouse } from "../lib/delta-warehouse.js";

export const auditEnabled = (): boolean => process.env.RONIN_AUDIT_ENABLED === "true";

export function buildAuditMiddleware(wh: DeltaWarehouse, deploymentName: string): MiddlewareHandler {
  return auditMiddleware({
    auditRepo: new DeltaAuditSink(wh),
    serverDeviceId: process.env.RONIN_SERVER_DEVICE_ID ?? "ronin-standalone",
    deploymentName,
    onWriteError: (err) => { if (process.env.RONIN_AUDIT_DEBUG === "true") console.error("audit write failed:", err); },
  });
}
