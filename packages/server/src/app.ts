/**
 * Minimal standalone (OSS-Delta) Hono app — TS/Hono tier on the DeltaWarehouse.
 *
 * Same framework as the private Databricks sibling (keep the codebases similar); the only thing different
 * below the `Warehouse` seam is the backend (delta-rs/DataFusion vs Databricks).
 *
 * Surface: /health + /ready, /metadata (+ SMART/UDAP discovery), the generic
 * `:resourceType` CRUD + search, operations ($validate/$export/$everything/…), and the
 * CMS-0057 B2B routes.
 *
 * PHI posture: the SMART/UDAP auth gate (ADR-0030) and AuditEvent capture (ADR-0016) ARE
 * wired here, but OPT-IN — mounted only when `FHIRENGINE_AUTH_ENABLED` / `FHIRENGINE_AUDIT_ENABLED`
 * are set (default OFF = synthetic dev). The `production` security profile (ADR-0032) refuses
 * to boot unless they're on. Turn them on for any real PHI deployment.
 */

import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { DeltaWarehouse } from "./lib/delta-warehouse.js";
import { deltaResourceRoutes } from "./routes/delta-resource.js";
import { terminologyRoutes } from "./routes/terminology.js";
import { mountTransaction } from "./routes/transaction.js";
import { mountMemberMatch } from "./routes/member-match.js";
import { mountPriorAuth } from "./routes/prior-auth.js";
import { mountCdsHooks } from "./routes/cds-hooks.js";
import { mountDtr } from "./routes/dtr.js";
import { authEnabled, buildAuthMiddleware } from "./auth/configure.js";
import { auditEnabled, buildAuditMiddleware } from "./audit/configure.js";
import { buildCapabilityStatement } from "./conformance/capability-statement.js";
import { buildTerminologyCapabilities } from "./conformance/terminology-capabilities.js";
import { buildSmartConfiguration } from "./conformance/smart-configuration.js";
import { oauthEnabled, oauthRoutes } from "./auth/oauth/oauth-routes.js";
import { udapEnabled, udapRoutes } from "./auth/udap/udap-routes.js";
import { mountHttpHardening } from "./security/http-hardening.js";
import { securityProfile } from "./security/profile.js";
import type { RateLimitStore } from "./security/rate-limit.js";
import { FhirError } from "./lib/errors.js";
import type { OperationOutcome } from "@fhirengine/fhir-types";

export interface DeltaAppDeps {
  warehouse: DeltaWarehouse;
  baseUrl: string;
  deploymentName?: string;
  /** Optional shared rate-limit store (e.g. Redis) for consistent limits across instances. */
  rateLimitStore?: RateLimitStore;
}

