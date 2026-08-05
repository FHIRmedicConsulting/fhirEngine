import { describe, it, expect } from "vitest";
import { buildSearchIndex, type SearchIndexEntry } from "../../src/repository/search-index.js";
import { extractIdentifiers, bronzeRow } from "../../src/repository/ingest.js";
import type { Resource as FhirResource } from "@fhirengine/fhir-types";

const rows = (entries: SearchIndexEntry[], code: string) => entries.filter((e) => e.code === code);
const values = (entries: SearchIndexEntry[], code: string) => rows(entries, code).map((e) => e.value);

describe("buildSearchIndex", () => {
  const patient = {
    resourceType: "Patient",
    id: "p1",
    active: true,
    identifier: [{ system: "urn:mrn", value: "MRN-1234", type: { coding: [{ code: "MR" }] } }],
    name: [{ family: "Rivera", given: ["Ana", "Luz"], text: "Ana Rivera" }],
    telecom: [{ system: "phone", value: "555-0100" }, { system: "email", value: "ana@example.org" }],
    gender: "female",
    birthDate: "1987-04-12",
    address: [{ city: "Springfield", line: ["12 Main St"] }],
  };

  it("token: bare code element (gender)", () => {
    const idx = buildSearchIndex(patient);
    expect(rows(idx, "gender")).toEqual([{ code: "gender", system: "", value: "female" }]);
  });

  it("token: boolean element (active) is stringified", () => {
    expect(values(buildSearchIndex(patient), "active")).toEqual(["true"]);
  });

  it("token: Identifier yields system+value", () => {
    expect(rows(buildSearchIndex(patient), "identifier")).toEqual([
      { code: "identifier", system: "urn:mrn", value: "MRN-1234" },
    ]);
  });

  it("token: ContactPoint value indexed for telecom, and filtered params (email/phone) resolve", () => {
    const idx = buildSearchIndex(patient);
    expect(values(idx, "telecom")).toEqual(expect.arrayContaining(["555-0100", "ana@example.org"]));
    expect(values(idx, "phone")).toEqual(["555-0100"]);
    expect(values(idx, "email")).toEqual(["ana@example.org"]);
  });

  it("string: HumanName flattens to lowercased leaf strings for case-insensitive match", () => {
    const idx = buildSearchIndex(patient);
    expect(values(idx, "family")).toEqual(["rivera"]);
    expect(values(idx, "given")).toEqual(expect.arrayContaining(["ana", "luz"]));
    expect(values(idx, "name")).toEqual(expect.arrayContaining(["rivera", "ana", "luz", "ana rivera"]));
  });

  it("string: Address sub-element (address-city) is indexed lowercased", () => {
    expect(values(buildSearchIndex(patient), "address-city")).toEqual(["springfield"]);
  });

  it("date: bare date string (birthdate) indexes directly", () => {
    expect(values(buildSearchIndex(patient), "birthdate")).toEqual(["1987-04-12"]);
  });

  it("token: CodeableConcept expands every coding with its system", () => {
    const condition = {
      resourceType: "Condition",
      id: "c1",
      code: {
        coding: [
          { system: "http://snomed.info/sct", code: "38341003" },
          { system: "http://hl7.org/fhir/sid/icd-10-cm", code: "I10" },
        ],
      },
      subject: { reference: "Patient/p1" },
      onsetDateTime: "2023-06-01T08:00:00Z",
    };
    const idx = buildSearchIndex(condition);
    expect(rows(idx, "code")).toEqual([
      { code: "code", system: "http://snomed.info/sct", value: "38341003" },
      { code: "code", system: "http://hl7.org/fhir/sid/icd-10-cm", value: "I10" },
    ]);
  });

  it("date: choice type onsetDateTime indexes under onset-date", () => {
    const condition = {
      resourceType: "Condition", id: "c1",
      onsetDateTime: "2023-06-01T08:00:00Z",
    };
    expect(values(buildSearchIndex(condition), "onset-date")).toEqual(["2023-06-01T08:00:00Z"]);
  });

  it("date: choice type onsetPeriod indexes BOTH start and end (range/prefix matches)", () => {
    const condition = {
      resourceType: "Condition", id: "c2",
      onsetPeriod: { start: "2023-01-01", end: "2023-03-31" },
    };
    expect(values(buildSearchIndex(condition), "onset-date")).toEqual(["2023-01-01", "2023-03-31"]);
  });

  it("date: Encounter.period (Period-typed date param) indexes start and end", () => {
    const encounter = {
      resourceType: "Encounter", id: "e1",
      period: { start: "2024-02-01T09:00:00Z", end: "2024-02-01T11:30:00Z" },
      subject: { reference: "Patient/p1" },
    };
    const idx = buildSearchIndex(encounter);
    expect(values(idx, "date")).toEqual(["2024-02-01T09:00:00Z", "2024-02-01T11:30:00Z"]);
  });

  it("reference: simple .reference is indexed", () => {
    const encounter = { resourceType: "Encounter", id: "e1", subject: { reference: "Patient/p1" } };
    expect(rows(buildSearchIndex(encounter), "subject")).toEqual([
      { code: "subject", system: "", value: "Patient/p1" },
    ]);
  });

  it("quantity: Observation.valueQuantity indexes numeric value with unit system", () => {
    const obs = {
      resourceType: "Observation", id: "o1", status: "final",
      code: { coding: [{ system: "http://loinc.org", code: "8480-6" }] },
      subject: { reference: "Patient/p1" },
      effectiveDateTime: "2024-03-01T10:00:00Z",
      valueQuantity: { value: 128, unit: "mmHg", system: "http://unitsofmeasure.org", code: "mm[Hg]" },
    };
    const idx = buildSearchIndex(obs);
    expect(rows(idx, "value-quantity")).toEqual([
      { code: "value-quantity", system: "http://unitsofmeasure.org", value: "128" },
    ]);
    expect(values(idx, "date")).toEqual(["2024-03-01T10:00:00Z"]);
  });

  it("absent elements produce no entries (no empty/null values ever indexed)", () => {
    const idx = buildSearchIndex({ resourceType: "Patient", id: "p2" });
    expect(idx.every((e) => e.value !== "" && e.value !== "undefined" && e.value !== "null")).toBe(true);
    expect(values(idx, "birthdate")).toEqual([]);
    expect(values(idx, "family")).toEqual([]);
  });

  it("unknown resource type yields an empty index, not a crash", () => {
    expect(buildSearchIndex({ resourceType: "NotAResource", id: "x" })).toEqual([]);
  });
});

