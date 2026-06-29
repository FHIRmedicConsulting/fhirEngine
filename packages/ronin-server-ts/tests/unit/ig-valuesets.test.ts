/** collectBoundValueSets — reads an IG package's SD bindings (the input to pull-once-at-load). */
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { collectBoundValueSets } from "../../src/terminology/ig-valuesets.js";

const US = process.env.US_CORE_DIR ?? "/Users/chad/.fhir/packages/hl7.fhir.us.core#6.1.0/package";

describe.skipIf(!existsSync(US))("collectBoundValueSets (US Core)", () => {
  const bound = collectBoundValueSets(US);
  it("collects bound value sets including external VSAC canonicals", () => {
    expect(bound.size).toBeGreaterThan(150);
    expect([...bound].some((u) => u.includes("cts.nlm.nih.gov"))).toBe(true);
    expect(bound.has("http://cts.nlm.nih.gov/fhir/ValueSet/2.16.840.1.113883.11.20.9.38")).toBe(true); // smoking status
  });
  it("strips version pipes from canonicals", () => {
    expect([...bound].every((u) => !u.includes("|"))).toBe(true);
  });
});