export function createDeltaApp(deps: DeltaAppDeps): Hono {
  const app = new Hono();

  // HTTP-tier hardening (ADR-0033) — FIRST, so headers/CORS/body-limit/rate-limit apply to every
  // request incl. auth denials. Non-breaking in the dev profile (headers on; CORS permissive;
  // rate-limit off). The `production` profile engages strict CORS + rate limiting.
  mountHttpHardening(app, { profile: securityProfile(), rateLimitStore: deps.rateLimitStore });

  // Public routes (SMART): /health + /metadata are mounted BEFORE the auth gate so they
  // bypass it (Hono runs only middleware registered before a matched handler).
  // Liveness — the process is up (does not check dependencies).
  app.get("/health", (c) => c.json({ status: "ok", backend: "delta", deployment: deps.deploymentName ?? "fhirengine" }));

  // Readiness — the server can serve traffic (storage sidecar reachable). 503 until it is, so an
  // orchestrator/LB doesn't route writes that would 5xx (§164.312 availability; ops).
  app.get("/ready", async (c) => {
    const ok = await deps.warehouse.health().catch(() => false);
    return c.json({ status: ok ? "ready" : "not-ready", sidecar: ok }, ok ? 200 : 503);
  });

  app.get("/metadata", async (c) =>
    c.req.query("mode") === "terminology"
      ? c.json(await buildTerminologyCapabilities(deps.warehouse, deps.baseUrl))
      : c.json(await buildCapabilityStatement(deps.warehouse, deps.baseUrl)),
  );

  // SMART App Launch discovery (public, pre-auth-gate). Advertises the authorization/token
  // endpoints + the capability/scope union across active SMART versions (ADR-0006 / ADR-0030).
  app.get("/.well-known/smart-configuration", (c) => c.json(buildSmartConfiguration(deps.baseUrl)));

  // SMART authorization server (opt-in FHIRENGINE_OAUTH_ENABLED) — /oauth/authorize, /oauth/token,
  // /.well-known/jwks.json. Public (pre-auth-gate); issues tokens the gate verifies (local strategy).
  if (oauthEnabled()) app.route("/", oauthRoutes(deps.baseUrl));

  // UDAP B2B trust (opt-in FHIRENGINE_UDAP_ENABLED) — .well-known/udap + trusted DCR (/udap/register).
  // Public (pre-auth-gate); registered clients then authenticate at /oauth/token (ADR-0036).
  if (udapEnabled()) app.route("/", udapRoutes(deps.baseUrl, deps.warehouse));

  // Audit (ADR-0030, control #2) — opt-in (FHIRENGINE_AUDIT_ENABLED). Mounted BEFORE the auth
  // gate so 401/403 denials are audited too; identity is read post-handler from c.var.auth.
  if (auditEnabled()) app.use("*", buildAuditMiddleware(deps.warehouse, deps.deploymentName ?? "fhirengine"));

  // Auth gate (ADR-0030, control #1) — opt-in (FHIRENGINE_AUTH_ENABLED). Reuses the heritage
  // SMART/UDAP chain (introspect → multi-version scope parse → enforce). Default off so
  // dev/synthetic + existing tests are unaffected; production enablement is a deploy gate.
  if (authEnabled()) app.use("*", buildAuthMiddleware());

  mountTransaction(app, deps.warehouse, deps.baseUrl);
  // Da Vinci HRex Patient/$member-match (CMS-0057 Payer-to-Payer) — before the generic routes.
  mountMemberMatch(app, deps.warehouse);
  // Da Vinci PAS Claim/$submit + $inquire (CMS-0057 Prior Authorization API).
  mountPriorAuth(app, deps.warehouse, deps.baseUrl);
  // Da Vinci CRD — CDS Hooks discovery + coverage-requirements service (CMS-0057).
  mountCdsHooks(app, deps.baseUrl);
  // Da Vinci DTR — Questionnaire/$questionnaire-package (CMS-0057) — before the generic routes.
  mountDtr(app, deps.warehouse);
  // Terminology operations ($validate-code/$expand/$lookup) — BEFORE the generic /:resourceType/:id
  // routes so `/ValueSet/$validate-code` isn't captured as a resource read.
  app.route("/", terminologyRoutes(deps.warehouse));
  app.route("/", deltaResourceRoutes(deps.warehouse, deps.baseUrl));

  app.onError((err, c) => {
    if (err instanceof FhirError) {
      // SMART/OAuth2: an unauthenticated request gets a Bearer challenge (Inferno checks 401).
      if (err.status === 401) c.header("WWW-Authenticate", 'Bearer realm="fhirEngine", error="invalid_token"');
      return c.json(err.outcome, err.status as ContentfulStatusCode);
    }
    // Unexpected error: log server-side for operators; return a GENERIC OperationOutcome so raw
    // internals (SQL fragments, stack, resource values) never leak to the client. Production
    // should route this to a PHI-safe log sink (an exception message may contain resource data).
    console.error("[fhirengine] unhandled server error:", err);
    const outcome: OperationOutcome = {
      resourceType: "OperationOutcome",
      issue: [{ severity: "fatal", code: "exception", diagnostics: "Internal server error" }],
    };
    return c.json(outcome, 500);
  });

  return app;
}
