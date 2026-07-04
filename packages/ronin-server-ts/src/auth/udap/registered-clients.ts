/**
 * In-memory registry of UDAP dynamically-registered clients (ADR-0036). Populated by the DCR
 * endpoint (udap-routes.ts) and consulted by the OAuth client resolver (oauth/clients.ts) so a
 * UDAP-registered client can immediately use the token endpoint (private_key_jwt / Backend Services).
 *
 * In-memory is fine for single-node Alpha; a persistent registry (Delta table) is a follow-up so
 * registrations survive restarts across a fleet.
 */
import type { OAuthClient } from "../oauth/clients.js";

const registered = new Map<string, OAuthClient>();

export function registerUdapClient(client: OAuthClient): void {
  registered.set(client.clientId, client);
}

export function getRegisteredClient(clientId: string): OAuthClient | null {
  return registered.get(clientId) ?? null;
}

/** Test helper — clear the in-memory registry. */
export function resetRegisteredClients(): void {
  registered.clear();
}
