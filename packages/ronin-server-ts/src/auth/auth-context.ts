/**
 * Auth context attached to every request after the auth middleware runs.
 *
 * The context carries:
 *   - The parsed canonical scopes from the introspected token.
 *   - Launch claims (patient, encounter, user) from the token / SMART launch.
 *   - Subject / client identity for AuditEvent capture.
 *   - Enforcement result (set after the per-handler check runs).
 *
 * Repositories and route handlers read from this context to apply the
 * compartment + query-restriction filters at the data path (points 3 + 4 of the
 * five-point chain).
 */

import type { CanonicalScope } from "./smart-versions/types.js";

export interface AuthContext {
  /** Original Bearer token; hashed-with-salt before going into AuditEvent. */
  token: string;
  /** Subject identifier from the IdP (`sub` claim). */
  subject: string;
  /** Client ID that obtained the token (`client_id` claim). */
  clientId: string;
  /** Parsed scopes. */
  scopes: CanonicalScope[];
  /** Raw scope string from the IdP for AuditEvent capture. */
  rawScopeString: string;
  /** Patient launch context (`patient` claim or `launch/patient` resolution). */
  launchPatientId: string | null;
  /** Encounter launch context. */
  launchEncounterId: string | null;
  /** User identity (`fhirUser` claim, typically a Practitioner reference). */
  fhirUser: string | null;
  /** Claimed Purpose-of-Use header (X-Purpose-Of-Use) for the request. */
  purposeOfUse: string | null;
  /** Token expiration epoch seconds. */
  expiresAt: number;
  /** Issuer URL (`iss` claim). */
  issuer: string;
  /** SMART version under which the scopes were parsed. */
  parsedUnderSmartVersion: string;
}

/**
 * Sentinel for routes that are mounted before/outside the auth middleware
 * (e.g., /health, /metadata, /.well-known/*).
 */
export const AUTH_BYPASS_CONTEXT: AuthContext = {
  token: "",
  subject: "unauthenticated",
  clientId: "unauthenticated",
  scopes: [],
  rawScopeString: "",
  launchPatientId: null,
  launchEncounterId: null,
  fhirUser: null,
  purposeOfUse: null,
  expiresAt: 0,
  issuer: "",
  parsedUnderSmartVersion: "",
};
