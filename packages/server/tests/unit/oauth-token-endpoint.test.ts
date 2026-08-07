import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { Hono } from "hono";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { oauthRoutes } from "../../src/auth/oauth/oauth-routes.js";
import { putCode, clearOAuthStore } from "../../src/auth/oauth/store.js";

const BASE = "https://fhir.example";
let app: Hono;
let goodKeys: Awaited<ReturnType<typeof generateKeyPair>>;
let evilKeys: Awaited<ReturnType<typeof generateKeyPair>>;
let savedClients: string | undefined;

beforeAll(async () => {
  goodKeys = await generateKeyPair("RS256", { extractable: true });
  evilKeys = await generateKeyPair("RS256", { extractable: true });
  const jwk = { ...(await exportJWK(goodKeys.publicKey)), alg: "RS256", use: "sig" };
  savedClients = process.env.FHIRENGINE_OAUTH_CLIENTS;
  process.env.FHIRENGINE_OAUTH_CLIENTS = JSON.stringify([
    { clientId: "asym-app", type: "confidential", jwks: { keys: [jwk] } },
    { clientId: "secretless-app", type: "confidential" },
    { clientId: "symmetric-app", type: "confidential", secret: "s3cret" },
  ]);
  app = new Hono();
  app.route("/", oauthRoutes(BASE));
});
afterAll(() => {
  if (savedClients === undefined) delete process.env.FHIRENGINE_OAUTH_CLIENTS;
  else process.env.FHIRENGINE_OAUTH_CLIENTS = savedClients;
});
beforeEach(() => clearOAuthStore());

function assertion(clientId: string, key: CryptoKey, over: Record<string, unknown> = {}): Promise<string> {
  return new SignJWT({ jti: `jti-${Math.random()}`, ...over })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer((over.iss as string) ?? clientId)
    .setSubject((over.sub as string) ?? clientId)
    .setAudience(`${BASE}/oauth/token`)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(key);
}

function tokenReq(params: Record<string, string>): Promise<Response> {
  return app.request("/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
}

function mintCode(clientId: string): Promise<string> {
  return putCode({ clientId, redirectUri: "https://app.example/cb", scope: "patient/*.read", patient: "pat-1" });
}

describe("asymmetric confidential client on the authorization_code grant", () => {
  it("REJECTS a code exchange with no client_assertion (the fixed fall-open)", async () => {
    const res = await tokenReq({
      grant_type: "authorization_code", code: await mintCode("asym-app"),
      redirect_uri: "https://app.example/cb", client_id: "asym-app",
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("invalid_client");
  });

  it("accepts a code exchange with a valid private_key_jwt assertion", async () => {
    const res = await tokenReq({
      grant_type: "authorization_code", code: await mintCode("asym-app"),
      redirect_uri: "https://app.example/cb", client_id: "asym-app",
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: await assertion("asym-app", goodKeys.privateKey as CryptoKey),
    });
    expect(res.status).toBe(200);
    const tok = await res.json();
    expect(tok.access_token).toBeDefined();
    expect(tok.patient).toBe("pat-1");
  });

  it("rejects an assertion signed by the wrong key", async () => {
    const res = await tokenReq({
      grant_type: "authorization_code", code: await mintCode("asym-app"),
      redirect_uri: "https://app.example/cb", client_id: "asym-app",
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: await assertion("asym-app", evilKeys.privateKey as CryptoKey),
    });
    expect(res.status).toBe(401);
  });

  it("rejects a replayed jti", async () => {
    const a = await assertion("asym-app", goodKeys.privateKey as CryptoKey, { jti: "fixed-jti" });
    const params = (code: string) => ({
      grant_type: "authorization_code", code, redirect_uri: "https://app.example/cb", client_id: "asym-app",
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer", client_assertion: a,
    });
    expect((await tokenReq(params(await mintCode("asym-app")))).status).toBe(200);
    expect((await tokenReq(params(await mintCode("asym-app")))).status).toBe(401); // same jti again
  });

  it("rejects an assertion whose iss/sub is a different client", async () => {
    const res = await tokenReq({
      grant_type: "authorization_code", code: await mintCode("asym-app"),
      redirect_uri: "https://app.example/cb", client_id: "asym-app",
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: await assertion("symmetric-app", goodKeys.privateKey as CryptoKey),
    });
    expect(res.status).toBe(401);
  });
});

describe("confidential client with no secret and no key", () => {
  it("can never authenticate (fail closed)", async () => {
    const res = await tokenReq({
      grant_type: "authorization_code", code: await mintCode("secretless-app"),
      redirect_uri: "https://app.example/cb", client_id: "secretless-app",
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error_description).toMatch(/no registered secret or key/);
  });
});

describe("token introspection (RFC 7662)", () => {
  async function mintAccessToken(): Promise<{ access: string; scope: string }> {
    const res = await tokenReq({
      grant_type: "authorization_code", code: await mintCode("symmetric-app"),
      redirect_uri: "https://app.example/cb", client_id: "symmetric-app", client_secret: "s3cret",
    });
    const tok = await res.json();
    return { access: tok.access_token, scope: tok.scope };
  }

  function introspect(params: Record<string, string>): Promise<Response> {
    return app.request("/oauth/introspect", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    });
  }

  it("an issued access token introspects active with its claims", async () => {
    const { access } = await mintAccessToken();
    const res = await introspect({ token: access, token_type_hint: "access_token" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.active).toBe(true);
    expect(body.scope).toBe("patient/*.read");
    expect(body.client_id).toBe("symmetric-app");
    expect(body.patient).toBe("pat-1");
    expect(typeof body.exp).toBe("number");
    expect(body.iss).toBe(BASE);
  });

  it("garbage and foreign tokens introspect inactive with no detail", async () => {
    for (const bad of ["not-a-jwt", "eyJhbGciOiJub25lIn0.e30."]) {
      const res = await introspect({ token: bad });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ active: false });
    }
  });

  it("a missing token parameter is a 400", async () => {
    expect((await introspect({})).status).toBe(400);
  });
});
