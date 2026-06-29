/**
 * Registry of supported SMART App Launch versions.
 *
 * Per the "current across the boards + easily upgradeable" design commitment:
 *   - All four currently published versions ship in v1 (1.0.0 / 2.0.0 / 2.1.0 / 2.2.0).
 *   - Adding a new version (e.g., 2.3.0) is a file-add + this-registry-edit;
 *     no other code touches required.
 *
 * Deployment-time selection via `ronin_smart_active_versions`. The discovery
 * document is the UNION of capabilities across all active versions. Scope
 * parsing tries each active version's grammar in declared order.
 */

import type { CanonicalScope, SmartVersionSpec } from "./types.js";
import { SmartV1_0_0 } from "./smart-1-0-0.js";
import { SmartV2_0_0 } from "./smart-2-0-0.js";
import { SmartV2_1_0 } from "./smart-2-1-0.js";
import { SmartV2_2_0 } from "./smart-2-2-0.js";

/** All versions Ronin can support. Add new versions here. */
export const ALL_SMART_VERSIONS: readonly SmartVersionSpec[] = [
  SmartV1_0_0,
  SmartV2_0_0,
  SmartV2_1_0,
  SmartV2_2_0,
] as const;

/** Default active version set for `payer_baseline` per ADR-0014. */
export const PAYER_BASELINE_ACTIVE_VERSIONS = ["2.0.0", "2.1.0", "2.2.0"];

/** Default active version set for `strict_federal` (latest only). */
export const STRICT_FEDERAL_ACTIVE_VERSIONS = ["2.2.0"];

/** Default active version set for tests + v1 default (everything Ronin supports). */
export const ALL_ACTIVE_VERSIONS = ALL_SMART_VERSIONS.map((v) => v.version);

/**
 * The active-set facade. Constructed once at startup; the middleware uses it
 * to parse scopes + assemble discovery + validate version-specific behaviors.
 */
export class SmartVersionRegistry {
  readonly active: readonly SmartVersionSpec[];

  constructor(activeVersionStrings: readonly string[]) {
    const byVersion = new Map(ALL_SMART_VERSIONS.map((v) => [v.version, v]));
    const active: SmartVersionSpec[] = [];
    for (const v of activeVersionStrings) {
      const spec = byVersion.get(v);
      if (!spec) {
        throw new Error(
          `Unknown SMART version "${v}". Known: ${Array.from(byVersion.keys()).join(", ")}`,
        );
      }
      active.push(spec);
    }
    if (active.length === 0) {
      throw new Error("SmartVersionRegistry requires at least one active version");
    }
    this.active = active;
  }

  /**
   * Try each active version's parser in declared order; return the first
   * successful canonical scope. Null if no version can parse it.
   */
  parseScope(rawScope: string): CanonicalScope | null {
    for (const spec of this.active) {
      const parsed = spec.parseScope(rawScope);
      if (parsed !== null) return parsed;
    }
    return null;
  }

  /**
   * Parse a space-separated scope string into canonical scopes; ignores
   * unparseable scopes (the IdP may have granted scopes Ronin doesn't recognize).
   */
  parseScopeString(scopeString: string): CanonicalScope[] {
    return scopeString
      .split(/\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => this.parseScope(s))
      .filter((s): s is CanonicalScope => s !== null);
  }

  /** Union of capabilities across active versions, deduplicated, sorted. */
  unionCapabilities(): string[] {
    const set = new Set<string>();
    for (const spec of this.active) {
      for (const cap of spec.capabilities) set.add(cap);
    }
    return Array.from(set).sort();
  }

  /** Union of scopes_supported across active versions. */
  unionScopesSupported(): string[] {
    const set = new Set<string>();
    for (const spec of this.active) {
      for (const s of spec.scopesSupported) set.add(s);
    }
    return Array.from(set).sort();
  }

  unionGrantTypes(): string[] {
    const set = new Set<string>();
    for (const spec of this.active) {
      for (const g of spec.grantTypesSupported) set.add(g);
    }
    return Array.from(set).sort();
  }

  unionResponseTypes(): string[] {
    const set = new Set<string>();
    for (const spec of this.active) {
      for (const r of spec.responseTypesSupported) set.add(r);
    }
    return Array.from(set).sort();
  }

  unionPkceMethods(): string[] {
    const set = new Set<string>();
    for (const spec of this.active) {
      for (const m of spec.pkceMethodsSupported) set.add(m);
    }
    return Array.from(set).sort();
  }

  /** True if any active version requires PKCE for public clients. */
  pkceRequiredForPublicClients(): boolean {
    return this.active.some((s) => s.pkceRequiredForPublicClients);
  }
}
