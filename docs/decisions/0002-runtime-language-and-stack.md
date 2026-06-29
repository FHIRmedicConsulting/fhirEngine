# ADR-0002: Runtime Language and Stack

- Status: **Rejected** (originally drafted as Proposed 2026-06-17; rejected same day after ADR-0001 review)
- Date: 2026-06-17
- Decider(s): Chad
- Session: 002 (drafted), 003 (rejected)
- Supersedes: —
- Superseded by: **[ADR-0029](0029-runtime-and-stack.md)** (Runtime & Stack, Accepted 2026-06-28) — the long-queued replacement; ratifies TS/Node + Hono for RoninStandAlone.
- Related: [ADR-0001](0001-vision-and-scope.md), [docs/reference/pathling-architecture.md](../reference/pathling-architecture.md), [docs/research/2026-06-17-pathling-deep-read.md](../research/2026-06-17-pathling-deep-read.md)

## Rejection rationale (2026-06-17)

The premise of this ADR — consume Pathling as Ronin's primary engine — does not satisfy Ronin's multi-version FHIR requirement (R4 floor with R4B/R5 served concurrently, R6 ingestion path required as it lands). Pathling hardcodes `FhirVersionEnum.R4` across encoders, conversion support, terminology factory, and search; lifting that requires upstream CSIRO work or a deep fork. Either path gates Ronin's FHIR-version roadmap on a third party's cadence — explicitly disqualified during the ADR-0001 review.

Secondary factor: rapid iteration is a Ronin design principle; consuming a JVM/Spark/Maven-multi-module dependency would slow the foundational iteration loop and lock the operational tier into Pathling's Bunsen-shaped encoder schema, which is incompatible with the dbignite/Google-Parquet-on-FHIR direction Ronin is taking.

This document is preserved in the ADR record so the analysis stays available, but **do not act on its recommendations**. The Pathling architecture reference (`docs/reference/pathling-architecture.md`) and the deep-read research note (`docs/research/2026-06-17-pathling-deep-read.md`) remain valid as field reconnaissance.

## Context

ADR-0001 locked in the vision but left the runtime open. Session 001 queued ADR-0002 with the recommendation to do a Pathling deep code read first, because every later ADR (catalog, history, search, auth, Iceberg) depends on the language/stack the server runs in.

Session 002 read the Pathling repository at `aehrc/pathling@main` (commit `d119859f`). The full findings are in [docs/research/2026-06-17-pathling-deep-read.md](../research/2026-06-17-pathling-deep-read.md). Three findings reshape the decision:

1. **Pathling has a clean library boundary.** `library-api` is an explicit public-API contract. The `server` module is independently versioned (v2.0.1 vs. library v9.7.1) and consumes `library-runtime` as a Maven dependency. Artifacts ship to Maven Central under `au.csiro.pathling:*`. The choice is therefore not "fork or don't fork" but "fork or **consume as a dependency**" — and consume dominates fork on every dimension I can see for v1.
2. **Pathling already implements most of Ronin's v1 surface.** CRUD, search (standard + FHIRPath-named-query), Bulk Export, Bulk Import, SoF v2 ViewDefinition `$run`/`$export`/`$instance`, SMART configuration, async jobs, Delta storage. Conformance-tested SoF v2 runner alone is hundreds of person-days of work.
3. **R4 is hardcoded across Pathling.** Encoders, search loader, terminology factory, conversion support all gate on `FhirVersionEnum.R4`. R5 would require deep upstream changes. Consuming Pathling means v1 ships R4-only.

What Pathling does **not** provide that Ronin v1 needs: FHIR history/versioning at storage, US Core conformance, dbignite Gold-model projection, Iceberg, first-class catalog integration. None of these are language-blocked — they are work Ronin owns on top of the libraries.

## Decision

1. **Primary language: Java 21.** Matches Pathling, HAPI FHIR, and the dominant FHIR-server ecosystem. Scala 2.13 used **only** where Spark-native code is unavoidable (custom Catalyst expressions, custom `Encoder`s) and kept behind Java-facing interfaces.
2. **Runtime: JVM with Apache Spark 4.x and Delta Lake 4.x**, tracking Pathling's versions. Single-binary deployment via a Spring Boot fat-jar.
3. **Build tool: Maven**, matching Pathling and HAPI ergonomics. Multi-module reactor under a root `pom.xml`.
4. **Pathling integration: consume as Maven dependencies, do not fork.** Specifically: `au.csiro.pathling:library-runtime`, `:fhirpath`, `:encoders`, `:terminology`. Ronin writes its own server module (REST surface, auth, history layer, dbignite projection) on top of `library-api`.
5. **REST framework: Spring Boot 3.5+ with HAPI FHIR Plain Server**, matching Pathling. A future ADR may revisit this if startup-time, memory, or native-image requirements push us toward Quarkus or Micronaut — but the default is Spring Boot until evidence says otherwise.
6. **FHIR version scope of v1: R4 only.** This is a clarification of ADR-0001, which said "R4/R5" without pinning v1. R5 becomes a v2 workstream; Ronin can pursue R5 independently of Pathling because Ronin owns the server layer.

