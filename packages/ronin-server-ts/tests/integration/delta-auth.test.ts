/**
 * Auth gate (ADR-0030, control #1) — heritage SMART chain wired into the delta app, with
 * the stub strategy (test tokens) and the new JWKS strategy (real signed JWT). Verifies
 * 401 (no/invalid token), 403 (insufficient scope), allow, and public-route bypass.
 * Gated on the sidecar (runs in the sequential delta suite → env is isolated).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generateKeyPair, exportSPKI, SignJWT } from "jose";
import { DeltaWarehouse } from "../../src/lib/delta-warehouse.js";
import { createDeltaApp } from "../../src/app.js";

const SIDECAR = process.env.RONIN_DELTA_SIDECAR_URL;
const BASE = process.env.RONIN_DELTA_BASE ?? "./.delta-test";
const mkApp = () => createDeltaApp({ warehouse: new DeltaWarehouse({ sidecarUrl: SIDECAR!, base: `${BASE}-auth` }), baseUrl: "http://test" });
const get = (app: any, p: string, token?: string) =>
  app.fetch(new Request(`http://test${p}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} }));

describe.skipIf(!SIDECAR)("auth gate — stub strategy", () => {
  let app: ReturnType<typeof createDeltaApp>;
  beforeAll(() => { process.env.RONIN_AUTH_ENABLED = "true"; process.env.RONIN_AUTH_STRATEGY = "stub"; app = mkApp(); });
  afterAll(() => { delete process.env.RONIN_AUTH_ENABLED; delete process.env.RONIN_AUTH_STRATEGY; });

  it("401 without a token", async () => { expect((await get(app, "/Patient")).status).toBe(401); });
  it("401 for an invalid token", async () => { expect((await get(app, "/Patient", "stub-invalid")).status).toBe(401); });
  it("allows a sufficiently-scoped token (system/*.cruds → search)", async () => {
    expect((await get(app, "/Patient", "stub-system-all")).status).toBe(200);
  });
  it("403 for insufficient scope (user/*.rs cannot create)", async () => {
    const r = await app.fetch(new Request("http://test/Patient", { method: "POST", headers: { Authorization: "Bearer stub-user-rs", "Content-Type": "application/fhir+json" }, body: JSON.stringify({ resourceType: "Patient" }) }));
    expect(r.status).toBe(403);
  });
  it("public routes bypass auth (no token)", async () => {
    expect((await get(app, "/health")).status).toBe(200);
    expect((await get(app, "/metadata")).status).toBe(200);
  });
});

describe.skipIf(!SIDECAR)("auth gate — JWKS strategy (real signed JWT)", () => {
  let app: ReturnType<typeof createDeltaApp>;
  let priv: any;
  beforeAll(async () => {
    const { publicKey, privateKey } = await generateKeyPair("ES256");
    priv = privateKey;
    process.env.RONIN_JWT_PUBLIC_KEY = await exportSPKI(publicKey);
    process.env.RONIN_JWT_ALG = "ES256";
    process.env.RONIN_AUTH_ENABLED = "true";
    process.env.RONIN_AUTH_STRATEGY = "jwks";
    app = mkApp();
  });
  afterAll(() => { for (const k of ["RONIN_JWT_PUBLIC_KEY", "RONIN_JWT_ALG", "RONIN_AUTH_ENABLED", "RONIN_AUTH_STRATEGY"]) delete process.env[k]; });

  const sign = (scope: string) => new SignJWT({ scope, sub: "test-user" }).setProtectedHeader({ alg: "ES256" }).setIssuedAt().setExpirationTime("1h").sign(priv);

  it("allows a validly-signed token with sufficient scope", async () => {
    expect((await get(app, "/Patient", await sign("system/*.cruds"))).status).toBe(200);
  });
  it("401 for a garbage/forged token", async () => {
    expect((await get(app, "/Patient", "not.a.jwt")).status).toBe(401);
  });
  it("403 for a valid token lacking the scope", async () => {
    expect((await app.fetch(new Request("http://test/Patient", { method: "POST", headers: { Authorization: `Bearer ${await sign("user/Observation.rs")}`, "Content-Type": "application/fhir+json" }, body: "{}" }))).status).toBe(403);
  });
});
