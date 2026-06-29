/**
 * Stub auth strategy for tests + local dev.
 *
 * Honors a small synthetic token vocabulary so tests can express auth flows
 * without spinning up an IdP. Tokens are JSON-encoded base64url payloads:
 *
 *   stub.<base64url(JSON({sub, client_id, scope, patient?, ..., exp?}))>
 *
 * Plus three sugar tokens that tests use heavily:
 *   stub-system-all       — system/*.cruds (full access; no patient context)
 *   stub-patient-jane     — patient/*.cruds with launch/patient=jane-doe
 *   stub-user-rs          — user/*.rs (no patient context)
 *
 * Plus an explicit `stub-invalid` for negative tests.
 */

import type { AuthStrategy, IntrospectionResult } from "./types.js";

export class StubAuthStrategy implements AuthStrategy {
  readonly name = "stub";

  async introspect(token: string): Promise<IntrospectionResult> {
    if (token === "stub-invalid") {
      return { active: false, reason: "stub-invalid token explicitly rejected" };
    }
    if (token === "stub-system-all") {
      return {
        active: true,
        sub: "system-client-stub",
        client_id: "stub-client",
        scope: "system/*.cruds",
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
        iss: "stub-idp",
        token_type: "Bearer",
      };
    }
    if (token === "stub-patient-jane") {
      return {
        active: true,
        sub: "patient-jane-doe",
        client_id: "stub-app",
        scope: "patient/*.cruds launch/patient openid offline_access",
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
        iss: "stub-idp",
        token_type: "Bearer",
        patient: "patient-jane-doe-fhir-id",
      };
    }
    if (token === "stub-user-rs") {
      return {
        active: true,
        sub: "user-practitioner-001",
        client_id: "stub-app",
        scope: "user/*.rs openid",
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
        iss: "stub-idp",
        token_type: "Bearer",
        fhirUser: "Practitioner/practitioner-001",
      };
    }
    if (token.startsWith("stub.")) {
      try {
        const json = Buffer.from(token.slice(5), "base64url").toString("utf-8");
        const parsed = JSON.parse(json) as Partial<IntrospectionResult>;
        return {
          active: true,
          exp: Math.floor(Date.now() / 1000) + 3600,
          iat: Math.floor(Date.now() / 1000),
          iss: "stub-idp",
          token_type: "Bearer",
          ...parsed,
        };
      } catch {
        return { active: false, reason: "stub. token payload was not valid JSON" };
      }
    }
    return { active: false, reason: "unknown token (stub strategy)" };
  }
}

/** Helper for tests: encode a custom stub token payload. */
export function encodeStubToken(payload: Partial<IntrospectionResult>): string {
  const json = JSON.stringify(payload);
  return `stub.${Buffer.from(json, "utf-8").toString("base64url")}`;
}
