/**
 * OAuth client registry for the SMART auth server.
 *
 * `RONIN_OAUTH_CLIENTS` = JSON array of clients (production). When unset, dev-permissive mode:
 * any client_id is accepted as a public client (PKCE required), trusting the request redirect_uri.
 * Set the registry for production to lock down clients + redirect URIs.
 */
import { createLocalJWKSet, createRemoteJWKSet } from "jose";
import { getRegisteredClient } from "../udap/registered-clients.js";

export interface OAuthClient {
  clientId: string;
  redirectUris?: string[];
  type?: "public" | "confidential";
  secret?: string;   // confidential symmetric (client_secret)
  jwksUri?: string;  // confidential asymmetric (backend services private_key_jwt)
  jwks?: { keys: Record<string, unknown>[] }; // inline JWKS (alternative to jwksUri)
}

function registry(): OAuthClient[] | null {
  const raw = process.env.RONIN_OAUTH_CLIENTS;
  if (!raw) return null;
  try { return JSON.parse(raw) as OAuthClient[]; } catch { return null; }
}

/** Resolve a client: UDAP dynamically-registered clients first, then the static registry.
 *  Null if a static registry is configured and the id is unknown. */
export function resolveClient(clientId: string): OAuthClient | null {
  const dcr = getRegisteredClient(clientId); // UDAP DCR (ADR-0036)
  if (dcr) return dcr;
  const reg = registry();
  if (!reg) return { clientId, type: "public" }; // dev: accept any public client (+PKCE enforced)
  return reg.find((c) => c.clientId === clientId) ?? null;
}

export function redirectAllowed(client: OAuthClient, uri: string): boolean {
  if (!client.redirectUris?.length) return true; // dev: trust the request's redirect_uri
  return client.redirectUris.includes(uri);
}

/** A jose key resolver for verifying a client's `private_key_jwt` assertion (inline JWKS or
 * a JWKS URL). Null if the client has no registered asymmetric key (backend services requires it). */
export function clientKeySet(client: OAuthClient): ReturnType<typeof createLocalJWKSet> | null {
  if (client.jwks?.keys?.length) return createLocalJWKSet(client.jwks as Parameters<typeof createLocalJWKSet>[0]);
  if (client.jwksUri) return createRemoteJWKSet(new URL(client.jwksUri));
  return null;
}
