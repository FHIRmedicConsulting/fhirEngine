# ADR-0028: Cross-Product Platform Alignment — One Engine + One Protocol Tier Across Ronin and RoninStandAlone

- Status: **Accepted** 2026-06-28 — platform **direction ratified** by Chad (converge both products on TS/Hono + delta-rs/DataFusion). **Implementation gate:** the Ronin interactive-path migration off `@databricks/sql` stays blocked on the delta-rs-vs-Databricks-UC validation spike (see "Validation required") before it ships. Affects the Ronin product.
- Date: 2026-06-28
- Decider(s): Chad
- Session: 032 (standalone fork)
- Related: [ADR-0022](0022-standalone-storage-flattening-and-catalog-seam.md) (+ A1), [ADR-0025](0025-catalog-governance-binding-seam.md), [ADR-0026](0026-medallion-promotion-orchestration.md), [docs/research/2026-06-27-python-vs-ts-hono-server.md](../research/2026-06-27-python-vs-ts-hono-server.md), [docs/governance/component-disclosure-review.md](../governance/component-disclosure-review.md)

## Context

Two sister products share a heritage codebase: **Ronin** (Databricks-native,
marketplace-deployable) and **RoninStandAlone** (self-hostable, OSS Delta). The goal
is maximum alignment and **avoiding a "corner of different platforms"** — divergent
technology stacks that fragment development and double maintenance.

Alignment today: both share the **TS/Hono protocol tier** (FHIR REST, validation,
SMART/UDAP, MPI, operations, audit, consent) behind the `Warehouse` + `Catalog` seams,
and both store data as **Delta**. The remaining divergence is the **interactive
engine**: Ronin uses Databricks SQL (`@databricks/sql`, Spark) while RoninStandAlone
uses **delta-rs / DataFusion** (ADR-0022 A1). Two engines = two SQL dialects, two
`Warehouse` implementations, every storage feature/bug done twice — the fragmentation
to avoid.

Convergence can only go one way: Standalone cannot run Databricks SQL, so the shared
engine must be the portable one. The catalog research (ADR-0025) found delta-rs and
DuckDB ship **Unity Catalog clients that work against Databricks UC *and* UC-OSS**, so
Ronin can run delta-rs/DataFusion over its Databricks-managed UC Delta.

## Decision

**Standardize the platform as TS/Hono (protocol tier) + delta-rs/DataFusion
(interactive engine) for BOTH products.** The two products then differ only in:

1. **Catalog binding** — Databricks Unity Catalog (Ronin) vs UC-OSS / path-based
   (Standalone), behind the `Catalog` seam (ADR-0025).
2. **Deployment mode** — exactly two options on the shared codebase:
   **(a) Databricks** (App / marketplace, paired with the Unity Catalog binding) **OR
   (b) Self / cloud-hosted** (container on any VM / cloud / on-prem, paired with the
   UC-OSS or path-based binding). One build, deployment mode is a config/binding switch
   (e.g. `RONIN_DEPLOY_MODE = databricks | self-hosted`). Heritage ADR-0013 is the
   Databricks mode; the self/cloud-hosted mode is RoninStandAlone's addition.
3. **Optional heavy bulk/analytics tier** — Spark on Databricks (Ronin's value-add)
   vs delta-rs/Python (Standalone). This is the *non-interactive* tier only.

Consequences for the stack:
- **One interactive engine, one SQL dialect, one `DeltaWarehouse`** parameterized by
  the catalog/storage binding. ADR-0022/0025/0026 become the **shared platform spec**.
- **`@databricks/sql` (interactive path) → legacy/removed.** Databricks remains the
  lakehouse + **Unity Catalog governance** + **marketplace** + **Spark bulk/analytics**
  plane for Ronin; it stops being the interactive FHIR query engine (which never needed
  Spark — delta-rs/DataFusion serves reads in ~4 ms, see the benchmark).
- RoninStandAlone is **already on the target platform**; this ADR is mostly a
  **migration direction for Ronin's interactive path** onto the shared engine.

## Why this is the best option (vs the alternatives)

- **(chosen) Share protocol tier + share engine** — collapses both products to one
  codebase + pluggable bindings. Eliminates the dual-dialect/dual-Warehouse corner.
  Databricks value preserved (governance, marketplace, Spark bulk).
- **Share protocol tier only, keep two engines** — rejected: leaves exactly the
  platform-fragmentation corner Chad wants to avoid (two SQL dialects + two storage
  code paths maintained in lockstep below the seam).
- **All-Databricks-SQL** — impossible (Standalone can't use Databricks).
- **Python-native / Rust-native servers** — rejected earlier (forks the protocol tier
  away from Ronin; see the runtime POC + benchmark note).

## Validation required before this is Accepted

A spike: **delta-rs / DataFusion against Databricks UC-managed Delta** —
- read + write/MERGE + commit coordination against UC-managed tables;
- credential vending via the `deltalake-catalog-unity` client (confirm it works on
  Databricks UC, not just UC-OSS);
- performance at Ronin scale for the interactive path.
If a UC-managed write path proves impractical, fallback: Ronin keeps Databricks SQL for
the interactive *write* path but still shares the protocol tier (partial alignment) —
explicitly the lesser outcome.

## Consequences

- Cross-product: Ronin migrates its interactive path off `@databricks/sql`; both
  products track one engine going forward. Needs a coordinated decision across the two
  repos (this ADR is the RoninStandAlone-side record + recommendation).
- The `Catalog` seam (ADR-0025) becomes the **primary product-differentiation point**
  (Databricks UC vs UC-OSS/path) — worth hardening first.
- Component hygiene: `@databricks/sql` is already flagged for removal from Standalone
  (disclosure review); under this ADR it becomes legacy for Ronin's interactive path too.

## Open questions

- UC-managed Delta write/commit via delta-rs on Databricks — the load-bearing
  unknown (the spike above).
- Whether Databricks customers contractually expect Databricks SQL compute for the
  interactive API (product/marketing question for Chad).
- Bulk/analytics tier: keep Spark on Databricks + delta-rs/Python on Standalone, or
  also converge later (out of scope here).
