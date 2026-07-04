/**
 * UDAP endpoints (ADR-0036) — the B2B trust surface for CMS-0057 / TEFCA. Opt-in via
 * `RONIN_UDAP_ENABLED=true` (requires `RONIN_UDAP_TRUST_ANCHORS`).
 *
 *   GET  /.well-known/udap        UDAP server metadata (endpoints, grant types, versions).
 *   POST /udap/register           Trusted Dynamic Client Registration — verify a software statement
 *                                 (cert chain → trust anchor) and register the client.
 *
 * A registered client immediately works at the existing token endpoint via private_key_jwt /
 * Backend Services (its key is the registration certificate). Tiered OAuth (signed authorize
 * requests) is a documented follow-up.
 */
import { Hono } from "hono";
import { verifySoftwareStatement, UdapError } from "./software-statement.js";
import { registerUdapClient } from "./registered-clients.js";
import { loadTrustAnchors } from "./trust.js";
import type { OAuthClient } from "../oauth/clients.js";

export const udapEnabled = (): boolean => process.env.RONIN_UDAP_ENABLED === "true";

const SUPPORTED_SCOPES = ["system/*.rs", "system/*.read", "openid", "fhirUser", "offline_access"];

export function udapRoutes(baseUrl: string): Hono {
  const app = new Hono();
  const registrationEndpoint = `${baseUrl}/udap/register`;

  // UDAP server metadata (community discovery).
  app.get("/.well-known/udap", (c) =>
    c.json({
      udap_versions_supported: ["1"],
      udap_certifications_supported: [],
      udap_certifications_required: [],
      grant_types_supported: ["authorization_code", "client_credentials", "refresh_token"],
      scopes_supported: SUPPORTED_SCOPES,
      authorization_endpoint: `${baseUrl}/oauth/authorize`,
      token_endpoint: `${baseUrl}/oauth/token`,
      token_endpoint_auth_methods_supported: ["private_key_jwt"],
      registration_endpoint: registrationEndpoint,
      registration_endpoint_jwt_signing_alg_values_supported: ["RS256", "ES256"],
    }),
  );

  // Trusted Dynamic Client Registration.
  app.post("/udap/register", async (c) => {
    const anchors = loadTrustAnchors();
    if (!anchors.length) {
      return c.json({ error: "invalid_client_metadata", error_description: "UDAP trust anchors not configured" }, 400);
    }
    let body: { software_statement?: string; udap?: string; grant_types?: string[] };
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid_client_metadata", error_description: "invalid JSON body" }, 400); }
    if (!body.software_statement) {
      return c.json({ error: "invalid_software_statement", error_description: "software_statement is required" }, 400);
    }

    let ss;
    try {
      ss = await verifySoftwareStatement(body.software_statement, { audience: registrationEndpoint, anchors });
    } catch (err) {
      const msg = err instanceof UdapError ? err.message : "software statement verification failed";
      return c.json({ error: "invalid_software_statement", error_description: msg }, 400);
    }

    // Register the client with its cert-derived JWKS (Backend Services / private_key_jwt).
    const client: OAuthClient = {
      clientId: ss.iss,
      type: "confidential",
      jwks: ss.jwks,
      redirectUris: ss.redirectUris,
    };
    registerUdapClient(client);

    return c.json(
      {
        client_id: ss.iss,
        software_statement: body.software_statement,
        grant_types: ss.grantTypes,
        response_types: ss.responseTypes,
        token_endpoint_auth_method: ss.tokenEndpointAuthMethod,
        scope: ss.scope,
        client_name: ss.clientName,
        ...(ss.redirectUris ? { redirect_uris: ss.redirectUris } : {}),
      },
      201,
      { "Cache-Control": "no-store" },
    );
  });

  return app;
}
