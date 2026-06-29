/**
 * Minimal standalone (OSS-Delta) Hono app — TS/Hono tier on the DeltaWarehouse.
 *
 * Same framework as Ronin (keep the codebases similar); the only thing different
 * below the `Warehouse` seam is the backend (delta-rs/DataFusion vs Databricks).
 *
 * v0 surface: /health, /metadata, and the generic `:resourceType` CRUD + search.
 *
 * NOTE (PHI): auth/audit are NOT wired here yet — this is a dev/conformance
 * harness for SYNTHETIC data only (Synthea). Per the PHI working rules, SMART/UDAP
 * auth (ADR-0006) + AuditEvent capture (ADR-0016) must be mounted before any real
 * PHI deployment.
 */

import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { DeltaWarehouse } from "./lib/delta-warehouse.js";
import { deltaResourceRoutes } from "./routes/delta-resource.js";
import { mountTransaction } from "./routes/transaction.js";
import { authEnabled, buildAuthMiddleware } from "./auth/configure.js";
import { auditEnabled, buildAuditMiddleware } from "./audit/configure.js";
import { buildCapabilityStatement } from "./conformance/capability-statement.js";
import { FhirError } from "./lib/errors.js";
import type { OperationOutcome } from "@ronin/fhir-types";

export interface DeltaAppDeps {
  warehouse: DeltaWarehouse;
  baseUrl: string;
  deploymentName?: string;
}

export function createDeltaApp(deps: DeltaAppDeps): Hono {
  const app = new Hono();

  // Public routes (SMART): /health + /metadata are mounted BEFORE the auth gate so they
  // bypass it (Hono runs only middleware registered before a matched handler).
  app.get("/health", (c) => c.json({ status: "ok", backend: "delta", deployment: deps.deploymentName ?? "ronin-standalone" }));

  app.get("/metadata", async (c) => c.json(await buildCapabilityStatement(deps.warehouse, deps.baseUrl)));

  // Audit (ADR-0030, control #2) — opt-in (RONIN_AUDIT_ENABLED). Mounted BEFORE the auth
  // gate so 401/403 denials are audited too; identity is read post-handler from c.var.auth.
  if (auditEnabled()) app.use("*", buildAuditMiddleware(deps.warehouse, deps.deploymentName ?? "ronin-standalone"));

  // Auth gate (ADR-0030, control #1) — opt-in (RONIN_AUTH_ENABLED). Reuses the heritage
  // SMART/UDAP chain (introspect → multi-version scope parse → enforce). Default off so
  // dev/synthetic + existing tests are unaffected; production enablement is a deploy gate.
  if (authEnabled()) app.use("*", buildAuthMiddleware());

  mountTransaction(app, deps.warehouse, deps.baseUrl);
  app.route("/", deltaResourceRoutes(deps.warehouse, deps.baseUrl));

  app.onError((err, c) => {
    if (err instanceof FhirError) {
      return c.json(err.outcome, err.status as ContentfulStatusCode);
    }
    const outcome: OperationOutcome = {
      resourceType: "OperationOutcome",
      issue: [{ severity: "fatal", code: "exception", diagnostics: err.message ?? "Internal server error" }],
    };
    return c.json(outcome, 500);
  });

  return app;
}
