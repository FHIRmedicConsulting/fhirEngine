/**
 * VSAC client — unit tests with a mocked fetch (no network, no real key). Verifies the
 * Basic apikey auth header, the $expand URL, and expansion parsing.
 */
import { describe, it, expect } from "vitest";
import { vsacExpand, parseExpansion } from "../../src/terminology/sources/vsac.js";

const EXPAND_RESPONSE = {
  resourceType: "ValueSet",
  url: "http://cts.nlm.nih.gov/fhir/ValueSet/2.16.840.1.113762.1.4.1",
  version: "20260101",
  expansion: {
    contains: [
      { system: "http://snomed.info/sct", code: "73211009", display: "Diabetes mellitus" },
      { system: "http://loinc.org", code: "4548-4", display: "Hemoglobin A1c" },
      { code: "no-system-still-ok" },
    ],
  },
};

describe("VSAC client", () => {
  it("parses an $expand response into rows (display falls back to code)", () => {
    const rows = parseExpansion(EXPAND_RESPONSE, "fallback");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ valueset: EXPAND_RESPONSE.url, system: "http://snomed.info/sct", code: "73211009" });
    expect(rows[2].display).toBe("no-system-still-ok"); // display defaults to code
  });

  it("sends Basic apikey auth + the $expand URL, never leaking the key in errors", async () => {
    let seenUrl = "", seenAuth = "";
    const mockFetch = (async (url: string, init: any) => {
      seenUrl = url; seenAuth = init.headers.Authorization;
      return { ok: true, status: 200, json: async () => EXPAND_RESPONSE } as any;
    }) as unknown as typeof fetch;

    const rows = await vsacExpand("2.16.840.1.113762.1.4.1", { apiKey: "FAKEKEY", fetchImpl: mockFetch });
    expect(seenUrl).toContain("/ValueSet/2.16.840.1.113762.1.4.1/$expand");
    expect(seenAuth).toBe("Basic " + Buffer.from("apikey:FAKEKEY").toString("base64"));
    expect(rows).toHaveLength(3);
  });

  it("throws a key-free error on HTTP failure", async () => {
    const mockFetch = (async () => ({ ok: false, status: 401, json: async () => ({}) } as any)) as unknown as typeof fetch;
    await expect(vsacExpand("oid", { apiKey: "SECRET", fetchImpl: mockFetch })).rejects.toThrow(/HTTP 401/);
    await expect(vsacExpand("oid", { apiKey: "SECRET", fetchImpl: mockFetch })).rejects.not.toThrow(/SECRET/);
  });

  it("requires a key", async () => {
    await expect(vsacExpand("oid", { apiKey: "" })).rejects.toThrow(/UMLS_API_KEY/);
  });
});
