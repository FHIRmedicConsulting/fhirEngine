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
import { jwtVerify, decodeJwt } from "jose";
import { publicJwks } from "./keys.js";
import { putCode, takeCode, putRefresh, takeRefresh, jtiReplay } from "./store.js";
import { signAccessToken, signIdToken, verifyPkce } from "./tokens.js";
import { resolveClient, redirectAllowed, clientKeySet } from "./clients.js";

export const oauthEnabled = (): boolean => process.env.FHIRENGINE_OAUTH_ENABLED === "true";

/** Patient/user launch context for the auto-approve flow (dev/test — configured, not picked). */
function launchContext(scope: string): { patient?: string; user?: string } {
  const wantsPatient = /(^|\s)(launch\/patient|patient\/)/.test(scope);
  const patient = wantsPatient ? process.env.FHIRENGINE_OAUTH_DEFAULT_PATIENT : undefined;
  const user = process.env.FHIRENGINE_OAUTH_DEFAULT_USER ?? (patient ? `Patient/${patient}` : undefined);
  return { patient, user };
}

export function oauthRoutes(baseUrl: string): Hono {
  const app = new Hono();
  const iss = baseUrl;
  const fhirAud = baseUrl; // SMART: the access-token audience is this resource server

  app.get("/.well-known/jwks.json", async (c) => c.json(await publicJwks()));

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
    const scope = p.scope ?? "";
    const { patient, user } = launchContext(scope);
    const code = putCode({ clientId: clientId!, redirectUri, scope, codeChallenge: p.code_challenge, codeChallengeMethod: p.code_challenge_method, patient, user, nonce: p.nonce });
    return back({ code });
  });

  // --- Token endpoint ---
  app.post("/oauth/token", async (c) => {
    const body = new URLSearchParams(await c.req.text());
    const grantType = body.get("grant_type");
    const err = (code: string, desc?: string, status = 400) =>
      c.json({ error: code, ...(desc ? { error_description: desc } : {}) }, status as 400);

    // client authentication: confidential → client_secret (basic/post); public → client_id + PKCE.
    const basic = c.req.header("Authorization")?.startsWith("Basic ")
      ? Buffer.from(c.req.header("Authorization")!.slice(6), "base64").toString().split(":")
      : null;
    const clientId = body.get("client_id") ?? basic?.[0] ?? undefined;
    const clientSecret = body.get("client_secret") ?? basic?.[1] ?? undefined;
    // client_credentials authenticates via the client_assertion (below), not client_id/secret.
    if (grantType !== "client_credentials") {
      const client = clientId ? resolveClient(clientId) : null;
      if (!client) return err("invalid_client", "unknown client_id", 401);
      if (client.type === "confidential" && client.secret && client.secret !== clientSecret) {
        return err("invalid_client", "bad client_secret", 401);
      }
    }

    const issue = async (grant: { scope: string; patient?: string; user?: string; nonce?: string }, withRefresh: boolean) => {
      const sub = grant.user ?? (grant.patient ? `Patient/${grant.patient}` : clientId!);
      const access = await signAccessToken({ sub, scope: grant.scope, clientId: clientId!, iss, aud: fhirAud, patient: grant.patient, fhirUser: grant.user });
      const resp: Record<string, unknown> = { access_token: access, token_type: "Bearer", expires_in: 3600, scope: grant.scope };
      if (grant.patient) resp.patient = grant.patient;
      if (/(^|\s)openid(\s|$)/.test(grant.scope)) resp.id_token = await signIdToken({ sub, iss, clientId: clientId!, fhirUser: grant.user, nonce: grant.nonce });
      if (withRefresh && /(^|\s)offline_access(\s|$)/.test(grant.scope)) {
        resp.refresh_token = putRefresh({ clientId: clientId!, scope: grant.scope, patient: grant.patient, user: grant.user });
      }
      return c.json(resp, 200, { "Cache-Control": "no-store", Pragma: "no-cache" });
    };

    if (grantType === "authorization_code") {
      const codeRec = takeCode(body.get("code") ?? "");
      if (!codeRec) return err("invalid_grant", "code invalid or expired");
      if (codeRec.clientId !== clientId) return err("invalid_grant", "client mismatch");
      if (codeRec.redirectUri !== body.get("redirect_uri")) return err("invalid_grant", "redirect_uri mismatch");
      if (!verifyPkce(body.get("code_verifier") ?? undefined, codeRec.codeChallenge, codeRec.codeChallengeMethod)) {
        return err("invalid_grant", "PKCE verification failed");
      }
      return issue({ scope: codeRec.scope, patient: codeRec.patient, user: codeRec.user, nonce: codeRec.nonce }, true);
    }

    if (grantType === "refresh_token") {
      const g = takeRefresh(body.get("refresh_token") ?? "");
      if (!g || g.clientId !== clientId) return err("invalid_grant", "refresh_token invalid or expired");
      const scope = body.get("scope") ?? g.scope; // may narrow, not widen (not enforced here)
      return issue({ scope, patient: g.patient, user: g.user }, true);
    }

    if (grantType === "client_credentials") {
      // SMART Backend Services: authenticate with a private_key_jwt client assertion, issue a
      // system-scoped access token (no patient context, no refresh, no id_token).
      const assertion = body.get("client_assertion");
      if (body.get("client_assertion_type") !== "urn:ietf:params:oauth:client-assertion-type:jwt-bearer" || !assertion) {
        return err("invalid_client", "backend services requires client_assertion_type=jwt-bearer + client_assertion", 401);
      }
      let peek: Record<string, unknown>;
      try { peek = decodeJwt(assertion); } catch { return err("invalid_client", "malformed client_assertion", 401); }
      const cid = (peek.iss ?? peek.sub) as string | undefined;         // client_id == assertion iss == sub
      const bsClient = cid ? resolveClient(cid) : null;
      const keySet = bsClient ? clientKeySet(bsClient) : null;
      if (!bsClient || !keySet) return err("invalid_client", "unknown client or no registered key", 401);
      try {
        // Advertised signing algs only (token_endpoint_auth_signing_alg_values_supported).
        const { payload } = await jwtVerify(assertion, keySet, { audience: `${baseUrl}/oauth/token`, algorithms: ["RS256", "ES384"] });
        if (payload.iss !== cid || payload.sub !== cid) return err("invalid_client", "assertion iss/sub must equal client_id", 401);
        if (!payload.jti || jtiReplay(String(payload.jti))) return err("invalid_client", "missing or replayed jti", 401);
      } catch { return err("invalid_client", "client_assertion verification failed", 401); }
      const scope = body.get("scope") ?? "";
      const access = await signAccessToken({ sub: cid!, scope, clientId: cid!, iss, aud: fhirAud, ttlSeconds: 300 });
      return c.json({ access_token: access, token_type: "Bearer", expires_in: 300, scope }, 200, { "Cache-Control": "no-store", Pragma: "no-cache" });
    }

    return err("unsupported_grant_type", `unsupported grant_type: ${grantType}`);
  });

  return app;
}
