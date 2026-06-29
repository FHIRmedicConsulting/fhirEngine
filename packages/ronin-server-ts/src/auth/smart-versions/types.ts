/**
 * SMART App Launch version specification.
 *
 * Each supported SMART version ships as a `SmartVersionSpec` module under
 * `src/auth/smart-versions/`. Adding a new SMART version (e.g., 2.3, 3.0) is a
 * file-add + registry-register — no other code changes required.
 *
 * This is the "easily upgradeable" commitment per the design discussion.
 */

/**
 * The canonical (internal v2) representation of a parsed scope. Every parser —
 * regardless of input SMART version — produces this shape.
 */
export interface CanonicalScope {
  /** The granting context: patient / user / system / launch / openid / etc. */
  context: ScopeContext;
  /** Resource type or "*" for wildcard. Null for non-resource scopes (openid, launch). */
  resourceType: string | null;
  /**
   * The set of CRUDS operations granted: c, r, u, d, s.
   * Empty for non-resource scopes.
   */
  operations: ScopeOperation[];
  /** Granular query restriction key/value pairs (v2+). */
  queryRestrictions: Record<string, string>;
  /** Original scope string as received from the IdP (for AuditEvent / debugging). */
  rawScope: string;
  /** Which SMART version's grammar this was parsed under. */
  parsedUnderVersion: string;
}

export type ScopeContext = "patient" | "user" | "system" | "launch" | "openid" | "fhirUser" | "profile" | "offline_access" | "online_access" | "other";
export type ScopeOperation = "c" | "r" | "u" | "d" | "s";

/**
 * Per-SMART-version specification.
 */
export interface SmartVersionSpec {
  /** Semantic version string. */
  version: string;

  /** Capability strings advertised in `.well-known/smart-configuration`. */
  capabilities: string[];

  /** Scope strings advertised in `scopes_supported`. */
  scopesSupported: string[];

  /** Response types advertised in `response_types_supported`. */
  responseTypesSupported: string[];

  /** Grant types advertised in `grant_types_supported`. */
  grantTypesSupported: string[];

  /** PKCE code_challenge methods. Empty array = PKCE not required. */
  pkceMethodsSupported: string[];

  /** Whether public clients MUST use PKCE. */
  pkceRequiredForPublicClients: boolean;

  /** Whether this version's parser accepts legacy v1 scope grammar (`.read`, `.write`, `.*`). */
  acceptsLegacyScopeGrammar: boolean;

  /** Whether this version's parser accepts v2 scope grammar (`.rs`, `.cruds`, `?param=value`). */
  acceptsV2ScopeGrammar: boolean;

  /** Launch contexts supported (`launch/patient`, `launch/encounter`, ...). */
  launchContexts: string[];

  /**
   * Try to parse a scope string under this version's grammar. Returns null if
   * the scope doesn't match this version's syntax (allowing the registry to
   * try the next version).
   */
  parseScope: (rawScope: string) => CanonicalScope | null;
}
