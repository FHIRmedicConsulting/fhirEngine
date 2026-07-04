/**
 * Da Vinci HRex `Patient/$member-match` (CMS-0057 Payer-to-Payer, first slice). A payer submits a
 * member's demographics (MemberPatient) + their coverage (CoverageToMatch); we match to a single
 * local Patient and return its member identifier. A unique match is required — zero or multiple
 * matches are a 422 (per HRex).
 *
 *   POST /Patient/$member-match
 *     in : Parameters { MemberPatient: Patient, CoverageToMatch: Coverage, CoverageToLink?: Coverage }
 *     out: Parameters { MemberIdentifier: Patient }   (the matched patient + its identifiers)
 *
 * Matching: identifiers first (MemberPatient.identifier + Coverage.subscriberId), then demographics
 * (family + birthDate + gender). This operation returns only the identifier; consent for the
 * subsequent clinical pull ($everything/$export) is enforced there (ADR-0030). A first slice —
 * probabilistic/MPI matching + a consent gate on the match itself are follow-ups.
 */
import type { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { DeltaResourceRepository } from "../repository/delta-resource-repository.js";
import type { DeltaWarehouse } from "../lib/delta-warehouse.js";
import type { SearchCondition } from "../repository/delta-resource-repository.js";
import type { Resource as FhirResource } from "@ronin/fhir-types";

interface Identifier { system?: string; value?: string }
interface MemberPatient { resourceType: string; identifier?: Identifier[]; name?: Array<{ family?: string }>; birthDate?: string; gender?: string }
interface Coverage { resourceType: string; subscriberId?: string; identifier?: Identifier[] }

const param = (params: unknown, name: string): Record<string, unknown> | undefined => {
  const arr = (params as { parameter?: Array<{ name?: string; resource?: Record<string, unknown> }> })?.parameter ?? [];
  return arr.find((p) => p.name === name)?.resource;
};

const oo = (code: string, diagnostics: string) => ({
  resourceType: "OperationOutcome",
  issue: [{ severity: "error" as const, code, diagnostics }],
});

export function mountMemberMatch(app: Hono, wh: DeltaWarehouse): void {
  const patients = () => new DeltaResourceRepository(wh, "Patient");

  const uniqueMatch = async (conds: SearchCondition[]): Promise<FhirResource | "multiple" | null> => {
    const r = await patients().searchByParams({ conds, count: 2, offset: 0 });
    if (r.total === 1) return r.resources[0]!;
    if (r.total > 1) return "multiple";
    return null;
  };

  app.post("/Patient/$member-match", async (c) => {
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json(oo("invalid", "request body must be a Parameters resource"), 400); }
    if ((body as { resourceType?: string })?.resourceType !== "Parameters") {
      return c.json(oo("invalid", "expected a Parameters resource"), 400);
    }
    const member = param(body, "MemberPatient") as MemberPatient | undefined;
    const coverage = param(body, "CoverageToMatch") as Coverage | undefined;
    if (!member || member.resourceType !== "Patient") {
      return c.json(oo("required", "MemberPatient (Patient) is required"), 400);
    }

    // 1) Identifier match (strongest): each MemberPatient identifier + the coverage subscriberId.
    const idValues: SearchCondition[] = [];
    for (const id of member.identifier ?? []) {
      if (id.value) idValues.push({ code: "identifier", type: "token", value: id.value, ...(id.system ? { system: id.system } : {}) });
    }
    if (coverage?.subscriberId) idValues.push({ code: "identifier", type: "token", value: coverage.subscriberId });

    let matched: FhirResource | null = null;
    let ambiguous = false;
    for (const cond of idValues) {
      const m = await uniqueMatch([cond]);
      if (m === "multiple") { ambiguous = true; continue; }
      if (m) { matched = m; break; }
    }

    // 2) Demographic match (family + birthDate + gender) if no identifier hit.
    if (!matched) {
      const family = member.name?.find((n) => n.family)?.family;
      if (family && member.birthDate && member.gender) {
        const m = await uniqueMatch([
          { code: "family", type: "string", value: family, modifier: "exact" },
          { code: "birthdate", type: "date", op: "sw", value: member.birthDate },
          { code: "gender", type: "token", value: member.gender },
        ]);
        if (m === "multiple") ambiguous = true;
        else if (m) matched = m;
      }
    }

    if (!matched) {
      const msg = ambiguous
        ? "multiple candidate members matched — a single unique match is required"
        : "no member matched the supplied demographics/coverage";
      return c.json(oo("processing", msg), 422 as ContentfulStatusCode);
    }

    return c.json({
      resourceType: "Parameters",
      parameter: [{ name: "MemberIdentifier", resource: matched }],
    });
  });
}
