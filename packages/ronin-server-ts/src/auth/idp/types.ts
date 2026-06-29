/**
 * AuthStrategy — the swappable backend for token introspection.
 *
 * v1 ships two implementations:
 *   - `StubAuthStrategy` — for tests + local dev. Honors a synthetic token
 *     vocabulary.
 *   - `OidcAuthStrategy` — production. Talks to the customer's OIDC IdP via
 *     `openid-client` (RFC 7662 introspection + JWKS-based JWT validation
 *     when introspection isn't available).
 *
 * Adding a new strategy (e.g., a UDAP-aware introspection variant) is a
 * file-add + wiring in config.ts. No middleware changes.
 */

export interface IntrospectionResult {
  /** Token is active + not expired. */
  active: boolean;
  /** Subject identifier (`sub` claim). */
  sub?: string;
  /** Client ID. */
  client_id?: string;
  /** Space-separated scope string. */
  scope?: string;
  /** Token expiration (epoch seconds). */
  exp?: number;
  /** Token issuance (epoch seconds). */
  iat?: number;
  /** Token issuer. */
  iss?: string;
  /** Audience. */
  aud?: string | string[];
  /** Token type (usually Bearer). */
  token_type?: string;
  /** SMART launch claims (when present). */
  patient?: string;
  encounter?: string;
  fhirUser?: string;
  /** Reason for inactive token, for diagnostics. */
  reason?: string;
}

export interface AuthStrategy {
  /** Introspect a bearer token; return parsed claims. */
  introspect(token: string): Promise<IntrospectionResult>;
  /** Identifies this strategy in logs / AuditEvent.detail. */
  readonly name: string;
}
