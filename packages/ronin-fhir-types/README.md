# @ronin/fhir-types

Generated FHIR types for the Ronin server. Per [`docs/research/2026-06-22-fhir-codegen-strategy.md`](../../docs/research/2026-06-22-fhir-codegen-strategy.md), this package replaces hand-rolled FHIR types in `packages/ronin-server-ts/src/lib/fhir-types.ts` with output from `@atomic-ehr/codegen` driven against the spec.

## What's generated

| Source IG | Status | Files |
|---|---|---|
| `hl7.fhir.r4.core@4.0.1` | ✅ committed | 196 files / ~13.5 kloc — every R4 resource, datatype, BackboneElement, type guard |
| `hl7.fhir.us.core@6.1.0` | follow-up | profiles + extensions; staged for v1.x |
| `hl7.fhir.us.core@9.0.0` | follow-up | forward rail per ADR-0014 |
| `hl7.fhir.us.carin-bb@2.2.0` | follow-up — blocked | upstream codegen tool can't resolve `CodeableReference` from `hl7.fhir.uv.extensions.r4#5.2.0`; needs tree-shake exclusion or upstream fix |
| `hl7.fhir.us.davinci-pdex@2.2.0` | follow-up |  |
| `hl7.fhir.us.davinci-hrex@1.1.0` | follow-up | `$member-match` Parameters + matched-Coverage + matched-Patient profiles |
| `hl7.fhir.us.insurance-card@1.1.0` | follow-up — opt-in | C4DIC digital insurance card |
| `hl7.fhir.us.davinci-pas@2.1.0` | follow-up | prior authorization workflow |

## Generated highlights

The R4 core output gives us the structural correctness gaps that hand-rolling missed:

- **Reference target types** — `Reference<"Organization">` instead of bare `Reference`.
- **Value-set binding enums** — `gender?: "male" | "female" | "other" | "unknown"` as TS literals, not free-form strings.
- **Language binding** — `CodeableConcept<("ar" | "bn" | "cs" | "da" | ... )>` materialized as string literal unions.
- **Type guards** — `isPatient(value)`, `isCoverage(value)`, etc., per resource.
- **Profile-helpers runtime** — slice/extension/choice-type utilities at `src/r4/profile-helpers.ts`.

## Usage from `ronin-server-ts`

```ts
import type {
  Patient,
  Coverage,
  ExplanationOfBenefit,
  Reference,
  Bundle,
  OperationOutcome,
  CapabilityStatement,
} from "@ronin/fhir-types";
import { isPatient, isCoverage } from "@ronin/fhir-types";
```

The shapes are stricter than the hand-rolled equivalents (reference target types + value-set enums), so the migration in `ronin-server-ts` will surface real type-correctness improvements as it rolls through.

## Regeneration

```bash
cd packages/ronin-fhir-types
npm run generate
```

The generator downloads packages from `https://packages.simplifier.net/` (the HL7-blessed npm-protocol mirror) into `.codegen-cache/`. Re-running is idempotent — file content is deterministic from inputs.

### Sandbox FD throttle

`preload-graceful-fs.cjs` is a callback-and-promise FS shim that caps concurrent `open`/`readFile` to `RONIN_FS_CONCURRENCY` (default 64). Necessary because Ronin's dev sandbox imposes a per-mount FD limit far lower than what `/proc/self/limits` reports; without the shim, the canonical-manager hits `EMFILE` partway through the cache populate.

### Why the cache survives `npm run clean`

`.codegen-cache/` is `.gitignore`'d and external to `src/`. Running `npm run clean` removes only `src/r4` (the generated output); the FHIR package cache stays primed so the next regeneration is fast.

## Architectural anchor

This package implements the strategy in [`docs/research/2026-06-22-fhir-codegen-strategy.md`](../../docs/research/2026-06-22-fhir-codegen-strategy.md) §3 — adopt `@atomic-ehr/codegen` (Health Samurai's continuation of `fhir-schema-codegen`). The same TypeSchema IR is the substrate for the future Silver-tier SQL transpiler per ADR-0015 §3 — one codegen pipeline produces both type artifacts and SQL validation artifacts.

The migration in `ronin-server-ts/` (replacing `lib/fhir-types.ts` + `repository/schemas.ts`) is queued as the next step; pre-migration the existing 177 tests continue to pass against the hand-rolled types unchanged.
