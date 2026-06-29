/**
 * Token introspection facade with LRU caching.
 *
 * Per ADR-0006 §6:
 *   - Default cache TTL: 60s
 *   - `strict_federal`: 30s
 *   - Configurable via `ronin_introspection_cache_ttl`
 *
 * The cache key is the token itself (memory-resident; tokens are short-lived
 * and bounded in count); entries are evicted on TTL OR on capacity (oldest
 * eviction).
 */

import type { AuthStrategy, IntrospectionResult } from "./idp/types.js";

interface CacheEntry {
  result: IntrospectionResult;
  expiresAt: number;
}

export interface IntrospectionCacheOptions {
  /** TTL in seconds. */
  ttlSeconds: number;
  /** Max entries before oldest-eviction. */
  maxEntries: number;
}

export class IntrospectionService {
  private readonly strategy: AuthStrategy;
  private readonly cache: Map<string, CacheEntry>;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly clock: () => number;

  constructor(
    strategy: AuthStrategy,
    options: IntrospectionCacheOptions,
    clock: () => number = () => Date.now(),
  ) {
    this.strategy = strategy;
    this.cache = new Map();
    this.ttlMs = options.ttlSeconds * 1000;
    this.maxEntries = options.maxEntries;
    this.clock = clock;
  }

  async introspect(token: string): Promise<IntrospectionResult> {
    const now = this.clock();
    const cached = this.cache.get(token);
    if (cached && cached.expiresAt > now) {
      // Refresh insertion order to keep LRU semantics
      this.cache.delete(token);
      this.cache.set(token, cached);
      return cached.result;
    }
    if (cached) this.cache.delete(token);

    const result = await this.strategy.introspect(token);

    // Only cache active results; inactive results revalidate so users see
    // immediate effect of revocation.
    if (result.active) {
      // Token-claim expiration takes precedence over our TTL when shorter.
      const claimExpiry = result.exp ? result.exp * 1000 : now + this.ttlMs;
      const expiresAt = Math.min(now + this.ttlMs, claimExpiry);
      this.cache.set(token, { result, expiresAt });
      this.evictIfOver();
    }

    return result;
  }

  /** Drop a token from the cache (e.g., on `/internal/token-revoke` push). */
  invalidate(token: string): void {
    this.cache.delete(token);
  }

  /** Clear the entire cache. */
  invalidateAll(): void {
    this.cache.clear();
  }

  private evictIfOver(): void {
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  /** Test helper — current size. */
  size(): number {
    return this.cache.size;
  }
}
