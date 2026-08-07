/**
 * `POST /Patient/$match` (FHIR R4 patient-match operation) — probabilistic MPI query.
 *
 *   in : Parameters { resource: Patient (the seed), onlyCertainMatches?: boolean, count?: integer }
 *   out: searchset Bundle — candidate Patients graded by match confidence:
 *          entry.search.mode = "match",
 *          entry.search.score = 0..1 (logistic of the Fellegi-Sunter weight),
 *          entry.search.extension[match-grade] = certain | probable | possible | certainly-not.
 *
 * Candidates come from demographic BLOCKING (family+birth-year, family+given-initial, phone,
 * dob+postal) so we score a bounded set, not the whole Patient table. `certainly-not` results
 * are dropped; `onlyCertainMatches=true` keeps only `certain`.
 */
import type { Hono } from "hono";
import type { DeltaWarehouse } from "../lib/delta-warehouse.js";
import { DeltaResourceRepository } from "../repository/delta-resource-repository.js";
import type { Resource as FhirResource } from "@fhirengine/fhir-types";
import { scorePair, blockingKeys, extractDemographics, type MatchGrade } from "../repository/mpi-probabilistic.js";

const MATCH_GRADE_URL = "http://hl7.org/fhir/StructureDefinition/match-grade";

function oo(code: string, diagnostics: string): Record<string, unknown> {
  return { resourceType: "OperationOutcome", issue: [{ severity: "error", code, diagnostics }] };
}

function seedFromBody(body: unknown): Record<string, unknown> | null {
  if ((body as { resourceType?: string })?.resourceType !== "Parameters") return null;
  const params = ((body as { parameter?: Array<Record<string, unknown>> }).parameter) ?? [];
  const res = params.find((p) => p.name === "resource")?.resource;
  return res && (res as { resourceType?: string }).resourceType === "Patient" ? (res as Record<string, unknown>) : null;
}
function boolParam(body: unknown, name: string): boolean {
  const params = ((body as { parameter?: Array<Record<string, unknown>> }).parameter) ?? [];
  return params.find((p) => p.name === name)?.valueBoolean === true;
}
function intParam(body: unknown, name: string): number | undefined {
  const params = ((body as { parameter?: Array<Record<string, unknown>> }).parameter) ?? [];
  const v = params.find((p) => p.name === name)?.valueInteger;
  return typeof v === "number" ? v : undefined;
}

export function mountPatientMatch(app: Hono, wh: DeltaWarehouse): void {
  const patients = () => new DeltaResourceRepository(wh, "Patient");

  /** Gather candidate patients that share ≥1 blocking key with the seed (bounded fan-out). */
  const candidates = async (seed: Record<string, unknown>): Promise<FhirResource[]> => {
    const d = extractDemographics(seed);
    const seen = new Map<string, FhirResource>();
    const add = (rs: FhirResource[]) => { for (const r of rs) if (r.id) seen.set(r.id, r); };
    // Block on family (string prefix) and birthDate (exact) — cheap, indexed searches whose
    // union covers the blocking keys; we re-block precisely in-memory before scoring.
    if (d.family) add((await patients().searchByParams({ conds: [{ code: "family", type: "string", value: d.family }], count: 500, offset: 0 })).resources);
    if (d.birthDate) add((await patients().searchByParams({ conds: [{ code: "birthdate", type: "date", op: "=", value: d.birthDate }], count: 500, offset: 0 })).resources);
    for (const phone of d.phones) add((await patients().searchByParams({ conds: [{ code: "phone", type: "token", value: phone }], count: 200, offset: 0 })).resources);

    const seedBlocks = new Set(blockingKeys(seed));
    return [...seen.values()].filter((c) => {
      if (c.id === seed.id) return false; // never match the seed to itself
      return blockingKeys(c as unknown as Record<string, unknown>).some((k) => seedBlocks.has(k));
    });
  };

  app.post("/Patient/$match", async (c) => {
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json(oo("invalid", "request body must be a Parameters resource"), 400); }
    const seed = seedFromBody(body);
    if (!seed) return c.json(oo("invalid", "$match requires Parameters with a `resource` of type Patient"), 400);

    const onlyCertain = boolParam(body, "onlyCertainMatches");
    const count = Math.max(1, Math.min(intParam(body, "count") ?? 10, 100));

    const scored = (await candidates(seed))
      .map((cand) => ({ cand, score: scorePair(seed, cand as unknown as Record<string, unknown>) }))
      .filter((s) => s.score.grade !== "certainly-not")
      .filter((s) => !onlyCertain || s.score.grade === "certain")
      .sort((a, b) => b.score.weight - a.score.weight)
      .slice(0, count);

    const entry = scored.map(({ cand, score }) => ({
      fullUrl: `Patient/${cand.id}`,
      resource: cand,
      search: {
        mode: "match",
        score: Number(score.probability.toFixed(4)),
        extension: [{ url: MATCH_GRADE_URL, valueCode: score.grade as MatchGrade }],
      },
    }));

    return c.json({ resourceType: "Bundle", type: "searchset", total: entry.length, entry }, 200);
  });
}
