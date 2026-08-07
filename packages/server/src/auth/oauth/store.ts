/**
 * Authorization-code + refresh-token + jti store for the SMART auth server.
 *
 * Pluggable backend (ADR-0033 pattern, mirrors the rate-limit store):
 *   - `MemoryOAuthStore` (default) — per-process, TTL-checked on take. Dev / single node.
 *   - `RedisOAuthStore` (redis-oauth-store.ts) — shared + restart-durable; REQUIRED for
 *     multi-instance deploys and recommended anywhere refresh tokens matter: with the
 *     in-memory store a restart silently revokes every app's 90-day offline access and
 *     resets the jti replay guard. Wired via `FHIRENGINE_OAUTH_STORE=redis` (server.ts).
 *
 * Semantics the backends must preserve:
 *   - codes and refresh tokens are ONE-TIME: a take (even of an expired entry) consumes it.
 *   - jti entries are first-use-wins within their TTL (replay → true).
 */
import { randomBytes } from "node:crypto";

export interface AuthCode {
  clientId: string;
  redirectUri: string;
  scope: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  patient?: string;
  encounter?: string;
  user?: string; // fhirUser reference
  nonce?: string;
}

export interface RefreshGrant {
  clientId: string;
  scope: string;
  patient?: string;
  encounter?: string;
  user?: string;
}

/** Backend contract. TTLs in milliseconds; take* consumes the entry (expired → null). */
export interface OAuthStoreBackend {
  putCode(code: string, data: AuthCode, ttlMs: number): Promise<void>;
  takeCode(code: string): Promise<AuthCode | null>;
  putRefresh(token: string, data: RefreshGrant, ttlMs: number): Promise<void>;
  takeRefresh(token: string): Promise<RefreshGrant | null>;
  /** Record a jti; true if it was ALREADY seen inside its TTL (replay → reject). */
  jtiSeen(jti: string, ttlMs: number): Promise<boolean>;
  /** Test/maintenance reset. */
  clear(): Promise<void>;
}

/** Per-process backend (the previous behavior, verbatim). */
export class MemoryOAuthStore implements OAuthStoreBackend {
  private readonly codes = new Map<string, AuthCode & { expiresAt: number }>();
  private readonly refresh = new Map<string, RefreshGrant & { expiresAt: number }>();
  private readonly seenJtis = new Map<string, number>();

  async putCode(code: string, data: AuthCode, ttlMs: number): Promise<void> {
    this.codes.set(code, { ...data, expiresAt: Date.now() + ttlMs });
  }
  async takeCode(code: string): Promise<AuthCode | null> {
    const c = this.codes.get(code);
    if (!c) return null;
    this.codes.delete(code); // one-time use
    return c.expiresAt > Date.now() ? c : null;
  }
  async putRefresh(token: string, data: RefreshGrant, ttlMs: number): Promise<void> {
    this.refresh.set(token, { ...data, expiresAt: Date.now() + ttlMs });
  }
  async takeRefresh(token: string): Promise<RefreshGrant | null> {
    const g = this.refresh.get(token);
    if (!g) return null;
    this.refresh.delete(token); // rotate on use
    return g.expiresAt > Date.now() ? g : null;
  }
  async jtiSeen(jti: string, ttlMs: number): Promise<boolean> {
    const t = Date.now();
    for (const [k, exp] of this.seenJtis) if (exp <= t) this.seenJtis.delete(k); // prune
    if (this.seenJtis.has(jti)) return true;
    this.seenJtis.set(jti, t + ttlMs);
    return false;
  }
  async clear(): Promise<void> { this.codes.clear(); this.refresh.clear(); this.seenJtis.clear(); }
}

let backend: OAuthStoreBackend = new MemoryOAuthStore();
/** Swap the backend (server wiring / tests). Returns the previous one. */
export function setOAuthStoreBackend(next: OAuthStoreBackend): OAuthStoreBackend {
  const prev = backend;
  backend = next;
  return prev;
}

const token = () => randomBytes(32).toString("base64url");

// (g)(10) §170.315(g)(10)(v)(A): patient apps must receive refresh tokens valid for AT LEAST
// 3 months without re-authorization. Default 90 days; FHIRENGINE_OAUTH_REFRESH_TTL_SECONDS overrides.
const refreshTtlDefault = (): number =>
  Number(process.env.FHIRENGINE_OAUTH_REFRESH_TTL_SECONDS) || 60 * 60 * 24 * 90;

export async function putCode(data: AuthCode, ttlSeconds = 300): Promise<string> {
  const code = token();
  await backend.putCode(code, data, ttlSeconds * 1000);
  return code;
}

/** Consume a code once (null if unknown/expired/already-used). */
export function takeCode(code: string): Promise<AuthCode | null> {
  return backend.takeCode(code);
}

export async function putRefresh(data: RefreshGrant, ttlSeconds = refreshTtlDefault()): Promise<string> {
  const t = token();
  await backend.putRefresh(t, data, ttlSeconds * 1000);
  return t;
}

export function takeRefresh(t: string): Promise<RefreshGrant | null> {
  return backend.takeRefresh(t);
}

/** Record a jti; true if it was ALREADY seen (replay → reject). */
export function jtiReplay(jti: string, ttlSeconds = 300): Promise<boolean> {
  return backend.jtiSeen(jti, ttlSeconds * 1000);
}

/** Test/maintenance helper. */
export function clearOAuthStore(): Promise<void> { return backend.clear(); }
