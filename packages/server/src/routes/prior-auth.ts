/**
 * Da Vinci PAS — Prior Authorization Support (CMS-0057 Prior Authorization API). FHIR-native
 * `Claim/$submit` + `Claim/$inquire`. A submitter POSTs a Bundle containing a Claim
 * (use=preauthorization); we record a ClaimResponse and return it in a Bundle. `$inquire` returns the
 * stored ClaimResponse(s) for a patient / preAuthRef.
 *
 *   POST /Claim/$submit   in: Bundle{ Claim(use=preauthorization), … } → out: Bundle{ ClaimResponse }
 *   POST /Claim/$inquire  in: Bundle{ Claim } | Parameters → out: Bundle{ ClaimResponse… }
 *
 * SCOPE (first slice): the **adjudication is a stub** — a real payer's decision comes from its
 * Utilization Management system, and the PAS *gateway* converts FHIR ⇄ **X12 278** (a large, separate
 * component — see the CMS-0057 plan). This implements the FHIR-facing operations + persistence.
 */
import type { Hono } from "hono";
import { DeltaResourceRepository } from "../repository/delta-resource-repository.js";
import type { DeltaWarehouse } from "../lib/delta-warehouse.js";
import type { SearchCondition } from "../repository/delta-resource-repository.js";
import type { Resource as FhirResource } from "@fhirengine/fhir-types";
import { operationOutcome as oo } from "../lib/errors.js";
import { uuidv7 } from "../lib/uuid-v7.js";

interface Ref { reference?: string }
interface Claim { resourceType: string; use?: string; patient?: Ref; type?: unknown; insurer?: unknown; id?: string; identifier?: Array<{ system?: string; value?: string }>; item?: Array<{ sequence?: number }> }
interface Bundle { resourceType: string; entry?: Array<{ resource?: Record<string, unknown> }> }

const firstOf = (bundle: Bundle, rt: string): Record<string, unknown> | undefined =>
  bundle.entry?.map((e) => e.resource).find((r) => r?.resourceType === rt);


const collection = (resources: unknown[]) => ({ resourceType: "Bundle", type: "collection", entry: resources.map((r) => ({ resource: r })) });

export function mountPriorAuth(app: Hono, wh: DeltaWarehouse, baseUrl: string): void {
  const repo = (rt: string) => new DeltaResourceRepository(wh, rt);

  app.post("/Claim/$submit", async (c) => {
    let body: Bundle;
    try { body = await c.req.json(); } catch { return c.json(oo("invalid", "request body must be a Bundle"), 400); }
    if (body?.resourceType !== "Bundle") return c.json(oo("invalid", "expected a Bundle"), 400);
    const claim = firstOf(body, "Claim") as Claim | undefined;
    if (!claim) return c.json(oo("required", "the submission Bundle must contain a Claim"), 400);
    if (claim.use !== "preauthorization") return c.json(oo("invalid", "Claim.use must be 'preauthorization' for prior authorization"), 400);

    const preAuthRef = `PA-${uuidv7().slice(0, 13)}`;
    const claimResponse = {
      resourceType: "ClaimResponse",
      status: "active",
      type: claim.type ?? { coding: [{ system: "http://terminology.hl7.org/CodeSystem/claim-type", code: "professional" }] },
      use: "preauthorization",
      patient: claim.patient,
      created: new Date().toISOString(),
      insurer: claim.insurer ?? { display: "fhirEngine (stub payer)" },
      ...(claim.id ? { request: { reference: `Claim/${claim.id}` } } : {}),
      // Stub adjudication — NOT a real UM decision (see file header).
      outcome: "complete",
      disposition: "Prior authorization received and recorded (stub adjudication — not a real UM decision)",
      preAuthRef,
      identifier: [{ system: `${baseUrl}/fhir/prior-auth`, value: preAuthRef }],
      item: (claim.item ?? []).map((it) => ({
        itemSequence: it.sequence ?? 1,
        adjudication: [{ category: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/adjudication", code: "submitted" }] } }],
      })),
    };
    const stored = await repo("ClaimResponse").create(claimResponse as unknown as FhirResource);
    return c.json(collection([stored]));
  });

  app.post("/Claim/$inquire", async (c) => {
    let body: Bundle | { resourceType?: string; parameter?: Array<{ name?: string; valueString?: string; resource?: Record<string, unknown> }> };
    try { body = await c.req.json(); } catch { return c.json(oo("invalid", "request body must be a Bundle or Parameters"), 400); }

    const conds: SearchCondition[] = [];
    let patientRef: string | undefined;
    if (body?.resourceType === "Bundle") {
      const claim = firstOf(body as Bundle, "Claim") as Claim | undefined;
      patientRef = claim?.patient?.reference;
      const id = claim?.identifier?.[0]?.value;
      if (id) conds.push({ code: "identifier", type: "token", value: id });
    } else if (body?.resourceType === "Parameters") {
      const params = (body as { parameter?: Array<{ name?: string; valueString?: string }> }).parameter ?? [];
      patientRef = params.find((p) => p.name === "patient")?.valueString;
      const ref = params.find((p) => p.name === "preAuthRef")?.valueString;
      if (ref) conds.push({ code: "identifier", type: "token", value: ref });
    } else {
      return c.json(oo("invalid", "expected a Bundle or Parameters"), 400);
    }
    if (patientRef) conds.push({ code: "patient", type: "reference", value: patientRef });
    if (!conds.length) return c.json(oo("required", "provide a patient reference or a preAuthRef/identifier to inquire"), 400);

    const r = await repo("ClaimResponse").searchByParams({ conds, count: 50, offset: 0 });
    return c.json(collection(r.resources.filter((cr) => (cr as { use?: string }).use === "preauthorization")));
  });
}
