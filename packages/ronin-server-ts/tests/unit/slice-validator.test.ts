/**
 * Slicing validation — precise unit tests against the real US Core VSCat slice
 * (Observation.category, value-discriminated on coding.code + coding.system).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { extractSlicings, validateSlices } from "../../src/validation/slice-validator.js";

const SD = process.env.US_CORE_RR ??
  "/Users/chad/.fhir/packages/hl7.fhir.us.core#6.1.0/package/StructureDefinition-us-core-respiratory-rate.json";
const VS_CAT_SYS = "http://terminology.hl7.org/CodeSystem/observation-category";

describe.skipIf(!existsSync(SD))("slice-validator (US Core VSCat)", () => {
  const sd = JSON.parse(readFileSync(SD, "utf8"));
  const slicings = extractSlicings(sd.snapshot);
  const cat = slicings.find((s) => s.path === "Observation.category");

  it("extracts the required VSCat slice + its discriminator fixed values", () => {
    expect(cat).toBeTruthy();
    const vscat = cat!.slices.find((s) => s.sliceName === "VSCat")!;
    expect(vscat).toBeTruthy();
    expect(vscat.min).toBe(1);
    expect(vscat.discriminators.find((d) => d.path === "coding.code")!.value).toBe("vital-signs");
    expect(vscat.discriminators.find((d) => d.path === "coding.system")!.value).toBe(VS_CAT_SYS);
  });

  const vscatIssues = (obs: any) => validateSlices(obs, slicings).filter((i) => i.message.includes("VSCat"));

  it("passes when the required slice is present", () => {
    const obs = { resourceType: "Observation", category: [{ coding: [{ system: VS_CAT_SYS, code: "vital-signs" }] }] };
    expect(vscatIssues(obs).length).toBe(0);
  });

  it("fails when the array is present but the slice's coding is absent", () => {
    const obs = { resourceType: "Observation", category: [{ coding: [{ system: "urn:x", code: "other" }] }] };
    expect(vscatIssues(obs).length).toBe(1);
  });

  it("fails when the sliced array is absent entirely", () => {
    expect(vscatIssues({ resourceType: "Observation" }).length).toBe(1);
  });
});