describe("extractIdentifiers", () => {
  it("extracts system, value, and type code from each identifier", () => {
    const ids = extractIdentifiers({
      resourceType: "Patient", id: "p1",
      identifier: [
        { system: "urn:mrn", value: "MRN-1", type: { coding: [{ code: "MR" }] } },
        { system: "urn:ssn", value: "999-00-1111" },
      ],
    } as unknown as FhirResource);
    expect(ids).toEqual([
      { system: "urn:mrn", value: "MRN-1", typeCode: "MR" },
      { system: "urn:ssn", value: "999-00-1111", typeCode: null },
    ]);
  });

  it("keeps identifiers that carry only a system or only a value", () => {
    const ids = extractIdentifiers({
      resourceType: "Patient", id: "p1",
      identifier: [{ system: "urn:only-system" }, { value: "only-value" }],
    } as unknown as FhirResource);
    expect(ids).toEqual([
      { system: "urn:only-system", value: "", typeCode: null },
      { system: "", value: "only-value", typeCode: null },
    ]);
  });

  it("skips malformed entries and handles missing/non-array identifier", () => {
    expect(extractIdentifiers({ resourceType: "Patient", id: "p1" } as unknown as FhirResource)).toEqual([]);
    expect(extractIdentifiers({ resourceType: "Patient", id: "p1", identifier: "nope" } as unknown as FhirResource)).toEqual([]);
    expect(extractIdentifiers({
      resourceType: "Patient", id: "p1",
      identifier: [null, 42, {}, { system: "urn:ok", value: "v" }],
    } as unknown as FhirResource)).toEqual([{ system: "urn:ok", value: "v", typeCode: null }]);
  });
});

describe("bronzeRow", () => {
  const patient = {
    resourceType: "Patient", id: "p1",
    identifier: [{ system: "urn:mrn", value: "MRN-1" }],
    name: [{ family: "Rivera" }],
  } as unknown as FhirResource;

  it("materializes the full Bronze row: body, identifier index, search index, flags", () => {
    const row = bronzeRow(patient, 3, "2024-05-01T00:00:00.000Z", false);
    expect(row.id).toBe("p1");
    expect(row.version_id).toBe(3);
    expect(row.last_updated).toBe("2024-05-01T00:00:00.000Z");
    expect(row.deleted).toBe(false);
    expect(row.is_current).toBe(true);
    expect(row._ingest_source).toBe("fhirengine");
    expect(JSON.parse(row.body_json)).toEqual(patient);
    expect(row.identifier_index).toEqual([{ system: "urn:mrn", value: "MRN-1", typeCode: null }]);
    expect(row.search_param_index).toEqual(
      expect.arrayContaining([{ code: "family", system: "", value: "rivera" }]),
    );
  });

  it("a delete tombstone keeps the same index shape with deleted=true", () => {
    const row = bronzeRow(patient, 4, "2024-05-02T00:00:00.000Z", true);
    expect(row.deleted).toBe(true);
    expect(row.is_current).toBe(true);
    expect(row.version_id).toBe(4);
  });
});
