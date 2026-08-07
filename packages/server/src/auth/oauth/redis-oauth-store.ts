/**
 * Redis-backed OAuth store (codes / refresh tokens / jti replay) — restart-durable and shared
 * across instances. Mirrors the RedisRateLimitStore pattern: NO forced dependency — takes an
 * injected client satisfying a tiny interface (`ioredis` does); server.ts lazy-imports and wires
 * it only when `FHIRENGINE_OAUTH_STORE=redis` + `FHIRENGINE_REDIS_URL`.
 *
 * Atomicity requirements and how they map to Redis:
 *   - one-time code/refresh take → `GETDEL` (single atomic get-and-delete; Redis ≥6.2);
 *     TTL expiry is native (`PX`), so an expired entry reads as null — same contract as memory.
 *   - jti first-use-wins → `SET key 1 PX ttl NX`: null reply = already present = replay.
 */
import type { AuthCode, OAuthStoreBackend, RefreshGrant } from "./store.js";

/** Minimal Redis surface (ioredis-shaped). */
export interface RedisOAuthClient {
  set(key: string, value: string, px: "PX", ttlMs: number, nx?: "NX"): Promise<unknown>;
  getdel(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<unknown>;
  scan(cursor: string, matchToken: "MATCH", pattern: string, countToken: "COUNT", count: number): Promise<[string, string[]]>;
}

export class RedisOAuthStore implements OAuthStoreBackend {
  constructor(private readonly redis: RedisOAuthClient, private readonly prefix = "fhirengine:oauth:") {}

  private k(kind: "code" | "refresh" | "jti", id: string): string {
    return `${this.prefix}${kind}:${id}`;
  }

  async putCode(code: string, data: AuthCode, ttlMs: number): Promise<void> {
    await this.redis.set(this.k("code", code), JSON.stringify(data), "PX", ttlMs);
  }
  async takeCode(code: string): Promise<AuthCode | null> {
    const raw = await this.redis.getdel(this.k("code", code));
    return raw ? (JSON.parse(raw) as AuthCode) : null;
  }
  async putRefresh(token: string, data: RefreshGrant, ttlMs: number): Promise<void> {
    await this.redis.set(this.k("refresh", token), JSON.stringify(data), "PX", ttlMs);
  }
  async takeRefresh(token: string): Promise<RefreshGrant | null> {
    const raw = await this.redis.getdel(this.k("refresh", token));
    return raw ? (JSON.parse(raw) as RefreshGrant) : null;
  }
  async jtiSeen(jti: string, ttlMs: number): Promise<boolean> {
    // SET NX: null reply → key existed → replay. Expired keys vanish natively.
    const reply = await this.redis.set(this.k("jti", jti), "1", "PX", ttlMs, "NX");
    return reply === null;
  }
  async clear(): Promise<void> {
    // Test/maintenance only (SCAN + DEL over the prefix); never on a hot path.
    let cursor = "0";
    do {
      const [next, keys] = await this.redis.scan(cursor, "MATCH", `${this.prefix}*`, "COUNT", 500);
      if (keys.length) await this.redis.del(...keys);
      cursor = next;
    } while (cursor !== "0");
  }
}
