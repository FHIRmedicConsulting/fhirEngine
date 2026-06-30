/**
 * SMART App Launch discovery document (`/.well-known/smart-configuration`) + the matching
 * CapabilityStatement `oauth-uris` security extension.
 *
 * The discovery doc is assembled from the active {@link SmartVersionRegistry} (capabilities /
 * scopes / grant + response types / PKCE methods are the union across active SMART versions),
 * so adding a SMART version automatically updates discovery.
 *
 * The authorization/token endpoints are CONFIGURABLE — a deployment points these at its real
 * SMART authorization server (external IdP). Defaults are `${baseUrl}/oauth/{authorize,token}`;
 * the full OAuth2 authorization server itself is a later build (this slice ships discovery +
 * the auth *gate*, not token issuance).
 */
import { SmartVersionRegistry, ALL_ACTIVE_VERSIONS } from "../auth/smart-versions/index.js";

/** Resolve the advertised authorize/token endpoints (env-overridable). */
export function smartAuthUrls(baseUrl: string): { authorize: string; token: string } {
  return {
    authorize: process.env.RONIN_SMART_AUTHORIZE_URL ?? `${baseUrl}/oauth/authorize`,
    token: process.env.RONIN_SMART_TOKEN_URL ?? `${baseUrl}/oauth/token`,
  };
}

/** The active SMART version registry (same env selection as the auth gate). */
function activeRegistry(): SmartVersionRegistry {
  const versions = process.env.RONIN_SMART_VERSIONS?.split(",").map((s) => s.trim()).filter(Boolean);
  return new SmartVersionRegistry(versions?.length ? versions : ALL_ACTIVE_VERSIONS);
}

/** Build the `.well-known/smart-configuration` discovery document. */
export function buildSmartConfiguration(baseUrl: string): Record<string, unknown> {
  const reg = activeRegistry();
  const { authorize, token } = smartAuthUrls(baseUrl);
  const pkce = reg.unionPkceMethods();
  return {
    authorization_endpoint: authorize,
    token_endpoint: token,
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "private_key_jwt"],
    token_endpoint_auth_signing_alg_values_supported: ["RS256", "ES384"],
    grant_types_supported: reg.unionGrantTypes(),
    response_types_supported: reg.unionResponseTypes(),
    scopes_supported: reg.unionScopesSupported(),
    capabilities: reg.unionCapabilities(),
    ...(pkce.length ? { code_challenge_methods_supported: pkce } : {}),
    // OIDC bits advertised when sso-openid-connect is a capability.
    ...(reg.unionCapabilities().includes("sso-openid-connect")
      ? { issuer: baseUrl, jwks_uri: `${baseUrl}/.well-known/jwks.json` }
      : {}),
  };
}

/** The CapabilityStatement `rest[].security` block (SMART service coding + oauth-uris extension). */
export function smartSecurityBlock(baseUrl: string): Record<string, unknown> {
  const { authorize, token } = smartAuthUrls(baseUrl);
  return {
    cors: true,
    service: [
      {
        coding: [
          { system: "http://terminology.hl7.org/CodeSystem/restful-security-service", code: "SMART-on-FHIR", display: "SMART-on-FHIR" },
        ],
        text: "OAuth2 using SMART-on-FHIR profile (see http://www.hl7.org/fhir/smart-app-launch)",
      },
    ],
    extension: [
      {
        url: "http://fhir-registry.smarthealthit.org/StructureDefinition/oauth-uris",
        extension: [
          { url: "authorize", valueUri: authorize },
          { url: "token", valueUri: token },
        ],
      },
    ],
  };
}
