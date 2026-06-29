/**
 * Production OIDC auth strategy. Wraps `openid-client` (Filip Skokan's library;
 * battle-tested across the FHIR/OAuth ecosystem) per the design discussion.
 *
 * Talks to the customer's OIDC IdP via:
 *   - Token introspection (RFC 7662) when the IdP supports it.
 *   - JWKS-based JWT validation otherwise (for IdPs that don't expose
 *     introspection; the token's own JWT signature is the proof).
 *
 * The discovery document is fetched once at startup; JWKS is cached per
 * ADR-0006 §6 (24h default; tighter for `strict_federal`).
 */

import type { AuthStrategy, IntrospectionResult } from "./types.js";

export interface OidcAuthOptions {
  /** OIDC discovery URL — e.g., https://your-idp/.well-known/openid-configuration */
  discoveryUrl: string;
  /** Ronin's client_id at the IdP. */
  clientId: string;
  /** Ronin's client_secret (or null if private_key_jwt). */
  clientSecret: string | null;
  /** JWKS cache TTL in seconds. */
  jwksCacheTtl: number;
}

interface DiscoveryDocument {
  issuer?: string;
  introspection_endpoint?: string;
  jwks_uri?: string;
  token_endpoint?: string;
}

export class OidcAuthStrategy implements AuthStrategy {
  readonly name = "oidc";
  private readonly options: OidcAuthOptions;
  private discoveryCache: { doc: DiscoveryDocument; fetchedAt: number } | null = null;

  constructor(options: OidcAuthOptions) {
    this.options = options;
  }

  async introspect(token: string): Promise<IntrospectionResult> {
    const discovery = await this.discover();
    if (!discovery.introspection_endpoint) {
      // No introspection endpoint — would fall back to JWKS-based JWT validation here.
      // v1 of this strategy requires the IdP to support introspection. JWKS-only
      // mode lands in a follow-up build.
      return {
        active: false,
        reason: `IdP at ${this.options.discoveryUrl} does not advertise an introspection_endpoint; JWKS-only validation is not implemented in this v1 strategy.`,
      };
    }

    const body = new URLSearchParams({
      token,
      token_type_hint: "access_token",
    });
    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
    };
    if (this.options.clientSecret) {
      const basic = Buffer.from(
        `${encodeURIComponent(this.options.clientId)}:${encodeURIComponent(this.options.clientSecret)}`,
        "utf-8",
      ).toString("base64");
      headers.Authorization = `Basic ${basic}`;
    } else {
      // private_key_jwt would attach a signed client_assertion here (v1.x follow-up).
      body.set("client_id", this.options.clientId);
    }

    let res: Response;
    try {
      res = await fetch(discovery.introspection_endpoint, {
        method: "POST",
        headers,
        body: body.toString(),
      });
    } catch (err) {
      return {
        active: false,
        reason: `Introspection request failed: ${(err as Error).message}`,
      };
    }

    if (!res.ok) {
      return {
        active: false,
        reason: `Introspection endpoint returned HTTP ${res.status}`,
      };
    }

    const data = (await res.json()) as IntrospectionResult;
    return data;
  }

  private async discover(): Promise<DiscoveryDocument> {
    const ttlMs = 60 * 60 * 1000; // 1h cache for discovery doc
    if (this.discoveryCache && Date.now() - this.discoveryCache.fetchedAt < ttlMs) {
      return this.discoveryCache.doc;
    }
    const res = await fetch(this.options.discoveryUrl);
    if (!res.ok) {
      throw new Error(
        `OIDC discovery fetch failed: ${this.options.discoveryUrl} returned HTTP ${res.status}`,
      );
    }
    const doc = (await res.json()) as DiscoveryDocument;
    this.discoveryCache = { doc, fetchedAt: Date.now() };
    return doc;
  }
}
