/**
 * Ronin FHIR types codegen driver.
 *
 * Reads FHIR core + the active-IG matrix from the package registry, runs the
 * @atomic-ehr/codegen TypeSchema pipeline, emits TypeScript interfaces +
 * profile classes (with `validate()` runtime checks) into `./src/r4/`.
 *
 * Per the strategy in docs/research/2026-06-22-fhir-codegen-strategy.md:
 *   - Generated output is committed; CI re-runs on IG bumps.
 *   - Single package today; per-IG split is OQ2 (deferred until customer demand).
 *   - Profile classes' `validate()` is the REST-boundary validator; Zod is decommissioned.
 *
 * Re-run:
 *     npm run generate
 *
 * Inspect what changed:
 *     git diff src/r4/
 *
 * The IG matrix matches ADR-0014's v1 floor catalog + v1.x forward rail.
 */

import { APIBuilder, prettyReport } from "@atomic-ehr/codegen";

const builder = new APIBuilder({
  // Default registry `https://fs.get-ig.org/pkgs/` is sometimes blocked by
  // corporate firewalls; Simplifier is the HL7-blessed alternative speaking
  // the npm registry protocol. Configurable via RONIN_FHIR_REGISTRY env.
  registry: process.env.RONIN_FHIR_REGISTRY ?? "https://packages.simplifier.net/",
})
  // --- R4 core (the floor) ---
  .fromPackage("hl7.fhir.r4.core", "4.0.1")

  // --- US Core 6.1.0 (v1 floor per ADR-0014 + CMS-0057-F minimum) ---
  .fromPackage("hl7.fhir.us.core", "6.1.0")

  // Staging: CARIN BB / US Core 9 / PDex / HRex / C4DIC / PAS land in
  // follow-up runs once the v1-floor pipeline + tests are verified. CARIN
  // BB 2.2.0 specifically depends on hl7.fhir.uv.extensions.r4#5.2.0 which
  // references CodeableReference (an R5-only datatype); needs a tree-shake
  // exclusion or a codegen-tool fix to land. Tracked as v1.x follow-up.
  // .fromPackage("hl7.fhir.us.core", "9.0.0")
  // .fromPackage("hl7.fhir.us.carin-bb", "2.2.0")
  // .fromPackage("hl7.fhir.us.davinci-pdex", "2.2.0")
  // .fromPackage("hl7.fhir.us.davinci-hrex", "1.1.0")
  // .fromPackage("hl7.fhir.us.insurance-card", "1.1.0")
  // .fromPackage("hl7.fhir.us.davinci-pas", "2.1.0")

  .typescript({
    generateProfile: true, // emit profile classes + validate()
    withDebugComment: false,
  })
  .outputTo("./src/r4")
  // Cowork sandbox doesn't permit removing files the host created — skip the
  // pre-clean. The generator overwrites in place; stale renames would need a
  // manual `npm run clean` (mapped to `rm -rf src/r4` from the host shell).
  .cleanOutput(false);

const report = await builder.generate();
console.log(prettyReport(report));
