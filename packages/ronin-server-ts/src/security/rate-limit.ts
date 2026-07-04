/**
 * Fixed-window rate limiter (ADR-0033) — DoS / abuse protection at the HTTP tier. Keyed by
 * authenticated client_id when present, else client IP. Emits standard `RateLimit-*` + `Retry-After`
 * headers and a 429 OperationOutcome when exceeded.
 *
 * The counter lives behind a pluggable {@link RateLimitStore}. The default {@link MemoryRateLimitStore}
 * is single-node (per-process). A multi-node deployment can implement `RateLimitStore` over a shared
 * store (e.g. Redis) so limits are consistent across instances — the interface is async-capable for
 * exactly that. Shared-store limiting is a documented follow-up (not required for single-node Alpha).
 */
import type { MiddlewareHandler, Context } from "hono";

export interface RateLimitState {
  count: number;
  resetAt: number;
}

/** Pluggable counter backend. `hit` may be sync (memory) or async (a shared store). */
export interface RateLimitStore {
  hit(key: string, windowMs: number, now: number): RateLimitState | Promise<RateLimitState>;
}

/** In-process fixed-window store. Bounds memory by sweeping expired windows under key churn. */
export class MemoryRateLimitStore implements RateLimitStore {
  private readonly store = new Map<string, RateLimitState>();

  hit(key: string, windowMs: number, now: number): RateLimitState {
    let entry = this.store.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      this.store.set(key, entry);
      if (this.store.size > 10_000) this.sweep(now);
    }
    entry.count += 1;
    return entry;
  }

  sweep(now: number = Date.now()): void {
    for (const [k, v] of this.store) if (v.resetAt <= now) this.store.delete(k);
  }

  get size(): number {
    return this.store.size;
  }
}

export interface RateLimitOptions {
  /** Max requests per window per client. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Clock injection for tests. */
  now?: () => number;
  /** Counter backend; defaults to a per-process {@link MemoryRateLimitStore}. */
  store?: RateLimitStore;
}

/** Client key: prefer the authenticated client_id (set by the auth gate), else the peer IP. */
function clientKey(c: Context): string {
  const auth = c.get("auth") as { clientId?: string } | undefined;
  if (auth?.clientId) return `cid:${auth.clientId}`;
  const fwd = c.req.header("x-forwarded-for");
  const ip = fwd ? fwd.split(",")[0]!.trim() : c.req.header("x-real-ip") ?? "unknown";
  return `ip:${ip}`;
}

/** Build a rate-limit middleware over the given (or a default in-memory) store. */
export function rateLimit(opts: RateLimitOptions): MiddlewareHandler {
  const now = opts.now ?? Date.now;
  const store = opts.store ?? new MemoryRateLimitStore();

  return async (c, next) => {
    const t = now();
    const { count, resetAt } = await store.hit(clientKey(c), opts.windowMs, t);

    const remaining = Math.max(0, opts.limit - count);
    const resetSecs = Math.max(0, Math.ceil((resetAt - t) / 1000));
    c.header("RateLimit-Limit", String(opts.limit));
    c.header("RateLimit-Remaining", String(remaining));
    c.header("RateLimit-Reset", String(resetSecs));

    if (count > opts.limit) {
      c.header("Retry-After", String(resetSecs));
      return c.json(
        {
          resourceType: "OperationOutcome",
          issue: [{ severity: "error", code: "throttled", diagnostics: "Rate limit exceeded. Retry later." }],
        },
        429,
      );
    }
    await next();
    return;
  };
}