## Consequences

- v1 ships R4-only. R5 is not on the v1 roadmap and is unblocked by Pathling only at the server layer — to support R5 end-to-end Ronin must either (a) wait for upstream Pathling R5 support, (b) fork the relevant Pathling modules at that point, or (c) write a Ronin-native R5 path that bypasses Pathling encoders. Defer to a future ADR.
- Ronin inherits Pathling's runtime footprint: JVM, Spark cluster (or local mode), Delta. This is heavier than a Rust/Go single binary; the trade is that we get encoders + FHIRPath + SoF v2 + Delta plumbing in week one instead of year two.
- Ronin tracks Pathling releases (monthly, third Tuesday). We pin versions in our pom and upgrade deliberately. If CSIRO de-prioritizes the project, Ronin can fork at the point of need with full code understanding accumulated.
- **Schema reconciliation between Pathling encoders and the dbignite Gold model is unresolved** and is the most important load-bearing follow-up. ADR-0001 mandates dbignite as the canonical Gold model and forbids a second physical model; Pathling writes Bunsen-lineage HAPI-encoded structs. This tension belongs in ADR-0004 or a new ADR-0004a. Possible resolutions: project dbignite-shaped views via SoF v2 over Pathling-encoded raw tables (requires amending ADR-0001 to allow a raw + projected two-layer model), implement Ronin's own `DataSource`/`DataSink` against dbignite-shaped tables (we lose Pathling's encoder), or fork the encoders module (most invasive).
- History/versioning on Delta is unresolved — Pathling stores latest-only. Belongs in ADR-0004.
- Catalog choice (Unity Catalog OSS / Polaris / Hive / Nessie) is unresolved; Pathling assumes filesystem-Delta. Belongs in ADR-0003.
- Spring Security OAuth2 resource-server posture is inherited from Pathling. ADR-0006 still owes a decision on SMART on FHIR specifics (Keycloak vs. external IdP, scope grammar).
- Iceberg compatibility is not free under this stack — Delta-on-Spark is what Pathling supports. ADR-0007 still owes a decision (dual-write, table-format translation, or accept Delta-only for v1).

## Alternatives considered

### A. Fork Pathling

Carry our own branch of Pathling and modify in place. **Rejected.** Maintenance burden begins on day one with no v1 benefit that consuming-as-library doesn't already provide. Pathling's library boundary is good enough that we don't need fork access. Revisit only if Ronin needs to modify encoders/fhirpath internals — possible but not predicted for v1, and a clean trigger to convert at that point.

### B. Clean-room build in Rust

Single binary, no JVM, memory safety, easier multi-cloud. **Rejected for v1.** Mature FHIR encoding to Delta does not exist in Rust. FHIRPath libraries are immature. No SoF v2 ViewDefinition runner. No equivalent of HAPI FHIR. Estimated 12–24 months to reach functional parity with what Pathling-as-a-dep gives us in week one. Worth re-evaluating for a v2 or v3 "native server" track if the Rust health-data ecosystem matures.

### C. Clean-room build in Go

Same gap as Rust on Delta + FHIRPath + SoF v2. Better cloud SDK story doesn't compensate. **Rejected** for the same reasons as Rust, with slightly less upside.

### D. Scala-Spark-native

Native to the lakehouse, full Java interop for HAPI. **Rejected.** Smaller talent pool than Java, and the end result looks a lot like Pathling without the benefit of Maven Central artifact reuse. Scala stays in the toolbox for narrow Spark-native code paths.

### E. JVM but use Quarkus / Micronaut instead of Spring Boot

Lighter footprint, better native-image story. **Deferred, not rejected.** Spring Boot is the path of least friction with HAPI FHIR Plain Server and matches Pathling's server. We can revisit if startup-time or memory budgets become a constraint, behind a dedicated ADR.

## Follow-up ADRs queued or affected

- **ADR-0003 Catalog choice** (still queued; Pathling provides no opinion).
- **ADR-0004 History/versioning model on Delta** (Pathling does not provide).
- **ADR-0004a (or revised 0004) dbignite vs. Pathling encoder schema reconciliation** — this is the load-bearing tension introduced by combining ADR-0001 (dbignite canonical, no second physical model) with this ADR (consume Pathling). Needs to come before any production schema is written.
- **ADR-0005 Search index strategy** (Pathling's FHIRPath search uses Spark scans — fine for analytics, possibly insufficient for low-latency single-resource reads).
- **ADR-0006 SMART on FHIR auth specifics** (Pathling supplies the resource-server skeleton; choices on IdP and scope grammar remain).
- **ADR-0007 Iceberg compatibility** (Pathling is Delta-only; we either dual-write, translate, or accept Delta-only for v1).
- **Server framework revisit** (Spring Boot is default; Quarkus/Micronaut is a re-evaluation trigger, not a queued ADR yet).
