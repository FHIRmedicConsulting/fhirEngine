/**
 * SMART App Launch STU 1.0.0.
 *
 * Pre-CMS-9115-era scope grammar:
 *   patient/Coverage.read   (read)
 *   patient/*.write         (write only — no read)
 *   patient/Coverage.*      (full access)
 *   user/Coverage.read
 *   system/Coverage.*
 *
 * Plus openid, profile, launch, launch/patient, online_access, offline_access.
 */

import type { CanonicalScope, SmartVersionSpec } from "./types.js";

const SCOPE_PATTERN = /^(patient|user|system)\/(\*|[A-Z][A-Za-z]+)\.(read|write|\*)$/;

export const SmartV1_0_0: SmartVersionSpec = {
  version: "1.0.0",
  capabilities: [
    "launch-ehr",
    "launch-standalone",
    "client-public",
    "client-confidential-symmetric",
    "sso-openid-connect",
    "permission-patient",
    "permission-user",
    "permission-online",
    "permission-offline",
    "permission-v1",
  ],
  scopesSupported: [
    "patient/*.read",
    "patient/*.write",
    "patient/*.*",
    "user/*.read",
    "user/*.write",
    "system/*.read",
    "system/*.write",
    "system/*.*",
    "openid",
    "profile",
    "fhirUser",
    "launch",
    "launch/patient",
    "online_access",
    "offline_access",
  ],
  responseTypesSupported: ["code"],
  grantTypesSupported: ["authorization_code", "refresh_token"],
  pkceMethodsSupported: ["S256", "plain"],
  pkceRequiredForPublicClients: false, // PKCE recommended but not mandatory in v1
  acceptsLegacyScopeGrammar: true,
  acceptsV2ScopeGrammar: false,
  launchContexts: ["launch", "launch/patient", "launch/encounter"],

  parseScope(rawScope: string): CanonicalScope | null {
    return parseV1Scope(rawScope, "1.0.0");
  },
};

/**
 * Parse a v1-grammar scope. Exported for reuse by v2+ specs (they accept v1 too).
 */
export function parseV1Scope(rawScope: string, version: string): CanonicalScope | null {
  const trimmed = rawScope.trim();

  // Non-resource scopes
  if (trimmed === "openid")
    return base(trimmed, version, "openid", null, []);
  if (trimmed === "profile")
    return base(trimmed, version, "profile", null, []);
  if (trimmed === "fhirUser")
    return base(trimmed, version, "fhirUser", null, []);
  if (trimmed === "online_access")
    return base(trimmed, version, "online_access", null, []);
  if (trimmed === "offline_access")
    return base(trimmed, version, "offline_access", null, []);
  if (trimmed === "launch" || trimmed.startsWith("launch/"))
    return base(trimmed, version, "launch", null, []);

  // Resource scopes
  const m = trimmed.match(SCOPE_PATTERN);
  if (!m) return null;
  const [, ctx, resourceType, op] = m;
  const operations = expandV1Operation(op!);
  return {
    context: ctx as CanonicalScope["context"],
    resourceType: resourceType === "*" ? "*" : resourceType!,
    operations,
    queryRestrictions: {},
    rawScope: trimmed,
    parsedUnderVersion: version,
  };
}

function expandV1Operation(op: string): CanonicalScope["operations"] {
  // SMART v1 grammar:
  //   .read  → canonical r + s
  //   .write → canonical c + u + d
  //   .*     → c + r + u + d + s
  switch (op) {
    case "read":
      return ["r", "s"];
    case "write":
      return ["c", "u", "d"];
    case "*":
      return ["c", "r", "u", "d", "s"];
    default:
      return [];
  }
}

function base(
  rawScope: string,
  version: string,
  context: CanonicalScope["context"],
  resourceType: string | null,
  operations: CanonicalScope["operations"],
): CanonicalScope {
  return {
    context,
    resourceType,
    operations,
    queryRestrictions: {},
    rawScope,
    parsedUnderVersion: version,
  };
}
