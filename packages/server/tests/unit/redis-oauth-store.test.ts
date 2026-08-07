import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { RedisOAuthStore, type RedisOAuthClient } from "../../src/auth/oauth/redis-oauth-store.js";
import { setOAuthStoreBackend, MemoryOAuthStore, putCode, takeCode, jtiReplay } from "../../src/auth/oauth/store.js";

/** In-memory fake honoring the exact command shapes the store uses (PX TTLs, NX, GETDEL, SCAN). */
class FakeRedis implements RedisOAuthClient {
  readonly kv = new Map<string, { value: string; expiresAt: number }>();
  private live(key: string): { value: string; expiresAt: number } | undefined {
    const e = this.kv.get(key);
    if (e && e.expiresAt <= Date.now()) { this.kv.delete(key); return undefined; }
    return e;
  }
  async set(key: string, value: string, _px: "PX", ttlMs: number, nx?: "NX"): Promise<unknown> {
    if (nx === "NX" && this.live(key)) return null;
    this.kv.set(key, { value, expiresAt: Date.now() + ttlMs });
    return "OK";
  }
  async getdel(key: string): Promise<string | null> {
    const e = this.live(key);
    this.kv.delete(key);
    return e ? e.value : null;
  }
  async del(...keys: string[]): Promise<unknown> { keys.forEach((k) => this.kv.delete(k)); return keys.length; }
  async scan(_c: string, _m: "MATCH", pattern: string, _ct: "COUNT", _n: number): Promise<[string, string[]]> {
    const prefix = pattern.replace(/\*$/, "");
    return ["0", [...this.kv.keys()].filter((k) => k.startsWith(prefix))];
  }
}

let fake: FakeRedis;
let store: RedisOAuthStore;
beforeEach(() => {
  vi.useFakeTimers();
  fake = new FakeRedis();
  store = new RedisOAuthStore(fake);
});
afterEach(() => vi.useRealTimers());

const code = { clientId: "app", redirectUri: "https://app.example/cb", scope: "patient/*.rs", patient: "p1" };

describe("RedisOAuthStore", () => {
  it("codes round-trip and are one-time (GETDEL)", async () => {
    await store.putCode("c1", code, 300_000);
    expect(await store.takeCode("c1")).toMatchObject(code);
    expect(await store.takeCode("c1")).toBeNull();
  });

  it("codes expire via native PX TTL", async () => {
    await store.putCode("c1", code, 1_000);
    vi.advanceTimersByTime(1_100);
    expect(await store.takeCode("c1")).toBeNull();
  });

  it("refresh grants round-trip, rotate, and expire", async () => {
    const g = { clientId: "app", scope: "patient/*.rs offline_access", patient: "p1" };
    await store.putRefresh("r1", g, 60_000);
    expect(await store.takeRefresh("r1")).toMatchObject(g);
    expect(await store.takeRefresh("r1")).toBeNull(); // rotated
    await store.putRefresh("r2", g, 1_000);
    vi.advanceTimersByTime(1_100);
    expect(await store.takeRefresh("r2")).toBeNull(); // expired
  });

  it("jti is first-use-wins within TTL (SET NX)", async () => {
    expect(await store.jtiSeen("j1", 10_000)).toBe(false);
    expect(await store.jtiSeen("j1", 10_000)).toBe(true);
    vi.advanceTimersByTime(11_000);
    expect(await store.jtiSeen("j1", 10_000)).toBe(false); // expired → usable again
  });

  it("keys are namespaced under the prefix", async () => {
    await store.putCode("c1", code, 300_000);
    await store.jtiSeen("j1", 10_000);
    expect([...fake.kv.keys()].every((k) => k.startsWith("fhirengine:oauth:"))).toBe(true);
  });

  it("clear() removes only prefixed keys", async () => {
    await store.putCode("c1", code, 300_000);
    await fake.set("unrelated:key", "x", "PX", 300_000);
    await store.clear();
    expect(await store.takeCode("c1")).toBeNull();
    expect(fake.kv.has("unrelated:key")).toBe(true);
  });
});

describe("backend swapping (server wiring path)", () => {
  it("module facade routes through the configured backend and back", async () => {
    const prev = setOAuthStoreBackend(store);
    try {
      const c = await putCode(code);
      expect([...fake.kv.keys()].some((k) => k.includes(c))).toBe(true); // landed in "redis"
      expect(await takeCode(c)).toMatchObject(code);
      expect(await jtiReplay("swap-jti")).toBe(false);
      expect(await jtiReplay("swap-jti")).toBe(true);
    } finally {
      setOAuthStoreBackend(prev ?? new MemoryOAuthStore());
    }
  });
});
