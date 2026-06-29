/**
 * SMART App Launch STU 2.0.0.
 *
 * CMS-0057-F adopted floor.
 *
 * v2 scope grammar:
 *   patient/Coverage.rs                  read + search
 *   patient/Coverage.cud                 create + update + delete
 *   patient/Coverage.cruds               full CRUDS
 *   patient/Observation.rs?category=lab  granular query restriction
 *
 * Servers MUST also accept v1 syntax per spec.
 */

import type { CanonicalScope, SmartVersionSpec, ScopeOperation } from "./types.js";
import { parseV1Scope } from "./smart-1-0-0.js";

// patient/Coverage.rs?category=lab|cat2
// Group 1: patient|user|system
// Group 2: resource type or *
// Group 3: cruds chars (ordered: c, r, u, d, s)
// Group 4: optional `?...` query string
const V2_SCOPE_PATTERN = /^(patient|user|system)\/(\*|[A-Z][A-Za-z]+)\.([crudsCRUDS]+)(\?.*)?$/;

export const SmartV2_0_0: SmartVersionSpec = {
  version: "2.0.0",
  capabilities: [
    "launch-ehr",
    "launch-standalone",
    "client-public",
    "client-confidential-symmetric",
    "client-confidential-asymmetric",
    "sso-openid-connect",
    "permission-patient",
    "permission-user",
    "permission-online",
    "permission-offline",
    "permission-v1",
    "permission-v2",
    "backend-services",
  ],
  scopesSupported: [
    "patient/*.rs",
    "patient/*.cruds",
    "user/*.rs",
    "user/*.cruds",
    "system/*.rs",
    "system/*.cruds",
    "openid",
    "profile",
    "fhirUser",
    "launch",
    "launch/patient",
    "online_access",
    "offline_access",
  ],
  responseTypesSupported: ["code"],
  grantTypesSupported: ["authorization_code", "client_credentials", "refresh_token"],
  pkceMethodsSupported: ["S256"],
  pkceRequiredForPublicClients: true,
  acceptsLegacyScopeGrammar: true,
  acceptsV2ScopeGrammar: true,
  launchContexts: ["launch", "launch/patient", "launch/encounter"],

  parseScope(rawScope: string): CanonicalScope | null {
    return parseV2Scope(rawScope, "2.0.0") ?? parseV1Scope(rawScope, "2.0.0");
  },
};

/**
 * Parse a v2-grammar scope. Returns null if the input doesn't match v2 syntax
 * (caller falls back to v1).
 */
export function parseV2Scope(rawScope: string, version: string): CanonicalScope | null {
  const trimmed = rawScope.trim();

  // Non-resource scopes (same as v1)
  if (
    trimmed === "openid" ||
    trimmed === "profile" ||
    trimmed === "fhirUser" ||
    trimmed === "online_access" ||
    trimmed === "offline_access" ||
    trimmed === "launch" ||
    trimmed.startsWith("launch/")
  ) {
    return parseV1Scope(trimmed, version);
  }

  const m = trimmed.match(V2_SCOPE_PATTERN);
  if (!m) return null;
  const [, ctx, resourceType, cruds, queryPart] = m;

  // Validate cruds letters: must be a subset of {c, r, u, d, s} in canonical order
  // and each letter at most once.
  const ops = normalizeCruds(cruds!.toLowerCase());
  if (ops === null) return null;

  const queryRestrictions: Record<string, string> = {};
  if (queryPart) {
    const params = new URLSearchParams(queryPart.slice(1));
    for (const [k, v] of params.entries()) {
      queryRestrictions[k] = v;
    }
  }

  return {
    context: ctx as CanonicalScope["context"],
    resourceType: resourceType === "*" ? "*" : resourceType!,
    operations: ops,
    queryRestrictions,
    rawScope: trimmed,
    parsedUnderVersion: version,
  };
}

const CRUDS_ORDER: readonly ScopeOperation[] = ["c", "r", "u", "d", "s"];

function normalizeCruds(input: string): ScopeOperation[] | null {
  const seen = new Set<string>();
  for (const ch of input) {
    if (!(CRUDS_ORDER as readonly string[]).includes(ch)) return null;
    if (seen.has(ch)) return null; // repeated letters are invalid
    seen.add(ch);
  }
  // Return in canonical order
  return CRUDS_ORDER.filter((c) => seen.has(c));
}
