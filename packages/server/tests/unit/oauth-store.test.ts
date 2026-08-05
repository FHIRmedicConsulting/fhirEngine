import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  putCode, takeCode, putRefresh, takeRefresh, jtiReplay, clearOAuthStore,
} from "../../src/auth/oauth/store.js";

beforeEach(() => {
  clearOAuthStore();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

const grant = {
  clientId: "app-1", redirectUri: "https://app.example/cb", scope: "patient/*.rs launch/patient",
  codeChallenge: "challenge", codeChallengeMethod: "S256", patient: "pat-1", user: "Practitioner/dr-1", nonce: "n1",
};

describe("authorization codes", () => {
  it("mints unpredictable, unique codes (32 bytes, base64url)", () => {
    const a = putCode(grant);
    const b = putCode(grant);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });

  it("takeCode returns the stored grant exactly once (one-time use)", () => {
    const code = putCode(grant);
    const first = takeCode(code);
    expect(first).toMatchObject(grant);
    expect(takeCode(code)).toBeNull(); // replayed code exchange must fail
  });

  it("unknown codes yield null", () => {
    expect(takeCode("no-such-code")).toBeNull();
  });

  it("codes expire after their TTL (default 300s)", () => {
    const code = putCode(grant);
    vi.advanceTimersByTime(301_000);
    expect(takeCode(code)).toBeNull();
  });

  it("a code is still valid just inside the TTL and honors a custom TTL", () => {
    const short = putCode(grant, 10);
    const dflt = putCode(grant);
    vi.advanceTimersByTime(11_000);
    expect(takeCode(short)).toBeNull();
    expect(takeCode(dflt)).not.toBeNull();
  });

  it("an expired code is consumed by the failed take (no second chance)", () => {
    const start = Date.now();
    const code = putCode(grant, 1);
    vi.advanceTimersByTime(2_000);
    expect(takeCode(code)).toBeNull();
    vi.setSystemTime(start); // even if the clock rewinds, the code is gone
    expect(takeCode(code)).toBeNull();
  });
});

describe("refresh tokens", () => {
  const rg = { clientId: "app-1", scope: "patient/*.rs offline_access", patient: "pat-1", user: "Practitioner/dr-1" };

  it("rotates on use: a taken refresh token can never be replayed", () => {
    const t = putRefresh(rg);
    expect(takeRefresh(t)).toMatchObject(rg);
    expect(takeRefresh(t)).toBeNull();
  });

  it("expires after the TTL (default 30 days)", () => {
    const t = putRefresh(rg);
    vi.advanceTimersByTime(31 * 24 * 60 * 60 * 1000);
    expect(takeRefresh(t)).toBeNull();
  });

  it("survives until just before the TTL", () => {
    const t = putRefresh(rg, 60);
    vi.advanceTimersByTime(59_000);
    expect(takeRefresh(t)).toMatchObject(rg);
  });
});

describe("jti replay prevention (backend-services client assertions)", () => {
  it("first use passes, any repeat within the TTL is flagged as replay", () => {
    expect(jtiReplay("jti-1")).toBe(false);
    expect(jtiReplay("jti-1")).toBe(true);
    expect(jtiReplay("jti-2")).toBe(false); // distinct jti unaffected
  });

  it("a jti becomes usable again after its TTL expires (entry pruned)", () => {
    expect(jtiReplay("jti-1", 10)).toBe(false);
    vi.advanceTimersByTime(11_000);
    expect(jtiReplay("jti-1", 10)).toBe(false); // expired entry pruned, not a replay
    expect(jtiReplay("jti-1", 10)).toBe(true);
  });

  it("pruning only evicts expired entries", () => {
    expect(jtiReplay("short", 5)).toBe(false);
    expect(jtiReplay("long", 600)).toBe(false);
    vi.advanceTimersByTime(6_000);
    expect(jtiReplay("other", 5)).toBe(false); // triggers prune
    expect(jtiReplay("long", 600)).toBe(true); // still tracked → replay
  });
});

describe("clearOAuthStore", () => {
  it("wipes codes, refresh grants, and seen jtis", () => {
    const code = putCode(grant);
    const t = putRefresh({ clientId: "a", scope: "s" });
    jtiReplay("jti-x");
    clearOAuthStore();
    expect(takeCode(code)).toBeNull();
    expect(takeRefresh(t)).toBeNull();
    expect(jtiReplay("jti-x")).toBe(false);
  });
});
