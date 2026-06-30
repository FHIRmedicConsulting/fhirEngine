/**
 * SMART App Launch discovery + auth-gate surface (Inferno (g)(10) "SMART discovery" slice).
 * No sidecar needed — /metadata + /.well-known/smart-configuration use a stub warehouse.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDeltaApp } from "../../../src/app.js";

const stubWh = { hasTable: () => false, query: async () => [] } as never;
const mk = () => createDeltaApp({ warehouse: stubWh, baseUrl: "http://ronin.test" });
const json = async (p: string, init?: RequestInit) => mk().fetch(new Request(`http://ronin.test${p}`, init));

describe("SMART discovery document (/.well-known/smart-configuration)", () => {
  beforeEach(() => { delete process.env.RONIN_AUTH_ENABLED; delete process.env.RONIN_SMART_AUTHORIZE_URL; });
  afterEach(() => { delete process.env.RONIN_SMART_AUTHORIZE_URL; });

  it("advertises the required SMART discovery fields", async () => {
    const d = await (await json("/.well-known/smart-configuration")).json();
    expect(d.authorization_endpoint).toBe("http://ronin.test/oauth/authorize");
    expect(d.token_endpoint).toBe("http://ronin.test/oauth/token");
    expect(Array.isArray(d.capabilities)).toBe(true);
    expect(d.capabilities).toEqual(expect.arrayContaining(["launch-standalone", "client-public", "sso-openid-connect"]));
    expect(d.code_challenge_methods_supported).toContain("S256"); // PKCE S256 required by g10
    expect(d.grant_types_supported).toEqual(expect.arrayContaining(["authorization_code"]));
    expect(Array.isArray(d.scopes_supported)).toBe(true);
  });

  it("honors configurable authorization/token endpoints (external IdP)", async () => {
    process.env.RONIN_SMART_AUTHORIZE_URL = "https://idp.example/authorize";
    const d = await (await json("/.well-known/smart-configuration")).json();
    expect(d.authorization_endpoint).toBe("https://idp.example/authorize");
  });
});

describe("CapabilityStatement SMART security block (/metadata)", () => {
  it("declares the SMART-on-FHIR service + oauth-uris extension", async () => {
    const meta = await (await json("/metadata")).json();
    const sec = meta.rest[0].security;
    expect(sec.service[0].coding[0].code).toBe("SMART-on-FHIR");
    const uris = sec.extension.find((e: { url: string }) => e.url.endsWith("oauth-uris")).extension;
    expect(uris.find((e: { url: string }) => e.url === "authorize").valueUri).toBe("http://ronin.test/oauth/authorize");
    expect(uris.find((e: { url: string }) => e.url === "token").valueUri).toBe("http://ronin.test/oauth/token");
  });
});

describe("auth gate (Inferno auth-required slice)", () => {
  beforeEach(() => { process.env.RONIN_AUTH_ENABLED = "true"; process.env.RONIN_AUTH_STRATEGY = "stub"; });
  afterEach(() => { delete process.env.RONIN_AUTH_ENABLED; });

  it("rejects an unauthenticated protected request with 401 + WWW-Authenticate", async () => {
    const r = await json("/Patient/123");
    expect(r.status).toBe(401);
    expect(r.headers.get("WWW-Authenticate")).toMatch(/^Bearer/);
    expect((await r.json()).resourceType).toBe("OperationOutcome");
  });

  it("leaves discovery + metadata + health public even with auth on", async () => {
    expect((await json("/.well-known/smart-configuration")).status).toBe(200);
    expect((await json("/metadata")).status).toBe(200);
    expect((await json("/health")).status).toBe(200);
  });
});
