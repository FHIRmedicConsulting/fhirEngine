/**
 * Security infrastructure unit tests (ADR-0031/0032/0033):
 * hardened TLS config, fail-closed production profile, and the HTTP-tier hardening
 * (security headers, enforced CORS, body limit, rate limiting).
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { buildTlsConfig, NIST_TLS12_CIPHERS } from "../../src/security/tls.js";
import { evaluateSecurityPosture, securityProfile } from "../../src/security/profile.js";
import { rateLimit, MemoryRateLimitStore, type RateLimitStore } from "../../src/security/rate-limit.js";
import { mountHttpHardening } from "../../src/security/http-hardening.js";

// --- env isolation ------------------------------------------------------------
const SECURITY_ENV = [
  "RONIN_SECURITY_PROFILE", "RONIN_AUTH_ENABLED", "RONIN_AUDIT_ENABLED", "RONIN_CONSENT_ENFORCEMENT",
  "RONIN_OAUTH_ENABLED", "RONIN_OAUTH_PRIVATE_KEY", "RONIN_OAUTH_PUBLIC_KEY", "RONIN_TLS_CERT",
  "RONIN_TLS_KEY", "RONIN_TLS_CIPHERS", "RONIN_TLS_TERMINATED_AT_PROXY", "RONIN_CORS_ORIGINS",
  "RONIN_RATE_LIMIT_ENABLED", "RONIN_RATE_LIMIT_RPM", "RONIN_MAX_BODY_BYTES",
];
let saved: Record<string, string | undefined>;
beforeEach(() => { saved = {}; for (const k of SECURITY_ENV) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => { for (const k of SECURITY_ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

// --- TLS ----------------------------------------------------------------------
describe("buildTlsConfig", () => {
  it("is disabled with no cert/key (TLS belongs to a proxy)", () => {
    expect(buildTlsConfig().enabled).toBe(false);
  });

  it("builds hardened options (TLS 1.2 min, NIST AEAD ciphers, honored order) when cert/key set", () => {
    const dir = mkdtempSync(join(tmpdir(), "ronin-tls-"));
    const cert = join(dir, "c.pem"), key = join(dir, "k.pem");
    writeFileSync(cert, "dummy-cert"); writeFileSync(key, "dummy-key");
    process.env.RONIN_TLS_CERT = cert; process.env.RONIN_TLS_KEY = key;
    const cfg = buildTlsConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.serverOptions!.minVersion).toBe("TLSv1.2");
    expect(cfg.serverOptions!.maxVersion).toBe("TLSv1.3");
    expect(cfg.serverOptions!.honorCipherOrder).toBe(true);
    expect(cfg.serverOptions!.ciphers).toBe(NIST_TLS12_CIPHERS);
    expect(cfg.serverOptions!.ciphers).not.toMatch(/CHACHA20/i); // FIPS: ChaCha20 excluded
  });

  it("honors a RONIN_TLS_CIPHERS override", () => {
    const dir = mkdtempSync(join(tmpdir(), "ronin-tls-"));
    const cert = join(dir, "c.pem"), key = join(dir, "k.pem");
    writeFileSync(cert, "x"); writeFileSync(key, "y");
    process.env.RONIN_TLS_CERT = cert; process.env.RONIN_TLS_KEY = key;
    process.env.RONIN_TLS_CIPHERS = "ECDHE-RSA-AES256-GCM-SHA384";
    expect(buildTlsConfig().serverOptions!.ciphers).toBe("ECDHE-RSA-AES256-GCM-SHA384");
  });
});

// --- Security profile / fail-closed ------------------------------------------
describe("security profile", () => {
  it("defaults to dev; production only when explicitly set", () => {
    expect(securityProfile()).toBe("dev");
    process.env.RONIN_SECURITY_PROFILE = "production";
    expect(securityProfile()).toBe("production");
  });

  it("dev profile never blocks — unmet controls are warnings only", () => {
    const r = evaluateSecurityPosture({ tlsInProcess: false });
    expect(r.profile).toBe("dev");
    expect(r.ok).toBe(true);
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.errors).toEqual([]);
  });

  it("production FAILS CLOSED when auth/audit/TLS are missing", () => {
    process.env.RONIN_SECURITY_PROFILE = "production";
    const r = evaluateSecurityPosture({ tlsInProcess: false });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/authentication is disabled/);
    expect(r.errors.join(" ")).toMatch(/audit logging is disabled/);
    expect(r.errors.join(" ")).toMatch(/no transport security/);
  });

  it("production PASSES when auth+audit on and TLS present (or proxy-terminated)", () => {
    process.env.RONIN_SECURITY_PROFILE = "production";
    process.env.RONIN_AUTH_ENABLED = "true";
    process.env.RONIN_AUDIT_ENABLED = "true";
    // TLS terminated at a proxy satisfies transport security without in-process certs.
    process.env.RONIN_TLS_TERMINATED_AT_PROXY = "true";
    const r = evaluateSecurityPosture({ tlsInProcess: false });
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it("production rejects EPHEMERAL OAuth signing keys", () => {
    process.env.RONIN_SECURITY_PROFILE = "production";
    process.env.RONIN_AUTH_ENABLED = "true";
    process.env.RONIN_AUDIT_ENABLED = "true";
    process.env.RONIN_TLS_TERMINATED_AT_PROXY = "true";
    process.env.RONIN_OAUTH_ENABLED = "true"; // enabled but no static keys → ephemeral
    const r = evaluateSecurityPosture({ tlsInProcess: false });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/EPHEMERAL signing keys/);
  });

  it("consent stays advisory even in production (deployment-dependent)", () => {
    process.env.RONIN_SECURITY_PROFILE = "production";
    process.env.RONIN_AUTH_ENABLED = "true";
    process.env.RONIN_AUDIT_ENABLED = "true";
    process.env.RONIN_TLS_TERMINATED_AT_PROXY = "true";
    const r = evaluateSecurityPosture({ tlsInProcess: false });
    expect(r.ok).toBe(true); // consent off does not block
    expect(r.warnings.join(" ")).toMatch(/consent enforcement is off/);
  });
});

// --- Rate limiter -------------------------------------------------------------
describe("rateLimit", () => {
  const mkApp = (limit: number, now: () => number) => {
    const app = new Hono();
    app.use("*", rateLimit({ limit, windowMs: 60_000, now }));
    app.get("/x", (c) => c.text("ok"));
    return app;
  };
  const get = (app: Hono, ip = "1.2.3.4") => app.request("/x", { headers: { "x-forwarded-for": ip } });

  it("allows up to the limit then returns 429 with Retry-After", async () => {
    let t = 1_000_000;
    const app = mkApp(2, () => t);
    expect((await get(app)).status).toBe(200);
    expect((await get(app)).status).toBe(200);
    const blocked = await get(app);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBeTruthy();
    expect(blocked.headers.get("RateLimit-Remaining")).toBe("0");
  });

  it("resets after the window elapses", async () => {
    let t = 0;
    const app = mkApp(1, () => t);
    expect((await get(app)).status).toBe(200);
    expect((await get(app)).status).toBe(429);
    t += 61_000; // next window
    expect((await get(app)).status).toBe(200);
  });

  it("isolates counters per client key (IP)", async () => {
    let t = 5;
    const app = mkApp(1, () => t);
    expect((await get(app, "10.0.0.1")).status).toBe(200);
    expect((await get(app, "10.0.0.1")).status).toBe(429);
    expect((await get(app, "10.0.0.2")).status).toBe(200); // different IP unaffected
  });

  it("MemoryRateLimitStore sweeps expired windows", () => {
    const s = new MemoryRateLimitStore();
    s.hit("k", 1000, 0);
    expect(s.size).toBe(1);
    s.sweep(2000); // past resetAt
    expect(s.size).toBe(0);
  });

  it("accepts a pluggable (async, shared-store-style) backend", async () => {
    // A trivial shared-store stand-in proving the interface is honored + async-capable.
    const counts = new Map<string, number>();
    const store: RateLimitStore = {
      async hit(key, windowMs, now) {
        const count = (counts.get(key) ?? 0) + 1;
        counts.set(key, count);
        return { count, resetAt: now + windowMs };
      },
    };
    const app = new Hono();
    app.use("*", rateLimit({ limit: 1, windowMs: 60_000, now: () => 0, store }));
    app.get("/x", (c) => c.text("ok"));
    const hit = () => app.request("/x", { headers: { "x-forwarded-for": "7.7.7.7" } });
    expect((await hit()).status).toBe(200);
    expect((await hit()).status).toBe(429); // count 2 > limit 1, via the injected store
  });
});

// --- HTTP hardening (headers / CORS / body limit / rate limit) ---------------
describe("mountHttpHardening", () => {
  const build = (profile: "dev" | "production") => {
    const app = new Hono();
    mountHttpHardening(app, { profile });
    app.get("/x", (c) => c.json({ ok: true }));
    app.post("/x", (c) => c.json({ ok: true }));
    return app;
  };

  it("sets strict security headers + no-store on every response", async () => {
    const res = await build("dev").request("/x");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Strict-Transport-Security")).toMatch(/max-age=31536000/);
    expect(res.headers.get("Content-Security-Policy")).toMatch(/default-src 'none'/);
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("dev: permissive CORS; allowlist enforced when configured", async () => {
    let res = await build("dev").request("/x", { headers: { Origin: "https://app.example" } });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");

    process.env.RONIN_CORS_ORIGINS = "https://trusted.example";
    const app = build("dev");
    res = await app.request("/x", { headers: { Origin: "https://trusted.example" } });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://trusted.example");
    res = await app.request("/x", { headers: { Origin: "https://evil.example" } });
    expect(res.headers.get("Access-Control-Allow-Origin")).not.toBe("https://evil.example");
  });

  it("production without an allowlist emits no CORS header (same-origin only)", async () => {
    const res = await build("production").request("/x", { headers: { Origin: "https://app.example" } });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("rejects oversized bodies with 413", async () => {
    process.env.RONIN_MAX_BODY_BYTES = "16";
    const res = await build("dev").request("/x", { method: "POST", body: "x".repeat(1000), headers: { "Content-Type": "application/json" } });
    expect(res.status).toBe(413);
  });

  it("rate-limits in the production profile", async () => {
    process.env.RONIN_RATE_LIMIT_RPM = "2";
    const app = build("production");
    const hit = () => app.request("/x", { headers: { "x-forwarded-for": "9.9.9.9" } });
    expect((await hit()).status).toBe(200);
    expect((await hit()).status).toBe(200);
    expect((await hit()).status).toBe(429);
  });

  it("dev profile does not rate-limit by default", async () => {
    const app = build("dev");
    for (let i = 0; i < 50; i++) expect((await app.request("/x")).status).toBe(200);
  });
});
