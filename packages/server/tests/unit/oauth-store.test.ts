import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  putCode, takeCode, putRefresh, takeRefresh, jtiReplay, clearOAuthStore,
} from "../../src/auth/oauth/store.js";

beforeEach(async () => {
  await clearOAuthStore();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

const grant = {
  clientId: "app-1", redirectUri: "https://app.example/cb", scope: "patient/*.rs launch/patient",
  codeChallenge: "challenge", codeChallengeMethod: "S256", patient: "pat-1", user: "Practitioner/dr-1", nonce: "n1",
};

describe("authorization codes", () => {
  it("mints unpredictable, unique codes (32 bytes, base64url)", async () => {
    const a = await putCode(grant);
    const b = await putCode(grant);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });

  it("takeCode returns the stored grant exactly once (one-time use)", async () => {
    const code = await putCode(grant);
    expect(await takeCode(code)).toMatchObject(grant);
    expect(await takeCode(code)).toBeNull(); // replayed code exchange must fail
  });

  it("unknown codes yield null", async () => {
    expect(await takeCode("no-such-code")).toBeNull();
  });

  it("codes expire after their TTL (default 300s)", async () => {
    const code = await putCode(grant);
    vi.advanceTimersByTime(301_000);
    expect(await takeCode(code)).toBeNull();
  });

  it("a code is still valid just inside the TTL and honors a custom TTL", async () => {
    const short = await putCode(grant, 10);
    const dflt = await putCode(grant);
    vi.advanceTimersByTime(11_000);
    expect(await takeCode(short)).toBeNull();
    expect(await takeCode(dflt)).not.toBeNull();
  });

  it("an expired code is consumed by the failed take (no second chance)", async () => {
    const start = Date.now();
    const code = await putCode(grant, 1);
    vi.advanceTimersByTime(2_000);
    expect(await takeCode(code)).toBeNull();
    vi.setSystemTime(start); // even if the clock rewinds, the code is gone
    expect(await takeCode(code)).toBeNull();
  });
});

describe("refresh tokens", () => {
  const rg = { clientId: "app-1", scope: "patient/*.rs offline_access", patient: "pat-1", user: "Practitioner/dr-1" };

  it("rotates on use: a taken refresh token can never be replayed", async () => {
    const t = await putRefresh(rg);
    expect(await takeRefresh(t)).toMatchObject(rg);
    expect(await takeRefresh(t)).toBeNull();
  });

  it("expires after the TTL (default 90 days — (g)(10) requires ≥3 months)", async () => {
    const t = await putRefresh(rg);
    vi.advanceTimersByTime(89 * 24 * 60 * 60 * 1000 + 60_000);
    expect(await takeRefresh(t)).toMatchObject(rg); // still valid inside 90 days (rotated by this take)
    const t2 = await putRefresh(rg);
    vi.advanceTimersByTime(91 * 24 * 60 * 60 * 1000);
    expect(await takeRefresh(t2)).toBeNull();
  });

  it("honors FHIRENGINE_OAUTH_REFRESH_TTL_SECONDS override", async () => {
    process.env.FHIRENGINE_OAUTH_REFRESH_TTL_SECONDS = "60";
    try {
      const t = await putRefresh(rg);
      vi.advanceTimersByTime(61_000);
      expect(await takeRefresh(t)).toBeNull();
    } finally {
      delete process.env.FHIRENGINE_OAUTH_REFRESH_TTL_SECONDS;
    }
  });

  it("survives until just before the TTL", async () => {
    const t = await putRefresh(rg, 60);
    vi.advanceTimersByTime(59_000);
    expect(await takeRefresh(t)).toMatchObject(rg);
  });
});

describe("jti replay prevention (backend-services client assertions)", () => {
  it("first use passes, any repeat within the TTL is flagged as replay", async () => {
    expect(await jtiReplay("jti-1")).toBe(false);
    expect(await jtiReplay("jti-1")).toBe(true);
    expect(await jtiReplay("jti-2")).toBe(false); // distinct jti unaffected
  });

  it("a jti becomes usable again after its TTL expires (entry pruned)", async () => {
    expect(await jtiReplay("jti-1", 10)).toBe(false);
    vi.advanceTimersByTime(11_000);
    expect(await jtiReplay("jti-1", 10)).toBe(false); // expired entry pruned, not a replay
    expect(await jtiReplay("jti-1", 10)).toBe(true);
  });

  it("pruning only evicts expired entries", async () => {
    expect(await jtiReplay("short", 5)).toBe(false);
    expect(await jtiReplay("long", 600)).toBe(false);
    vi.advanceTimersByTime(6_000);
    expect(await jtiReplay("other", 5)).toBe(false); // triggers prune
    expect(await jtiReplay("long", 600)).toBe(true); // still tracked → replay
  });
});

describe("clearOAuthStore", () => {
  it("wipes codes, refresh grants, and seen jtis", async () => {
    const code = await putCode(grant);
    const t = await putRefresh({ clientId: "a", scope: "s" });
    await jtiReplay("jti-x");
    await clearOAuthStore();
    expect(await takeCode(code)).toBeNull();
    expect(await takeRefresh(t)).toBeNull();
    expect(await jtiReplay("jti-x")).toBe(false);
  });
});
