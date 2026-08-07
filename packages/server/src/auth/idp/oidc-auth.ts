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

import { createRemoteJWKSet, importPKCS8, jwtVerify, SignJWT } from "jose";
import { randomUUID } from "node:crypto";
import type { AuthStrategy, IntrospectionResult } from "./types.js";
import { mapJwtClaims } from "./jwks-auth.js";

export interface OidcAuthOptions {
  /** OIDC discovery URL — e.g., https://your-idp/.well-known/openid-configuration */
  discoveryUrl: string;
  /** fhirEngine's client_id at the IdP. */
  clientId: string;
  /** fhirEngine's client_secret (or null if private_key_jwt / public). */
  clientSecret: string | null;
  /** JWKS cache TTL in seconds. */
  jwksCacheTtl: number;
  /** private_key_jwt client auth (RFC 7523): PKCS8 PEM used to sign the introspection
   * client_assertion when no clientSecret is configured. */
  privateKey?: string;
  /** Signing alg for `privateKey` (default RS256). */
  privateKeyAlg?: string;
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
      // No introspection endpoint → JWKS-based JWT validation: the token's own signature,
      // verified against the IdP's published JWKS, is the proof (same model as JwksAuthStrategy,
      // but discovery-driven). Fails closed when the IdP advertises neither capability.
      if (discovery.jwks_uri) return this.verifyViaJwks(token, discovery);
      return {
        active: false,
        reason: `IdP at ${this.options.discoveryUrl} advertises neither introspection_endpoint nor jwks_uri; cannot validate tokens.`,
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
    } else if (this.options.privateKey) {
      // private_key_jwt (RFC 7523 §2.2): signed client_assertion; aud = the AS itself
      // (issuer when advertised, else the token endpoint) per §3.
      body.set("client_id", this.options.clientId);
      body.set("client_assertion_type", "urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
      body.set("client_assertion", await this.clientAssertion(discovery));
    } else {
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

  /** JWKS fallback: verify the bearer's own JWT signature against the IdP's published JWKS.
   * The remote key set is cached per jwks_uri (jose refreshes per `jwksCacheTtl`). */
  private jwksCache: { keySet: ReturnType<typeof createRemoteJWKSet>; uri: string } | null = null;
  private async verifyViaJwks(token: string, discovery: DiscoveryDocument): Promise<IntrospectionResult> {
    try {
      const uri = discovery.jwks_uri!; // caller guarantees presence
      const cache = this.jwksCache?.uri === uri
        ? this.jwksCache
        : (this.jwksCache = { uri, keySet: createRemoteJWKSet(new URL(uri), { cacheMaxAge: this.options.jwksCacheTtl * 1000 }) });
      const { payload } = await jwtVerify(token, cache.keySet, {
        // Asymmetric-only allow-list (same posture as JwksAuthStrategy — no none/HS*).
        algorithms: ["RS256", "PS256", "ES256", "ES384"],
        ...(discovery.issuer ? { issuer: discovery.issuer } : {}),
      });
      return mapJwtClaims(payload as Record<string, unknown>);
    } catch (e) {
      return { active: false, reason: `JWT verification failed: ${(e as { code?: string; message?: string })?.code ?? (e as Error)?.message ?? "invalid"}` };
    }
  }

  /** Signed client_assertion for private_key_jwt introspection auth (RFC 7523). */
  private async clientAssertion(discovery: DiscoveryDocument): Promise<string> {
    const key = await importPKCS8(this.options.privateKey!, this.options.privateKeyAlg ?? "RS256");
    const aud = discovery.issuer ?? discovery.token_endpoint ?? this.options.discoveryUrl;
    return new SignJWT({ jti: randomUUID() })
      .setProtectedHeader({ alg: this.options.privateKeyAlg ?? "RS256", typ: "JWT" })
      .setIssuer(this.options.clientId)
      .setSubject(this.options.clientId)
      .setAudience(aud)
      .setIssuedAt()
      .setExpirationTime("60s")
      .sign(key);
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
