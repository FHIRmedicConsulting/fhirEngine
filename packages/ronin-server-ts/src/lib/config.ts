/** Runtime config flags (env-driven). */

/**
 * Quarantine-on-unknown-terminology ([[validation-before-bronze]]). When ON, a resource
 * whose binding references a not-loaded ValueSet is held in the pending-terminology queue
 * (and the missing VSAC sets auto-pulled + the record re-validated) instead of the default
 * graceful pass-through. Opt-in so it never strands resources binding never-loadable sets.
 */
export const quarantineOnUnknown = (): boolean => process.env.RONIN_QUARANTINE_ON_UNKNOWN === "true";
