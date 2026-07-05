/**
 * Deterministic MPI (ADR-0012 v1): identifier normalization, candidate components,
 * hard-deny guardrails (§3.4 safety floors), survivor selection, reference rewrite.
 */
import { describe, it, expect } from "vitest";
import { normalizeIdentifier, resolveIdentities, guardrail, rewriteReferences, type MpiPatientRow } from "../../src/repository/mpi.js";

const SSN = "http://hl7.org/fhir/sid/us-ssn";
const MRN = "urn:oid:1.2.840.114350";

const patient = (id: string, updated: string, body: Record<string, unknown>): MpiPatientRow => ({
  id, last_updated: updated, body: { resourceType: "Patient", id, ...body },
});
const withMrn = (id: string, updated: string, mrn: string, extra: Record<string, unknown> = {}) =>
  patient(id, updated, { identifier: [{ system: MRN, value: mrn }], ...extra });

describe("normalizeIdentifier", () => {
  it("canonicalizes URL systems and trims values", () => {
    expect(normalizeIdentifier("HTTP://Hospital.ORG/mrn/", " 123 ")).toBe("http://hospital.org/mrn|123");
  });
  it("collapses SSN formatting", () => {
    expect(normalizeIdentifier(SSN, "123-45-6789")).toBe(`${SSN}|123456789`);
  });
  it("null on empty value", () => {
    expect(normalizeIdentifier(MRN, "  ")).toBeNull();
  });
});

describe("resolveIdentities — deterministic dedup", () => {
  it("two patients sharing an MRN auto-merge; latest write survives", () => {
    const r = resolveIdentities([withMrn("a", "2026-01-01T00:00:00Z", "M1"), withMrn("b", "2026-02-01T00:00:00Z", "M1")]);
    expect(r.merges).toEqual([expect.objectContaining({ survivorId: "b", mergedId: "a" })]);
    expect(r.survivorOf.get("a")).toBe("b");
    expect(r.links.get(`${MRN}|M1`)).toBe("b");
  });

  it("distinct identifiers → no merge, links point at each record", () => {
    const r = resolveIdentities([withMrn("a", "2026-01-01T00:00:00Z", "M1"), withMrn("b", "2026-01-01T00:00:00Z", "M2")]);
    expect(r.merges).toHaveLength(0);
    expect(r.reviews).toHaveLength(0);
    expect(r.links.get(`${MRN}|M1`)).toBe("a");
    expect(r.links.get(`${MRN}|M2`)).toBe("b");
  });

  it("multi-match (3+ candidates) goes to review, never auto-merged (ADR §1)", () => {
    const r = resolveIdentities([
      withMrn("a", "1", "M1"), withMrn("b", "2", "M1"), withMrn("c", "3", "M1"),
    ]);
    expect(r.merges).toHaveLength(0);
    expect(r.reviews).toEqual([expect.objectContaining({ reason: "multi_match", ids: expect.arrayContaining(["a", "b", "c"]) })]);
  });

  it("sex mismatch guardrail blocks the merge → review", () => {
    const r = resolveIdentities([
      withMrn("a", "1", "M1", { gender: "female" }),
      withMrn("b", "2", "M1", { gender: "male" }),
    ]);
    expect(r.merges).toHaveLength(0);
    expect(r.reviews[0]).toMatchObject({ reason: "sex_mismatch" });
  });

  it("conflicting SSNs are HARD DISTINCT — no merge, no review (auto-create per ADR)", () => {
    const r = resolveIdentities([
      withMrn("a", "1", "M1", { identifier: [{ system: MRN, value: "M1" }, { system: SSN, value: "111-11-1111" }] }),
      withMrn("b", "2", "M1", { identifier: [{ system: MRN, value: "M1" }, { system: SSN, value: "222-22-2222" }] }),
    ]);
    expect(r.merges).toHaveLength(0);
    expect(r.reviews).toHaveLength(0);
  });

  it("date-of-death mismatch beyond the window → review", () => {
    const r = resolveIdentities([
      withMrn("a", "1", "M1", { deceasedDateTime: "2026-01-01" }),
      withMrn("b", "2", "M1", { deceasedDateTime: "2026-03-01" }),
    ]);
    expect(r.reviews[0]).toMatchObject({ reason: "date_of_death_mismatch" });
  });

  it("inactive (merged-away) patients are not candidates", () => {
    const r = resolveIdentities([withMrn("a", "1", "M1", { active: false }), withMrn("b", "2", "M1")]);
    expect(r.merges).toHaveLength(0);
    expect(r.reviews).toHaveLength(0);
  });

  it("gender unknown does not trip the sex guardrail", () => {
    expect(guardrail(
      withMrn("a", "1", "M1", { gender: "unknown" }),
      withMrn("b", "2", "M1", { gender: "female" }),
    )).toBeNull();
  });
});

describe("rewriteReferences", () => {
  it("rewrites merged Patient references to the survivor", () => {
    const body = JSON.stringify({ subject: { reference: "Patient/old" }, performer: [{ reference: "Patient/other" }] });
    const out = rewriteReferences(body, new Map([["old", "new"]]));
    expect(JSON.parse(out).subject.reference).toBe("Patient/new");
    expect(JSON.parse(out).performer[0].reference).toBe("Patient/other");
  });

  it("does NOT corrupt an unrelated id that has the merged id as a prefix (substring bug)", () => {
    // merge 123 → 999; Patient/1234 is a DIFFERENT patient and must be untouched.
    const body = JSON.stringify({ subject: { reference: "Patient/1234" }, basedOn: [{ reference: "Patient/123" }] });
    const out = JSON.parse(rewriteReferences(body, new Map([["123", "999"]])));
    expect(out.subject.reference).toBe("Patient/1234"); // NOT Patient/9994
    expect(out.basedOn[0].reference).toBe("Patient/999");
  });

  it("does not mutate free-text mentions, only reference fields", () => {
    const body = JSON.stringify({ subject: { reference: "Patient/old" }, note: [{ text: "see Patient/old chart" }] });
    const out = JSON.parse(rewriteReferences(body, new Map([["old", "new"]])));
    expect(out.subject.reference).toBe("Patient/new");
    expect(out.note[0].text).toBe("see Patient/old chart"); // free text left alone
  });

  it("rewrites versioned + absolute-URL references by exact id token", () => {
    const body = JSON.stringify({
      a: { reference: "Patient/old/_history/3" },
      b: { reference: "http://ex.org/fhir/Patient/old" },
      c: { reference: "http://ex.org/fhir/Patient/older" },
    });
    const out = JSON.parse(rewriteReferences(body, new Map([["old", "new"]])));
    expect(out.a.reference).toBe("Patient/new/_history/3");
    expect(out.b.reference).toBe("http://ex.org/fhir/Patient/new");
    expect(out.c.reference).toBe("http://ex.org/fhir/Patient/older"); // exact token, not substring
  });
});
