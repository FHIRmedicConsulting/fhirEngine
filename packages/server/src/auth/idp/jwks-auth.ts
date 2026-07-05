/**
 * JWKS / local-JWT AuthStrategy (ADR-0030) — the previously-unimplemented strategy noted
 * in oidc-auth.ts. Verifies the bearer token's own JWT signature against a configured JWKS
 * (`FHIRENGINE_JWKS_URI`, production IdP) or a local public key (`FHIRENGINE_JWT_PUBLIC_KEY` SPKI/PEM,
 * dev); the signature IS the proof — no introspection endpoint needed. SMART/UDAP-shaped.
 *
 * Requester identity/scopes come ONLY from verified claims, never request headers.
 */
import { jwtVerify, createRemoteJWKSet, importSPKI } from "jose";
import type { AuthStrategy, IntrospectionResult } from "./types.js";

// A verification key (local public key) or a JWKS get-key resolver; jwtVerify accepts both.
type KeyInput = Awaited<ReturnType<typeof importSPKI>> | ReturnType<typeof createRemoteJWKSet>;

export class JwksAuthStrategy implements AuthStrategy {
  readonly name = "jwks";
  private keyPromise: Promise<KeyInput> | null = null;
  private readonly alg = process.env.FHIRENGINE_JWT_ALG ?? "ES256";

  private key(): Promise<KeyInput> {
    if (this.keyPromise) return this.keyPromise;
    if (process.env.FHIRENGINE_JWKS_URI) {
      this.keyPromise = Promise.resolve(createRemoteJWKSet(new URL(process.env.FHIRENGINE_JWKS_URI)));
    } else if (process.env.FHIRENGINE_JWT_PUBLIC_KEY) {
      this.keyPromise = importSPKI(process.env.FHIRENGINE_JWT_PUBLIC_KEY, this.alg);
    } else {
      this.keyPromise = Promise.reject(new Error("no JWT verification key (set FHIRENGINE_JWKS_URI or FHIRENGINE_JWT_PUBLIC_KEY)"));
    }
    return this.keyPromise;
  }

  /** Reset the cached key (rotation / tests). */
  resetKey(): void { this.keyPromise = null; }

  async introspect(token: string): Promise<IntrospectionResult> {
    try {
      const opts = {
        // Alg allow-list pinned at VERIFY time (not just key import): rejects the none/HS*/
        // key-confusion classes outright. FHIRENGINE_JWT_ALG pins one alg; default =
        // asymmetric-only set (SP 800-52r2-aligned; §2.2 A5 of the security deep-dive).
        algorithms: process.env.FHIRENGINE_JWT_ALG ? [process.env.FHIRENGINE_JWT_ALG] : ["ES256", "ES384", "RS256", "PS256"],
        ...(process.env.FHIRENGINE_JWT_ISSUER ? { issuer: process.env.FHIRENGINE_JWT_ISSUER } : {}),
        ...(process.env.FHIRENGINE_JWT_AUDIENCE ? { audience: process.env.FHIRENGINE_JWT_AUDIENCE } : {}),
      };
      // key union vs jwtVerify overloads
      const { payload: p } = await jwtVerify(token, (await this.key()) as any, opts);
      const scopeClaim = (p as any).scope ?? (p as any).scp;
      const scope = Array.isArray(scopeClaim) ? scopeClaim.join(" ") : typeof scopeClaim === "string" ? scopeClaim : "";
      return {
        active: true,
        sub: typeof p.sub === "string" ? p.sub : undefined,
        client_id: (p as any).client_id ?? (p as any).azp,
        scope,
        exp: typeof p.exp === "number" ? p.exp : undefined,
        iat: typeof p.iat === "number" ? p.iat : undefined,
        iss: typeof p.iss === "string" ? p.iss : undefined,
        aud: p.aud as string | string[] | undefined,
        token_type: "Bearer",
        patient: (p as any).patient,
        encounter: (p as any).encounter,
        fhirUser: (p as any).fhirUser,
      };
    } catch (e: any) {
      return { active: false, reason: `JWT verification failed: ${e?.code ?? e?.message ?? "invalid"}` }; // no token/key echo
    }
  }
}
