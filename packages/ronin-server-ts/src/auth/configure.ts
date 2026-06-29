/**
 * Auth-gate wiring (ADR-0030) — assembles the heritage SMART/UDAP chain for the delta app:
 * an AuthStrategy (stub | jwks | oidc) → IntrospectionService (LRU) → SmartVersionRegistry →
 * the heritage `authMiddleware`. Enablement + strategy are env-config; default off.
 *
 *   RONIN_AUTH_ENABLED=true            turn the gate on (deploy gate for PHI)
 *   RONIN_AUTH_STRATEGY=stub|jwks|oidc  default 'jwks' (the ADR-0030 model); 'stub' for tests
 *   RONIN_SMART_VERSIONS=2.0.0,2.2.0    active SMART grammars (default: all supported)
 */
import type { MiddlewareHandler } from "hono";
import { authMiddleware } from "./auth-middleware.js";
import { IntrospectionService } from "./token-introspection.js";
import { SmartVersionRegistry, ALL_ACTIVE_VERSIONS } from "./smart-versions/index.js";
import { StubAuthStrategy } from "./idp/stub-auth.js";
import { JwksAuthStrategy } from "./idp/jwks-auth.js";
import type { AuthStrategy } from "./idp/types.js";

export const authEnabled = (): boolean => process.env.RONIN_AUTH_ENABLED === "true";

function buildStrategy(): AuthStrategy {
  switch (process.env.RONIN_AUTH_STRATEGY ?? "jwks") {
    case "stub": return new StubAuthStrategy();
    case "jwks": return new JwksAuthStrategy();
    // case "oidc": return new OidcAuthStrategy({ discoveryUrl: process.env.RONIN_OIDC_DISCOVERY!, ... });
    default: return new JwksAuthStrategy();
  }
}

export function buildAuthMiddleware(): MiddlewareHandler {
  const introspection = new IntrospectionService(buildStrategy(), { ttlSeconds: 300, maxEntries: 1000 });
  const versions = process.env.RONIN_SMART_VERSIONS?.split(",").map((s) => s.trim()).filter(Boolean);
  const registry = new SmartVersionRegistry(versions?.length ? versions : ALL_ACTIVE_VERSIONS);
  return authMiddleware({ introspection, registry });
}
