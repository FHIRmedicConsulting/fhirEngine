import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import { generateKeyPair, exportJWK, exportPKCS8, SignJWT, decodeJwt } from "jose";
import { OidcAuthStrategy, type OidcAuthOptions } from "../../src/auth/idp/oidc-auth.js";

const DISCOVERY_URL = "https://idp.example/.well-known/openid-configuration";
const INTROSPECT_URL = "https://idp.example/oauth/introspect";

const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function strategy(over: Partial<OidcAuthOptions> = {}): OidcAuthStrategy {
  return new OidcAuthStrategy({
    discoveryUrl: DISCOVERY_URL, clientId: "fhir-engine", clientSecret: "s3cret", jwksCacheTtl: 86400, ...over,
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("OidcAuthStrategy", () => {
  it("introspects via RFC 7662 with Basic client auth and returns the IdP verdict", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ issuer: "https://idp.example", introspection_endpoint: INTROSPECT_URL }))
      .mockResolvedValueOnce(jsonResponse({ active: true, sub: "user-1", scope: "system/*.read", client_id: "app" }));

    const r = await strategy().introspect("the-token");
    expect(r).toEqual({ active: true, sub: "user-1", scope: "system/*.read", client_id: "app" });

    const [url, init] = fetchMock.mock.calls[1]!;
    expect(url).toBe(INTROSPECT_URL);
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const expectedBasic = Buffer.from("fhir-engine:s3cret", "utf-8").toString("base64");
    expect(init.headers.Authorization).toBe(`Basic ${expectedBasic}`);
    const body = new URLSearchParams(init.body as string);
    expect(body.get("token")).toBe("the-token");
    expect(body.get("token_type_hint")).toBe("access_token");
    expect(body.get("client_id")).toBeNull(); // secret clients authenticate via the header, not the body
  });

  it("without a client secret, sends client_id in the body and no Authorization header", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ introspection_endpoint: INTROSPECT_URL }))
      .mockResolvedValueOnce(jsonResponse({ active: true }));

    await strategy({ clientSecret: null }).introspect("tok");
    const [, init] = fetchMock.mock.calls[1]!;
    expect(init.headers.Authorization).toBeUndefined();
    expect(new URLSearchParams(init.body as string).get("client_id")).toBe("fhir-engine");
  });

  it("attempts JWKS validation (not an introspection POST) when only jwks_uri is advertised", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ issuer: "https://idp.example", jwks_uri: "https://idp.example/jwks" }));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ keys: [] }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const r = await strategy().introspect("tok"); // garbage token → inactive via JWT path
    expect(r.active).toBe(false);
    expect(r.reason).toMatch(/JWT verification failed/);
    expect(fetchMock.mock.calls.every(([u]) => String(u) !== INTROSPECT_URL)).toBe(true);
  });

  it("fails closed when the introspection endpoint returns a non-2xx", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ introspection_endpoint: INTROSPECT_URL }))
      .mockResolvedValueOnce(jsonResponse({}, 503));
    const r = await strategy().introspect("tok");
    expect(r.active).toBe(false);
    expect(r.reason).toContain("HTTP 503");
  });

  it("fails closed when the introspection request itself fails (network error)", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ introspection_endpoint: INTROSPECT_URL }))
      .mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const r = await strategy().introspect("tok");
    expect(r.active).toBe(false);
    expect(r.reason).toMatch(/Introspection request failed: ECONNREFUSED/);
  });

  it("propagates a discovery fetch failure (strategy cannot guess the endpoints)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 500));
    await expect(strategy().introspect("tok")).rejects.toThrow(/OIDC discovery fetch failed/);
  });

  it("private_key_jwt: signs a client_assertion when no secret is configured", async () => {
    const keys = await generateKeyPair("RS256", { extractable: true });
    const pem = await exportPKCS8(keys.privateKey);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ issuer: "https://idp.example", introspection_endpoint: INTROSPECT_URL }))
      .mockResolvedValueOnce(jsonResponse({ active: true }));

    await strategy({ clientSecret: null, privateKey: pem }).introspect("tok");
    const [, init] = fetchMock.mock.calls[1]!;
    expect(init.headers.Authorization).toBeUndefined();
    const body = new URLSearchParams(init.body as string);
    expect(body.get("client_assertion_type")).toBe("urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
    const claims = decodeJwt(body.get("client_assertion")!);
    expect(claims.iss).toBe("fhir-engine");
    expect(claims.sub).toBe("fhir-engine");
    expect(claims.aud).toBe("https://idp.example"); // issuer preferred as the AS audience
    expect(claims.jti).toBeDefined();
  });

  describe("JWKS fallback (IdP without introspection)", () => {
    let keys: Awaited<ReturnType<typeof generateKeyPair>>;
    let jwks: { keys: object[] };
    beforeAll(async () => {
      keys = await generateKeyPair("RS256", { extractable: true });
      jwks = { keys: [{ ...(await exportJWK(keys.publicKey)), alg: "RS256", use: "sig" }] };
    });
    const JWKS_URI = "https://idp.example/jwks";
    const discoveryDoc = { issuer: "https://idp.example", jwks_uri: JWKS_URI };
    const wireJwks = () =>
      fetchMock.mockImplementation(async (url: string | URL) =>
        String(url) === DISCOVERY_URL
          ? jsonResponse(discoveryDoc)
          : new Response(JSON.stringify(jwks), { status: 200, headers: { "Content-Type": "application/json" } }));

    const sign = (claims: Record<string, unknown>, iss = "https://idp.example") =>
      new SignJWT(claims).setProtectedHeader({ alg: "RS256" }).setIssuer(iss).setIssuedAt()
        .setExpirationTime("5m").sign(keys.privateKey);

    it("verifies the bearer's own signature against the discovered JWKS and maps claims", async () => {
      wireJwks();
      const token = await sign({ sub: "user-1", scope: "system/*.read", client_id: "app-1", patient: "p1" });
      const r = await strategy().introspect(token);
      expect(r.active).toBe(true);
      expect(r.sub).toBe("user-1");
      expect(r.scope).toBe("system/*.read");
      expect(r.client_id).toBe("app-1");
      expect(r.patient).toBe("p1");
    });

    it("pins the discovered issuer — a foreign-issuer token is inactive", async () => {
      wireJwks();
      const r = await strategy().introspect(await sign({ sub: "u" }, "https://evil.example"));
      expect(r.active).toBe(false);
      expect(r.reason).toMatch(/JWT verification failed/);
    });

    it("rejects garbage tokens without throwing", async () => {
      wireJwks();
      expect((await strategy().introspect("not-a-jwt")).active).toBe(false);
    });

    it("fails closed when the IdP advertises neither introspection nor jwks_uri", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ issuer: "https://idp.example" }));
      const r = await strategy().introspect("tok");
      expect(r.active).toBe(false);
      expect(r.reason).toMatch(/neither introspection_endpoint nor jwks_uri/);
    });
  });

  it("caches the discovery document across introspections", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ introspection_endpoint: INTROSPECT_URL }))
      .mockResolvedValueOnce(jsonResponse({ active: true }))
      .mockResolvedValueOnce(jsonResponse({ active: false }));

    const s = strategy();
    await s.introspect("tok-1");
    await s.introspect("tok-2");
    const discoveryCalls = fetchMock.mock.calls.filter(([u]) => u === DISCOVERY_URL);
    expect(discoveryCalls).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(3); // 1 discovery + 2 introspections
  });
});
