/**
 * Slicing validation — precise unit tests against the real US Core VSCat slice
 * (Observation.category, value-discriminated on coding.code + coding.system).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { extractSlicings, validateSlices } from "../../src/validation/slice-validator.js";

const SD = process.env.US_CORE_RR ??
  `${process.env.HOME}/.fhir/packages/hl7.fhir.us.core#6.1.0/package/StructureDefinition-us-core-respiratory-rate.json`;
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

describe("slice-validator — max + closed rules (synthetic snapshot)", () => {
  const snapshot = {
    element: [
      { id: "Observation.category", path: "Observation.category",
        slicing: { rules: "closed", discriminator: [{ type: "pattern", path: "coding.code" }] } },
      { id: "Observation.category:VSCat", path: "Observation.category", sliceName: "VSCat", min: 1, max: "1" },
      { id: "Observation.category:VSCat.coding.code", path: "Observation.category.coding.code", fixedCode: "vital-signs" },
      { id: "Observation.category:Lab", path: "Observation.category", sliceName: "Lab", min: 0, max: "*" },
      { id: "Observation.category:Lab.coding.code", path: "Observation.category.coding.code", fixedCode: "laboratory" },
    ],
  };
  const cat = (code: string) => ({ coding: [{ code }] });
  const obs = (...codes: string[]) => ({ resourceType: "Observation", id: "o", category: codes.map(cat) });
  const slicings = extractSlicings(snapshot);

  it("extracts min/max/closed from the snapshot", () => {
    expect(slicings).toHaveLength(1);
    expect(slicings[0]!.closed).toBe(true);
    const vscat = slicings[0]!.slices.find((s: any) => s.sliceName === "VSCat") as any;
    expect(vscat.min).toBe(1);
    expect(vscat.max).toBe(1);
  });

  it("passes a conformant instance (one VSCat, any number of Lab)", () => {
    expect(validateSlices(obs("vital-signs", "laboratory", "laboratory"), slicings)).toEqual([]);
  });

  it("enforces max: two VSCat matches exceed max 1", () => {
    const issues = validateSlices(obs("vital-signs", "vital-signs"), slicings);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain("max 1");
  });

  it("enforces closed rules: an element matching no defined slice fails", () => {
    const issues = validateSlices(obs("vital-signs", "social-history"), slicings);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain("closed slicing violated");
  });

  it("closed is NOT enforced when any slice's discriminators are unsupported", () => {
    const partial = extractSlicings({
      element: [
        { id: "Observation.category", path: "Observation.category",
          slicing: { rules: "closed", discriminator: [{ type: "pattern", path: "coding.code" }] } },
        { id: "Observation.category:VSCat", path: "Observation.category", sliceName: "VSCat", min: 1, max: "1" },
        { id: "Observation.category:VSCat.coding.code", path: "Observation.category.coding.code", fixedCode: "vital-signs" },
        // A slice whose discriminator value can't be extracted → conservatively open.
        { id: "Observation.category:Mystery", path: "Observation.category", sliceName: "Mystery", min: 0, max: "*" },
      ],
    });
    expect(partial[0]!.closed).toBe(false);
    expect(validateSlices(obs("vital-signs", "social-history"), partial)).toEqual([]); // stray tolerated
  });

  it("open slicing rules never produce closed violations", () => {
    const open = extractSlicings({
      element: [
        { id: "Observation.category", path: "Observation.category",
          slicing: { rules: "open", discriminator: [{ type: "pattern", path: "coding.code" }] } },
        { id: "Observation.category:VSCat", path: "Observation.category", sliceName: "VSCat", min: 1, max: "1" },
        { id: "Observation.category:VSCat.coding.code", path: "Observation.category.coding.code", fixedCode: "vital-signs" },
      ],
    });
    expect(open[0]!.closed).toBe(false);
    expect(validateSlices(obs("vital-signs", "anything-else"), open)).toEqual([]);
  });
});
