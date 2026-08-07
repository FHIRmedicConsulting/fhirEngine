/**
 * SMART App Launch authorization server (ADR-0006 / ADR-0030) — the endpoints
 * `.well-known/smart-configuration` advertises. Opt-in via `FHIRENGINE_OAUTH_ENABLED`.
 *
 *   GET  /oauth/authorize   authorization_code + PKCE (auto-approve; no interactive login in
 *                           this headless server — patient/user come from config).
 *   POST /oauth/token       authorization_code | refresh_token | client_credentials → tokens.
 *   GET  /.well-known/jwks.json   public keys for verifying issued tokens.
 *
 * The issued access token is a JWT the auth gate verifies in-process (FHIRENGINE_AUTH_STRATEGY=local)
 * or via this JWKS — closing the loop: this server issues, our gate enforces.
 *
 * Scope: standalone patient/practitioner app flow PLUS SMART Backend Services
 * (client_credentials + private_key_jwt client assertion, verified against the client's JWKS;
 * see the client_credentials branch below). NOT yet implemented: UDAP/SSRAA (dynamic client
 * registration, X.509 software statements) — a documented follow-up.
 */
import { Hono } from "hono";
import { jwtVerify, decodeJwt, createLocalJWKSet } from "jose";
import { publicJwks } from "./keys.js";
import { putCode, takeCode, putRefresh, takeRefresh, jtiReplay } from "./store.js";
import { signAccessToken, signIdToken, verifyPkce } from "./tokens.js";
import { resolveClient, redirectAllowed, clientKeySet } from "./clients.js";

export const oauthEnabled = (): boolean => process.env.FHIRENGINE_OAUTH_ENABLED === "true";

/** Patient/user/encounter launch context for the auto-approve flow (dev/test — configured, not picked). */
function launchContext(scope: string): { patient?: string; encounter?: string; user?: string } {
  // `launch` (EHR launch) and `launch/patient` (standalone) both resolve the configured patient
  // context; patient/* scopes alone imply it too (the token must be compartment-scoped).
  const wantsPatient = /(^|\s)(launch|launch\/patient|patient\/)/.test(scope);
  const patient = wantsPatient ? process.env.FHIRENGINE_OAUTH_DEFAULT_PATIENT : undefined;
  // Encounter context for EHR launch (`launch` scope) or explicit `launch/encounter`.
  const wantsEncounter = /(^|\s)(launch|launch\/encounter)(\s|$)/.test(scope);
  const encounter = wantsEncounter ? process.env.FHIRENGINE_OAUTH_DEFAULT_ENCOUNTER : undefined;
  const user = process.env.FHIRENGINE_OAUTH_DEFAULT_USER ?? (patient ? `Patient/${patient}` : undefined);
  return { patient, encounter, user };
}

/** Normalize SMART v1 scope suffixes to v2 (`read`→`rs`, `write`→`cud`, `*`→`cruds`). SMART 2.x
 * servers respond in v2 grammar even when the app requested v1 (§scopes-for-requesting-fhir-
 * resources); (g)(10) STU2 launch tests assert the granted form. */
function normalizeScopesToV2(scope: string): string {
  return scope.split(/\s+/).filter(Boolean).map((s) => {
    const m = /^(patient|user|system)\/([A-Za-z*]+)\.(read|write|\*)$/.exec(s);
    if (!m) return s;
    const suffix = m[3] === "read" ? "rs" : m[3] === "write" ? "cud" : "cruds";
    return `${m[1]}/${m[2]}.${suffix}`;
  }).join(" ");
}

/** Operator-configured granular scope selection: `FHIRENGINE_OAUTH_SCOPE_SUBSTITUTIONS` = JSON map
 * of requested scope → replacement scope(s). Emulates the user narrowing consent to granular
 * sub-scopes in this headless auto-approve authorize step ((g)(10) granular scope selection —
 * a real deployment surfaces this as a consent-screen choice). Unset = grant as requested. */
function applyScopeSubstitutions(scope: string): string {
  const raw = process.env.FHIRENGINE_OAUTH_SCOPE_SUBSTITUTIONS;
  if (!raw) return scope;
  let map: Record<string, string>;
  try { map = JSON.parse(raw) as Record<string, string>; } catch { return scope; }
  return scope.split(/\s+/).filter(Boolean).map((s) => map[s] ?? s).join(" ");
}

