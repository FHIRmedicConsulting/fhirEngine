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
import { registerUdapClient, persistUdapClient, type UdapClientBackend } from "./registered-clients.js";
import { SignJWT, importPKCS8 } from "jose";
import { loadTrustAnchors, pemChainToX5c } from "./trust.js";
import type { OAuthClient } from "../oauth/clients.js";

export const udapEnabled = (): boolean => process.env.RONIN_UDAP_ENABLED === "true";

const SUPPORTED_SCOPES = ["system/*.rs", "system/*.read", "openid", "fhirUser", "offline_access"];

/**
 * UDAP `signed_metadata`: a JWS of the server metadata, signed by the server's UDAP certificate
 * (its chain in the `x5c` header), proving the metadata's authenticity to relying parties. Emitted
 * only when RONIN_UDAP_SERVER_KEY (PEM PKCS8) + RONIN_UDAP_SERVER_CERT (PEM chain) are configured.
 */
async function signMetadata(baseUrl: string, claims: Record<string, unknown>, env: NodeJS.ProcessEnv): Promise<string | null> {
  const keyPem = env.RONIN_UDAP_SERVER_KEY, certPem = env.RONIN_UDAP_SERVER_CERT;
  if (!keyPem || !certPem) return null;
  try {
    const key = await importPKCS8(keyPem, "RS256");
    const x5c = pemChainToX5c(certPem);
    if (!x5c.length) return null;
    return await new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", x5c })
      .setIssuer(baseUrl).setSubject(baseUrl).setIssuedAt().setExpirationTime("1h").sign(key);
  } catch { return null; }
}

export function udapRoutes(baseUrl: string, wh?: UdapClientBackend): Hono {
  const app = new Hono();
  const registrationEndpoint = `${baseUrl}/udap/register`;

  // UDAP server metadata (community discovery) + optional signed_metadata.
  app.get("/.well-known/udap", async (c) => {
    const metadata: Record<string, unknown> = {
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
    };
    const signed = await signMetadata(baseUrl, {
      authorization_endpoint: metadata.authorization_endpoint,
      token_endpoint: metadata.token_endpoint,
      registration_endpoint: metadata.registration_endpoint,
      grant_types_supported: metadata.grant_types_supported,
      scopes_supported: metadata.scopes_supported,
      token_endpoint_auth_methods_supported: metadata.token_endpoint_auth_methods_supported,
    }, process.env);
    return c.json(signed ? { ...metadata, signed_metadata: signed } : metadata);
  });

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
    registerUdapClient(client);                       // hot cache (immediate)
    if (wh) await persistUdapClient(wh, client, new Date().toISOString()); // durable (survives restart)

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
