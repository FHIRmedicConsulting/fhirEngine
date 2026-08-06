/**
 * Authorization-code + refresh-token store for the SMART auth server.
 *
 * In-memory with TTL (dev / single-process). Codes are one-time (consumed on token exchange).
 * A persisted store (Delta table or Redis) is required for multi-instance deploys — a follow-up.
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
  expiresAt: number;
}

export interface RefreshGrant {
  clientId: string;
  scope: string;
  patient?: string;
  encounter?: string;
  user?: string;
  expiresAt: number;
}

const codes = new Map<string, AuthCode>();
const refresh = new Map<string, RefreshGrant>();

const token = () => randomBytes(32).toString("base64url");
const now = () => Date.now();

export function putCode(data: Omit<AuthCode, "expiresAt">, ttlSeconds = 300): string {
  const code = token();
  codes.set(code, { ...data, expiresAt: now() + ttlSeconds * 1000 });
  return code;
}

/** Consume a code once (returns null if unknown/expired/already-used). */
export function takeCode(code: string): AuthCode | null {
  const c = codes.get(code);
  if (!c) return null;
  codes.delete(code); // one-time use
  return c.expiresAt > now() ? c : null;
}

export function putRefresh(data: Omit<RefreshGrant, "expiresAt">, ttlSeconds = 60 * 60 * 24 * 30): string {
  const t = token();
  refresh.set(t, { ...data, expiresAt: now() + ttlSeconds * 1000 });
  return t;
}

export function takeRefresh(t: string): RefreshGrant | null {
  const g = refresh.get(t);
  if (!g) return null;
  refresh.delete(t); // rotate on use
  return g.expiresAt > now() ? g : null;
}

// jti replay prevention for backend-services client assertions (each jti usable once).
const seenJtis = new Map<string, number>();
/** Record a jti; returns true if it was ALREADY seen (replay → reject). Expired entries are pruned. */
export function jtiReplay(jti: string, ttlSeconds = 300): boolean {
  const t = now();
  for (const [k, exp] of seenJtis) if (exp <= t) seenJtis.delete(k); // prune
  if (seenJtis.has(jti)) return true;
  seenJtis.set(jti, t + ttlSeconds * 1000);
  return false;
}

/** Test/maintenance helper. */
export function clearOAuthStore(): void { codes.clear(); refresh.clear(); seenJtis.clear(); }
