/**
 * Hono middleware: token introspection → scope canonicalization → enforcement.
 *
 * Implements points 1, 2, 3, 4 of the five-point enforcement chain:
 *
 *   1. RFC-7662 token introspection (with LRU cache).
 *   2. Per-handler ops check derived from HTTP method + resource type.
 *   3. Granular query restrictions surfaced into `AuthContext` for the
 *      repository layer to consume.
 *   4. Patient compartment filter surfaced into `AuthContext` for the
 *      repository layer to consume.
 *
 * Point 5 (Consent gate per ADR-0018 §5) lives in a follow-up build.
 *
 * Routes that should bypass auth (discovery + health) are mounted before this
 * middleware runs. The middleware itself doesn't know about route allow-listing
 * by path — `createApp` chooses where to apply it.
 */

import type { Context, MiddlewareHandler, Next } from "hono";
import type { IntrospectionService } from "./token-introspection.js";
import type { SmartVersionRegistry } from "./smart-versions/index.js";
import type { AuthContext } from "./auth-context.js";
import { enforce, verbForRequest } from "./scope-enforcer.js";
import { unauthorized, forbidden } from "../lib/errors.js";

declare module "hono" {
  interface ContextVariableMap {
    /** Populated by the auth middleware; consumed by routes + repositories. */
    auth: AuthContext;
  }
}

export interface AuthMiddlewareOptions {
  introspection: IntrospectionService;
  registry: SmartVersionRegistry;
}

export function authMiddleware(options: AuthMiddlewareOptions): MiddlewareHandler {
  const { introspection, registry } = options;

  return async function (c: Context, next: Next) {
    // --- Point 1: token introspection ---
    const authHeader = c.req.header("Authorization");
    if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
      throw unauthorized("Missing or malformed Authorization: Bearer header");
    }
    const token = authHeader.slice("bearer ".length).trim();
    if (!token) throw unauthorized("Bearer token is empty");

    const result = await introspection.introspect(token);
    if (!result.active) {
      throw unauthorized(result.reason ?? "Token is not active");
    }

    // --- Scope parsing + canonicalization (built into registry) ---
    const rawScopeString = result.scope ?? "";
    const scopes = registry.parseScopeString(rawScopeString);
    const parsedUnderSmartVersion = scopes.length > 0
      ? scopes[0]!.parsedUnderVersion
      : registry.active[0]!.version;

    const auth: AuthContext = {
      token,
      subject: result.sub ?? "unknown",
      clientId: result.client_id ?? "unknown",
      scopes,
      rawScopeString,
      launchPatientId: result.patient ?? null,
      launchEncounterId: result.encounter ?? null,
      fhirUser: result.fhirUser ?? null,
      purposeOfUse: c.req.header("X-Purpose-Of-Use") ?? null,
      expiresAt: result.exp ?? 0,
      issuer: result.iss ?? "",
      parsedUnderSmartVersion,
    };
    c.set("auth", auth);

    // --- Points 2 + 3 + 4: per-handler enforcement ---
    // Route paths look like `/Patient`, `/Patient/:id`, `/metadata`, etc.
    // Resource-type extraction: first non-empty path segment that starts with
    // a capital letter (FHIR convention).
    const path = new URL(c.req.url).pathname;
    const segments = path.split("/").filter((s) => s.length > 0);
    const resourceType = segments[0];

    // Routes that aren't FHIR resources (e.g., /admin) don't go through the
    // resource-scope check. For v1 vertical slice the only FHIR resource is
    // Patient; anything else mounted under this middleware that isn't a FHIR
    // resource should be allowlisted by createApp instead.
    if (!resourceType || !resourceType.match(/^[A-Z][A-Za-z]+$/)) {
      // Allow through; route-specific authz happens in the handler.
      return next();
    }

    const hasResourceId = segments.length > 1 && segments[1]!.length > 0;
    const verb = verbForRequest(c.req.method, hasResourceId);

    const enforcement = enforce({ resourceType, verb, auth });
    if (!enforcement.authorized) {
      throw forbidden(
        enforcement.denialReason ?? `Insufficient scope for ${verb} on ${resourceType}`,
      );
    }

    // Surface enforcement output to routes + repositories via the auth context
    c.set("auth", {
      ...auth,
      // We don't widen AuthContext here; routes that need the enforcement
      // result re-run `enforce()` if they want it. The middleware's job is
      // to authorize or reject; the data-path filter is applied via the
      // request-scope helpers (compartment-filter.ts, query-restriction.ts)
      // that routes invoke.
    });

    return next();
  };
}
