# ADR-0029: Runtime & Stack — TypeScript/Node + Hono (ratifies the un-ratified stack)

- Status: **Accepted** 2026-06-28 (Chad) — ratifies the stack that shipped un-ratified; supersedes the **Rejected** [ADR-0002](0002-runtime-language-and-stack.md), whose replacement was never written. (`@databricks/sql` removal + `vitest@4` bump are the implementing dep-changes, pending separate go-ahead.)
- Date: 2026-06-28
- Decider(s): Chad
- Session: 032 (standalone fork)
- Related: [ADR-0028](0028-cross-product-platform-alignment.md) (shared platform), [ADR-0022](0022-standalone-storage-flattening-and-catalog-seam.md) (+ A1, engine), [docs/governance/component-disclosure-review.md](../governance/component-disclosure-review.md), [[component-disclosure-policy]]

## Context

The runtime/web-framework stack — **TypeScript/Node + Hono** — entered with the
heritage fork and was **never ratified**: ADR-0002 ("Runtime Language and Stack") is
marked **Rejected** and its queued replacement was never drafted. Chad flagged this as
an architecture/product/**security** governance gap (undisclosed components). This ADR
closes it: it ratifies (or is the place to amend) the stack on the record, consistent
with the cross-product platform alignment of ADR-0028.

## Decision — the ratified stack

**Server runtime:** **TypeScript on Node (≥20)**. Chosen so RoninStandAlone is a
**sister codebase of Ronin** and both products share one protocol tier (ADR-0028); the
Python-native and Rust-native alternatives were POC'd + benchmarked and rejected for
forking the codebase (sidecar overhead is single-digit-ms, write-path-only — see
`docs/research/2026-06-27-python-vs-ts-hono-server.md`).

**Approved components (production, `packages/ronin-server-ts`):**

| Component | Role | Basis |
|---|---|---|
| **hono** + **@hono/node-server** | web framework + Node adapter | ratified here (was un-ratified) |
| **zod** | REST-boundary validation | Chad-endorsed (session 032) |
| **pino** | structured logging | ratified here |
| **@ronin/fhir-types** (+ **@atomic-ehr/codegen** to generate it) | FHIR R4 types | ratified here; codegen is pre-1.0 — pin/vendor (follow-up) |
| **delta-rs / DataFusion** (Python sidecar) + **pyarrow** | storage engine | ADR-0022 A1 / ADR-0028 |
| dev: **typescript**, **tsx**, **vitest**, @types/node | build/test | ratified here |

**Explicitly NOT in the standalone stack:** **`@databricks/sql`** — Databricks-only
(the coupling the product sheds), legacy under ADR-0028, and the **source of the
high-severity `thrift` vulnerabilities** (no upstream fix; npm audit session 032).
Remove from `packages/ronin-server-ts` (its `DatabricksWarehouse` is heritage; gate it
behind an optional/lazy module so the shared codebase doesn't hard-depend on it).

## Consequences

- The foundational stack is on the record; new components follow
  [[component-disclosure-policy]] (disclose + approve before adding).
- Removing `@databricks/sql` from the standalone dependency set eliminates the high
  vulns and aligns with ADR-0028 (delta-rs/DataFusion is the shared interactive
  engine). Under ADR-0028 the shared codebase keeps a *DatabricksWarehouse* only as an
  optional binding for Ronin's legacy path, pending the convergence spike.
- Dev-tooling vulns (esbuild→vite→vitest, moderate, not shipped) are addressed by a
  deliberate `vitest@4` bump — a separate, approved change.

## Open questions / follow-ups

- Pin or vendor **@atomic-ehr/codegen** (pre-1.0, generates product types — provenance
  matters for PHI).
- Make `DatabricksWarehouse` / `@databricks/sql` an optional dependency vs removing it
  outright from the shared codebase (ties to ADR-0028 sequencing).
- `vitest@4` upgrade (breaking, test-only) to clear the dev-tooling advisories.
