/** PathCatalog topology mapping — provisioning data follows single vs medallion. */
import { describe, it, expect } from "vitest";
import { PathCatalog } from "../../src/lib/catalog.js";

describe("PathCatalog storage topology", () => {
  it("single store keeps provisioning data directly under the base", () => {
    const c = new PathCatalog("/data", "single");
    expect(c.terminologyPath("codesystem_concept")).toBe("/data/terminology/codesystem_concept");
    expect(c.conformancePath("structuredefinition")).toBe("/data/conformance/structuredefinition");
  });

  it("medallion lands provisioning data under gold/ (Gold-only, no Bronze raw)", () => {
    const c = new PathCatalog("/data", "medallion");
    expect(c.terminologyPath("codesystem_concept")).toBe("/data/gold/terminology/codesystem_concept");
    expect(c.conformancePath("structuredefinition")).toBe("/data/gold/conformance/structuredefinition");
  });

  it("defaults to single", () => {
    expect(new PathCatalog("/data").terminologyPath("x")).toBe("/data/terminology/x");
  });

  it("tier table paths are unaffected by mode", () => {
    expect(new PathCatalog("/data", "medallion").tablePath("bronze", "Patient")).toBe("/data/bronze/patient");
  });
});
