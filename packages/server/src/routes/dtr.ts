/**
 * Da Vinci DTR — Documentation Templates & Rules (CMS-0057 prior-auth workflow).
 * `Questionnaire/$questionnaire-package` returns a Bundle containing the requested Questionnaire(s)
 * plus their referenced dependencies (cqf-library Libraries + answerValueSet ValueSets) so a DTR
 * client (SMART app) can render the form and run population.
 *
 *   POST /Questionnaire/$questionnaire-package
 *     in:  Parameters{ questionnaire?: canonical, coverage?, order? }
 *     out: Bundle(collection){ Questionnaire, Library…, ValueSet… }
 *
 * SCOPE (first slice): this is **FHIR retrieval + dependency packaging** — the Questionnaire and its
 * referenced artifacts. **CQL auto-population** (evaluating the packaged Libraries to pre-fill answers)
 * is a large separate component (a CQL engine — see the CMS-0057 plan) and is NOT performed here; the
 * client or a future population service runs it against the returned package.
 */
import type { Hono } from "hono";
import { DeltaResourceRepository } from "../repository/delta-resource-repository.js";
import { operationOutcome as oo } from "../lib/errors.js";
import type { DeltaWarehouse } from "../lib/delta-warehouse.js";

const CQF_LIBRARY = "http://hl7.org/fhir/StructureDefinition/cqf-library";


interface Params { resourceType?: string; parameter?: Array<{ name?: string; valueString?: string; valueCanonical?: string; valueUri?: string; resource?: Record<string, unknown> }> }
interface QItem { answerValueSet?: string; item?: QItem[] }
interface Questionnaire { extension?: Array<{ url?: string; valueCanonical?: string }>; item?: QItem[] }

/** Collect answerValueSet canonicals from a (recursively nested) Questionnaire.item tree. */
function valueSetCanonicals(items: QItem[] | undefined, acc: Set<string>): void {
  for (const it of items ?? []) {
    if (it.answerValueSet) acc.add(it.answerValueSet.split("|")[0]);
    if (it.item) valueSetCanonicals(it.item, acc);
  }
}

export function mountDtr(app: Hono, wh: DeltaWarehouse): void {
  const repo = (rt: string) => new DeltaResourceRepository(wh, rt);

  // canonical → first stored resource of type `rt` matching url (version stripped)
  const byUrl = async (rt: string, canonical: string): Promise<Record<string, unknown> | undefined> => {
    const url = canonical.split("|")[0];
    const r = await repo(rt).searchByParams({ conds: [{ code: "url", type: "uri", value: url }], count: 1, offset: 0 });
    return r.resources[0] as unknown as Record<string, unknown> | undefined;
  };

  app.post("/Questionnaire/$questionnaire-package", async (c) => {
    let body: Params;
    try { body = await c.req.json(); } catch { return c.json(oo("invalid", "request body must be a Parameters resource"), 400); }
    if (body?.resourceType !== "Parameters") return c.json(oo("invalid", "expected a Parameters resource"), 400);

    const params = body.parameter ?? [];
    const canonical = params.find((p) => p.name === "questionnaire")?.valueCanonical
      ?? params.find((p) => p.name === "questionnaire")?.valueUri
      ?? params.find((p) => p.name === "questionnaire")?.valueString;
    if (!canonical) return c.json(oo("required", "provide a 'questionnaire' canonical to package (order/coverage-driven selection is payer config)"), 400);

    const questionnaire = await byUrl("Questionnaire", canonical);
    if (!questionnaire) return c.json(oo("not-found", "no installed Questionnaire matches the requested canonical"), 404);

    const entries: Record<string, unknown>[] = [questionnaire];

    // cqf-library Libraries (best-effort: include those installed locally)
    const q = questionnaire as Questionnaire;
    for (const ext of q.extension ?? []) {
      if (ext.url === CQF_LIBRARY && ext.valueCanonical) {
        const lib = await byUrl("Library", ext.valueCanonical);
        if (lib) entries.push(lib);
      }
    }

    // answerValueSet ValueSets referenced by the form items
    const vsUrls = new Set<string>();
    valueSetCanonicals(q.item, vsUrls);
    for (const url of vsUrls) {
      const vs = await byUrl("ValueSet", url);
      if (vs) entries.push(vs);
    }

    return c.json({ resourceType: "Bundle", type: "collection", entry: entries.map((r) => ({ resource: r })) });
  });
}
