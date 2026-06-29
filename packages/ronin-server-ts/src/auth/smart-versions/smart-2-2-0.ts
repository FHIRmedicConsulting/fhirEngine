/**
 * SMART App Launch STU 2.2.0 — current latest.
 *
 * Adds `client-confidential-asymmetric` (UDAP-style asymmetric client auth as
 * a SMART option), and stabilizes the v2 scope grammar.
 *
 * Inherits v2 + v1 scope parsing.
 */

import type { CanonicalScope, SmartVersionSpec } from "./types.js";
import { parseV2Scope } from "./smart-2-0-0.js";
import { parseV1Scope } from "./smart-1-0-0.js";

export const SmartV2_2_0: SmartVersionSpec = {
  version: "2.2.0",
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
    "authorize-post",
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
  grantTypesSupported: [
    "authorization_code",
    "client_credentials",
    "refresh_token",
    "urn:ietf:params:oauth:grant-type:jwt-bearer",
  ],
  pkceMethodsSupported: ["S256"],
  pkceRequiredForPublicClients: true,
  acceptsLegacyScopeGrammar: true,
  acceptsV2ScopeGrammar: true,
  launchContexts: ["launch", "launch/patient", "launch/encounter"],

  parseScope(rawScope: string): CanonicalScope | null {
    return parseV2Scope(rawScope, "2.2.0") ?? parseV1Scope(rawScope, "2.2.0");
  },
};
