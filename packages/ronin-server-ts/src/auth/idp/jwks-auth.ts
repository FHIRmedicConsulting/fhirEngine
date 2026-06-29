/**
 * JWKS / local-JWT AuthStrategy (ADR-0030) — the previously-unimplemented strategy noted
 * in oidc-auth.ts. Verifies the bearer token's own JWT signature against a configured JWKS
 * (`RONIN_JWKS_URI`, production IdP) or a local public key (`RONIN_JWT_PUBLIC_KEY` SPKI/PEM,
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
  private readonly alg = process.env.RONIN_JWT_ALG ?? "ES256";

  private key(): Promise<KeyInput> {
    if (this.keyPromise) return this.keyPromise;
    if (process.env.RONIN_JWKS_URI) {
      this.keyPromise = Promise.resolve(createRemoteJWKSet(new URL(process.env.RONIN_JWKS_URI)));
    } else if (process.env.RONIN_JWT_PUBLIC_KEY) {
      this.keyPromise = importSPKI(process.env.RONIN_JWT_PUBLIC_KEY, this.alg);
    } else {
      this.keyPromise = Promise.reject(new Error("no JWT verification key (set RONIN_JWKS_URI or RONIN_JWT_PUBLIC_KEY)"));
    }
    return this.keyPromise;
  }

  /** Reset the cached key (rotation / tests). */
  resetKey(): void { this.keyPromise = null; }

  async introspect(token: string): Promise<IntrospectionResult> {
    try {
      const opts = {
        ...(process.env.RONIN_JWT_ISSUER ? { issuer: process.env.RONIN_JWT_ISSUER } : {}),
        ...(process.env.RONIN_JWT_AUDIENCE ? { audience: process.env.RONIN_JWT_AUDIENCE } : {}),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- key union vs jwtVerify overloads
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
