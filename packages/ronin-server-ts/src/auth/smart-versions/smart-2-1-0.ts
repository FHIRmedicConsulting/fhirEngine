/**
 * SMART App Launch STU 2.1.0.
 *
 * Minor revision of 2.0.0; same scope grammar; clarifications on launch
 * context handling and PKCE. Inherits v2 + v1 parsing.
 */

import type { CanonicalScope, SmartVersionSpec } from "./types.js";
import { parseV2Scope } from "./smart-2-0-0.js";
import { parseV1Scope } from "./smart-1-0-0.js";

export const SmartV2_1_0: SmartVersionSpec = {
  version: "2.1.0",
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
    return parseV2Scope(rawScope, "2.1.0") ?? parseV1Scope(rawScope, "2.1.0");
  },
};