export function oauthRoutes(baseUrl: string): Hono {
  const app = new Hono();
  const iss = baseUrl;
  const fhirAud = baseUrl; // SMART: the access-token audience is this resource server

  app.get("/.well-known/jwks.json", async (c) => c.json(await publicJwks()));

  // OIDC discovery (OpenID Connect Core §4 / Discovery 1.0). Public: relying parties resolve
  // the id_token's `iss` to this document to find the JWKS — (g)(10) OpenID Connect tests
  // fetch `<iss>/.well-known/openid-configuration` and verify the id_token against `jwks_uri`.
  app.get("/.well-known/openid-configuration", (c) => c.json({
    issuer: iss,
    authorization_endpoint: `${iss}/oauth/authorize`,
    token_endpoint: `${iss}/oauth/token`,
    jwks_uri: `${iss}/.well-known/jwks.json`,
    response_types_supported: ["code"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
    scopes_supported: ["openid", "fhirUser", "profile", "launch", "launch/patient", "offline_access"],
    grant_types_supported: ["authorization_code", "refresh_token", "client_credentials"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "private_key_jwt"],
    claims_supported: ["sub", "iss", "aud", "exp", "iat", "fhirUser", "profile", "nonce"],
  }));

  // SMART style document (SMART §styling): referenced by `smart_style_url` in EHR-launch
  // token responses so embedded apps can match the EHR's look. Static defaults.
  app.get("/smart-style.json", (c) => c.json({
    color_background: "#ffffff",
    color_error: "#b00020",
    color_highlight: "#0d6efd",
    color_modal_backdrop: "",
    color_success: "#198754",
    color_text: "#212529",
    dim_border_radius: "6px",
    dim_font_size: "14px",
    dim_spacing_size: "8px",
    font_family_body: "system-ui, sans-serif",
    font_family_heading: "system-ui, sans-serif",
  }));

  // --- Authorization endpoint (auto-approve) ---
  app.get("/oauth/authorize", async (c) => {
    const q = c.req.query();

    // UDAP tiered OAuth (RFC 9101 JAR): a signed `request` object, verified against the client's
    // registered key, supersedes the query params — proving the request came from the client.
    let p: Record<string, string | undefined> = q;
    if (q.request) {
      const client0 = q.client_id ? resolveClient(q.client_id) : null;
      const keySet = client0 ? clientKeySet(client0) : null;
      if (!client0 || !keySet) {
        return c.json({ error: "invalid_request", error_description: "signed request requires a registered client with a key" }, 400);
      }
      try {
        // Advertised signing algs only (token_endpoint_auth_signing_alg_values_supported).
        const { payload } = await jwtVerify(q.request, keySet, { audience: iss, algorithms: ["RS256", "ES384"] });
        if (payload.iss && payload.iss !== q.client_id) {
          return c.json({ error: "invalid_request", error_description: "request iss must equal client_id" }, 400);
        }
        const strClaims = Object.fromEntries(Object.entries(payload).filter(([, v]) => typeof v === "string")) as Record<string, string>;
        p = { ...q, ...strClaims, client_id: q.client_id }; // JWT claims win; keep the outer client_id
      } catch {
        return c.json({ error: "invalid_request", error_description: "signed request verification failed" }, 400);
      }
    }

    const clientId = p.client_id, redirectUri = p.redirect_uri, state = p.state;
    const client = clientId ? resolveClient(clientId) : null;
    // Can't safely redirect without a validated client + redirect_uri → 400.
    if (!client || !redirectUri || !redirectAllowed(client, redirectUri)) {
      return c.json({ error: "invalid_request", error_description: "unknown client_id or redirect_uri" }, 400);
    }
    const back = (params: Record<string, string>) => {
      const u = new URL(redirectUri);
      for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
      if (state) u.searchParams.set("state", state);
      return c.redirect(u.toString(), 302);
    };
    if (p.response_type !== "code") return back({ error: "unsupported_response_type" });
    if (p.aud && p.aud !== fhirAud) return back({ error: "invalid_request", error_description: "aud must be the FHIR base URL" });
    // PKCE required for public clients (SMART); only S256 accepted.
    if (client.type !== "confidential") {
      if (!p.code_challenge) return back({ error: "invalid_request", error_description: "code_challenge required (PKCE)" });
      if ((p.code_challenge_method ?? "plain") !== "S256") return back({ error: "invalid_request", error_description: "code_challenge_method must be S256" });
    }
    const scope = applyScopeSubstitutions(normalizeScopesToV2(p.scope ?? ""));
    const { patient, encounter, user } = launchContext(scope);
    const code = await putCode({ clientId: clientId!, redirectUri, scope, codeChallenge: p.code_challenge, codeChallengeMethod: p.code_challenge_method, patient, encounter, user, nonce: p.nonce });
    return back({ code });
  });

  // --- Token endpoint ---
  app.post("/oauth/token", async (c) => {
    const body = new URLSearchParams(await c.req.text());
    const grantType = body.get("grant_type");
    const err = (code: string, desc?: string, status = 400) =>
      c.json({ error: code, ...(desc ? { error_description: desc } : {}) }, status as 400);

    // Verify a private_key_jwt client_assertion (RFC 7523 §3 / SMART asymmetric auth) against the
    // client's registered JWKS: aud = this token endpoint, iss = sub = client_id, one-time jti.
    // Returns the authenticated client_id or null.
    const verifyClientAssertion = async (assertion: string, expectedCid?: string): Promise<string | null> => {
      let peek: Record<string, unknown>;
      try { peek = decodeJwt(assertion); } catch { return null; }
      const cid = (peek.iss ?? peek.sub) as string | undefined;
      if (expectedCid && cid !== expectedCid) return null;
      const client = cid ? resolveClient(cid) : null;
      const keySet = client ? clientKeySet(client) : null;
      if (!client || !keySet) return null;
      try {
        // Advertised signing algs only (token_endpoint_auth_signing_alg_values_supported).
        const { payload } = await jwtVerify(assertion, keySet, { audience: `${baseUrl}/oauth/token`, algorithms: ["RS256", "ES384"] });
        if (payload.iss !== cid || payload.sub !== cid) return null;
        if (!payload.jti || (await jtiReplay(String(payload.jti)))) return null;
        return cid!;
      } catch { return null; }
    };

    // client authentication: confidential-symmetric → client_secret (basic/post);
    // confidential-asymmetric → private_key_jwt client_assertion; public → client_id + PKCE.
    const basic = c.req.header("Authorization")?.startsWith("Basic ")
      ? Buffer.from(c.req.header("Authorization")!.slice(6), "base64").toString().split(":")
      : null;
    let clientId = body.get("client_id") ?? basic?.[0] ?? undefined;
    const clientSecret = body.get("client_secret") ?? basic?.[1] ?? undefined;
    // Asymmetric clients identify via the assertion alone (RFC 7523 — no client_id param):
    // derive the claimed id from the assertion's iss; verification below still has to prove it.
    if (!clientId && body.get("client_assertion")) {
      try { clientId = (decodeJwt(body.get("client_assertion")!).iss as string | undefined) ?? undefined; } catch { /* falls through to unknown client_id */ }
    }
    // client_credentials authenticates via the client_assertion (below), not client_id/secret.
    if (grantType !== "client_credentials") {
      const client = clientId ? resolveClient(clientId) : null;
      if (!client) return err("invalid_client", "unknown client_id", 401);
      if (client.type === "confidential") {
        if (client.secret) {
          if (client.secret !== clientSecret) return err("invalid_client", "bad client_secret", 401);
        } else if (clientKeySet(client)) {
          // Asymmetric confidential client: REQUIRE a verified assertion. (Was: accepted with no
          // authentication at all — a client registered with only a JWKS fell through the secret
          // check, so anyone knowing the client_id could redeem its codes.)
          const assertion = body.get("client_assertion");
          if (body.get("client_assertion_type") !== "urn:ietf:params:oauth:client-assertion-type:jwt-bearer" || !assertion) {
            return err("invalid_client", "asymmetric client requires client_assertion_type=jwt-bearer + client_assertion", 401);
          }
          if (!(await verifyClientAssertion(assertion, clientId))) {
            return err("invalid_client", "client_assertion verification failed", 401);
          }
        } else {
          return err("invalid_client", "confidential client has no registered secret or key", 401);
        }
      }
    }

    const issue = async (grant: { scope: string; patient?: string; encounter?: string; user?: string; nonce?: string }, withRefresh: boolean) => {
      const sub = grant.user ?? (grant.patient ? `Patient/${grant.patient}` : clientId!);
      const access = await signAccessToken({ sub, scope: grant.scope, clientId: clientId!, iss, aud: fhirAud, patient: grant.patient, fhirUser: grant.user });
      const resp: Record<string, unknown> = { access_token: access, token_type: "Bearer", expires_in: 3600, scope: grant.scope };
      if (grant.patient) resp.patient = grant.patient;
      if (grant.encounter) resp.encounter = grant.encounter;
      if (/(^|\s)launch(\s|$)/.test(grant.scope)) {
        // EHR launch context extras ((g)(10) / SMART §launch-context): banner directive +
        // style document for embedded apps. Headless server → no banner needed.
        resp.need_patient_banner = false;
        resp.smart_style_url = `${iss}/smart-style.json`;
      }
      if (/(^|\s)openid(\s|$)/.test(grant.scope)) resp.id_token = await signIdToken({ sub, iss, clientId: clientId!, fhirUser: grant.user, nonce: grant.nonce });
      if (withRefresh && /(^|\s)offline_access(\s|$)/.test(grant.scope)) {
        resp.refresh_token = await putRefresh({ clientId: clientId!, scope: grant.scope, patient: grant.patient, encounter: grant.encounter, user: grant.user });
      }
      return c.json(resp, 200, { "Cache-Control": "no-store", Pragma: "no-cache" });
    };

    if (grantType === "authorization_code") {
      const codeRec = await takeCode(body.get("code") ?? "");
      if (!codeRec) return err("invalid_grant", "code invalid or expired");
      if (codeRec.clientId !== clientId) return err("invalid_grant", "client mismatch");
      if (codeRec.redirectUri !== body.get("redirect_uri")) return err("invalid_grant", "redirect_uri mismatch");
      if (!verifyPkce(body.get("code_verifier") ?? undefined, codeRec.codeChallenge, codeRec.codeChallengeMethod)) {
        return err("invalid_grant", "PKCE verification failed");
      }
      return issue({ scope: codeRec.scope, patient: codeRec.patient, encounter: codeRec.encounter, user: codeRec.user, nonce: codeRec.nonce }, true);
    }

    if (grantType === "refresh_token") {
      const g = await takeRefresh(body.get("refresh_token") ?? "");
      if (!g || g.clientId !== clientId) return err("invalid_grant", "refresh_token invalid or expired");
      const scope = body.get("scope") ?? g.scope; // may narrow, not widen (not enforced here)
      return issue({ scope, patient: g.patient, encounter: g.encounter, user: g.user }, true);
    }

    if (grantType === "client_credentials") {
      // SMART Backend Services: authenticate with a private_key_jwt client assertion, issue a
      // system-scoped access token (no patient context, no refresh, no id_token).
      const assertion = body.get("client_assertion");
      if (body.get("client_assertion_type") !== "urn:ietf:params:oauth:client-assertion-type:jwt-bearer" || !assertion) {
        return err("invalid_client", "backend services requires client_assertion_type=jwt-bearer + client_assertion", 401);
      }
      const cid = await verifyClientAssertion(assertion);
      if (!cid) return err("invalid_client", "client_assertion verification failed", 401);
      const scope = body.get("scope") ?? "";
      const access = await signAccessToken({ sub: cid!, scope, clientId: cid!, iss, aud: fhirAud, ttlSeconds: 300 });
      return c.json({ access_token: access, token_type: "Bearer", expires_in: 300, scope }, 200, { "Cache-Control": "no-store", Pragma: "no-cache" });
    }

    return err("unsupported_grant_type", `unsupported grant_type: ${grantType}`);
  });

  // --- Token introspection (RFC 7662; SMART App Launch STU2 §token-introspection) ---
  // Standard form body (`token` + optional `token_type_hint`). Active = the token was issued by
  // this server (signature verifies against our JWKS) and is unexpired; anything else →
  // {active:false} with no detail (RFC 7662 §2.2 — don't leak why). Refresh tokens are opaque
  // handles, not JWTs, so they introspect as inactive by design.
  app.post("/oauth/introspect", async (c) => {
    const body = new URLSearchParams(await c.req.text());
    const token = body.get("token");
    if (!token) return c.json({ error: "invalid_request", error_description: "token required" }, 400);
    try {
      const keySet = createLocalJWKSet((await publicJwks()) as Parameters<typeof createLocalJWKSet>[0]);
      const { payload } = await jwtVerify(token, keySet, { issuer: iss });
      const p = payload as Record<string, unknown>;
      return c.json({
        active: true,
        scope: p.scope ?? "",
        client_id: p.client_id,
        token_type: "Bearer",
        exp: payload.exp, iat: payload.iat, iss: payload.iss, sub: payload.sub, aud: payload.aud,
        ...(p.patient ? { patient: p.patient } : {}),
        ...(p.fhirUser ? { fhirUser: p.fhirUser } : {}),
      });
    } catch {
      return c.json({ active: false });
    }
  });

  return app;
}
