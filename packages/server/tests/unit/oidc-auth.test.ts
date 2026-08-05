import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

  it("fails closed when the IdP does not advertise an introspection_endpoint", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ issuer: "https://idp.example", jwks_uri: "https://idp.example/jwks" }));
    const r = await strategy().introspect("tok");
    expect(r.active).toBe(false);
    expect(r.reason).toContain(DISCOVERY_URL);
    expect(fetchMock).toHaveBeenCalledTimes(1); // never attempted an introspection POST
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
