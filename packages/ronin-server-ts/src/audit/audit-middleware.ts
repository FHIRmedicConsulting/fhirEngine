/**
 * Hono middleware that captures one FHIR R4 AuditEvent per authenticated
 * resource access per ADR-0016 §1.
 *
 * Mount AFTER `authMiddleware` so the auth context is available — the
 * middleware reads `c.get("auth")` to derive the requesting identity. Mount
 * BEFORE the resource routes so the middleware wraps every FHIR call.
 *
 * Behavior:
 *   1. On request entry, capture `recorded` timestamp + HTTP method + path.
 *   2. Call `await next()` to run the route handler.
 *   3. On response, capture status + extract resource ID from path.
 *   4. Build the AuditEvent body via {@link buildAuditEvent}.
 *   5. Persist via `auditRepo.create(...)` — **fire-and-forget**, no
 *      `await` on the storage write so response latency isn't blocked by
 *      audit-tier IO.
 *
 * Per ADR-0016 §various PHI-redaction rules: only metadata is captured.
 * Request body, response body, and full URL query strings are NOT recorded.
 *
 * v1 scope: capture; persist; that's it. v1.x adds the patient self-view
 * endpoint (§3), SMART OAuth event log (§5), Governance audit (§6),
 * cross-QHIN hooks (§8), hash-chain integrity (§10).
 */

import type { Context, MiddlewareHandler, Next } from "hono";
import type { AuditEvent } from "@ronin/fhir-types";
import type { AuthContext } from "../auth/auth-context.js";
import { buildAuditEvent } from "./audit-event-builder.js";

/** Minimal append-only sink for AuditEvents (delta-native or heritage repo both satisfy it). */
export interface AuditSink {
  create(event: AuditEvent): Promise<unknown>;
}

export interface AuditMiddlewareOptions {
  auditRepo: AuditSink;
  /** Ronin server identity (Device reference). Set per deployment. */
  serverDeviceId: string;
  /** Deployment name surfaced in `source.site`. */
  deploymentName: string;
  /**
   * Optional error sink for storage-write failures. Audit writes are
   * fire-and-forget; failures must not propagate into the response path,
   * but they should be observable for operations.
   */
  onWriteError?: (err: unknown) => void;
}

/**
 * Resource type detection mirrors `authMiddleware`'s logic: first
 * capitalized path segment is the FHIR resource type. Non-FHIR paths
 * (`/health`, `/metadata`, `/.well-known/...`) won't reach this middleware
 * since it mounts only on the FHIR sub-app — but we double-guard.
 */
function classifyPath(url: string): {
  resourceType: string | null;
  resourceId: string | null;
} {
  const path = new URL(url).pathname;
  const segments = path.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) return { resourceType: null, resourceId: null };
  const first = segments[0]!;
  if (!/^[A-Z][A-Za-z]+$/.test(first)) {
    return { resourceType: null, resourceId: null };
  }
  const resourceType = first;
  let resourceId: string | null = null;
  if (segments.length > 1) {
    const second = segments[1]!;
    // Skip operation invocations like `$member-match` — they aren't resource IDs.
    if (!second.startsWith("$")) {
      resourceId = second;
    }
  }
  return { resourceType, resourceId };
}

export function auditMiddleware(options: AuditMiddlewareOptions): MiddlewareHandler {
  // Audit-write failures must never be silent (45 CFR §164.312(b)) — use the configured hook,
  // else log. Production should route this to an alert / consider failing closed.
  const onWriteError = (err: unknown): void => {
    if (options.onWriteError) options.onWriteError(err);
    else console.error("[ronin] AUDIT WRITE FAILED (event not persisted):", (err as Error)?.message ?? err);
  };

  return async function (c: Context, next: Next) {
    const recordedAt = new Date().toISOString();
    const method = c.req.method;
    const url = c.req.url;
    const path = new URL(url).pathname;

    // Pre-capture identity hints from the auth context that may be cleared
    // by the time we finalize after next() (defensive copy).
    const preAuth: AuthContext | undefined = c.get("auth");

    let status = 200;
    try {
      await next();
      status = c.res.status;
    } catch (err) {
      // Auth-middleware errors (401/403) throw before next() resolves; the
      // global onError handler catches them. We still want an audit entry
      // for failed access attempts — re-throw after captureing the error
      // status. The route layer's FhirError carries .status.
      status =
        (err as { status?: number } | undefined)?.status ?? 500;
      // Build + persist AuditEvent for the failed attempt before rethrowing.
      void persistAudit(status);
      throw err;
    }

    void persistAudit(status);

    function persistAudit(finalStatus: number): void {
      try {
        const auth = preAuth ?? c.get("auth");
        const { resourceType, resourceId } = classifyPath(url);

        const event = buildAuditEvent({
          recordedAt,
          method,
          path,
          resourceType,
          resourceId,
          status: finalStatus,
          authSubject: auth?.subject ?? "anonymous",
          clientId: auth?.clientId ?? "unknown",
          launchPatientId: auth?.launchPatientId ?? null,
          purposeOfUse: auth?.purposeOfUse ?? null,
          networkAddress: extractClientIp(c),
          serverDeviceId: options.serverDeviceId,
          deploymentName: options.deploymentName,
        });

        // Fire-and-forget — don't block response on audit write.
        options.auditRepo.create(event).catch(onWriteError);
      } catch (err) {
        onWriteError(err);
      }
    }
  };
}

function extractClientIp(c: Context): string | null {
  // Honor X-Forwarded-For first (proxy/load balancer); fall back to direct.
  const xff = c.req.header("X-Forwarded-For");
  if (xff) return xff.split(",")[0]!.trim();
  const xri = c.req.header("X-Real-IP");
  if (xri) return xri;
  return null;
}
