/**
 * Local AuthStrategy — verifies tokens issued by THIS server's SMART auth server (oauth/) using
 * the in-process public key (no network / JWKS fetch). Use `FHIRENGINE_AUTH_STRATEGY=local` to close
 * the loop: our authorization server issues the token, our gate verifies + enforces it.
 * (For an external IdP, use the `jwks` strategy with FHIRENGINE_JWKS_URI instead.)
 */
import { jwtVerify } from "jose";
import { verifyKey, OAUTH_ALG } from "../oauth/keys.js";
import type { AuthStrategy, IntrospectionResult } from "./types.js";

export class LocalAuthStrategy implements AuthStrategy {
  readonly name = "local";

  async introspect(token: string): Promise<IntrospectionResult> {
    try {
      // Pin to OUR signing alg — this strategy only ever verifies tokens this server issued.
      const { payload: p } = await jwtVerify(token, await verifyKey(), { algorithms: [OAUTH_ALG] });
      const scopeClaim = (p as Record<string, unknown>).scope ?? (p as Record<string, unknown>).scp;
      const scope = Array.isArray(scopeClaim) ? scopeClaim.join(" ") : typeof scopeClaim === "string" ? scopeClaim : "";
      return {
        active: true,
        sub: typeof p.sub === "string" ? p.sub : undefined,
        client_id: (p as Record<string, unknown>).client_id as string | undefined,
        scope,
        exp: typeof p.exp === "number" ? p.exp : undefined,
        iat: typeof p.iat === "number" ? p.iat : undefined,
        iss: typeof p.iss === "string" ? p.iss : undefined,
        aud: p.aud as string | string[] | undefined,
        token_type: "Bearer",
        patient: (p as Record<string, unknown>).patient as string | undefined,
        encounter: (p as Record<string, unknown>).encounter as string | undefined,
        fhirUser: (p as Record<string, unknown>).fhirUser as string | undefined,
      };
    } catch (e: unknown) {
      return { active: false, reason: `JWT verification failed: ${(e as { code?: string; message?: string })?.code ?? (e as Error)?.message ?? "invalid"}` };
    }
  }
}
