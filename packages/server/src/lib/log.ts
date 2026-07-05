/**
 * Shared structured logger (pino) + a helper for the many `catch {}` sites that intentionally
 * degrade to a default. Swallowing is correct for "resource not provisioned yet" but hides real
 * operational faults (sidecar down, schema drift) — `logSwallowed` keeps the graceful default
 * while making the fault visible at warn level. PHI-safe: log the context + error message, never
 * request bodies / resource data.
 */
import pino from "pino";

export const log = pino({ level: process.env.FHIRENGINE_LOG_LEVEL ?? "info" });

/** Log a swallowed error (kept graceful) with a short context tag; returns nothing. */
export function logSwallowed(context: string, err: unknown): void {
  log.warn({ context, err: err instanceof Error ? err.message : String(err) }, `swallowed error: ${context}`);
}
