/**
 * FHIR Bulk Data ($export) — async, disk-backed (ADR-0027 / (g)(10) multi-patient API).
 *
 *   GET  /$export                 system export (all resource types)
 *   GET  /Patient/$export         all patients + compartment resource types
 *   GET  /Group/:id/$export       the group's member patients + their compartments
 *   GET  /_export-status/:jobId   202 (in-progress) → 200 completion manifest → 5xx (failed)
 *   GET  /_export-file/:jobId/:t  streamed application/fhir+ndjson
 *   DELETE /_export-status/:jobId cancel + delete
 *
 * Kickoff returns 202 + Content-Location immediately; the export runs in the background, paging
 * results to NDJSON files on disk (not held in memory). Params: _type, _since, _outputFormat.
 */
import type { Hono } from "hono";
import type { DeltaWarehouse } from "../lib/delta-warehouse.js";
import { DeltaResourceRepository } from "../repository/delta-resource-repository.js";
import { r4CoreResourceTypes } from "../fhir-schema/r4-registry.js";
import { patientCompartment } from "../fhir-schema/patient-compartment.js";
import { badRequest, notFound } from "../lib/errors.js";
import {
  createExportJob, readManifest, appendNdjson, recordOutput, finishJob, openTypeFile, deleteExportJob,
} from "../lib/export-jobs.js";
import type { Resource as FhirResource } from "@ronin/fhir-types";
import { providerAccessOptOutEnabled, filterProviderOptOut } from "../auth/cms0057-consent.js";

const PAGE = 1000;

export function mountExport(app: Hono, wh: DeltaWarehouse, baseUrl: string): void {
  const repo = (rt: string) => new DeltaResourceRepository(wh, rt);
  const compartmentTypes = Object.keys(patientCompartment);
  const fileUrl = (id: string, type: string) => `${baseUrl}/_export-file/${id}/${type}`;
  const ndjson = (rs: FhirResource[]) => rs.map((x) => JSON.stringify(x)).join("\n") + "\n";

  /** Page every current resource of a type to its NDJSON file; returns the count. */
  const exportAll = async (jobId: string, rt: string, since?: string): Promise<number> => {
    const lastUpdated = since ? [{ op: ">=", value: since }] : [];
    let offset = 0, count = 0;
    for (;;) {
      const r = await repo(rt).searchByParams({ conds: [], lastUpdated, count: PAGE, offset });
      if (!r.resources.length) break;
      await appendNdjson(jobId, rt, ndjson(r.resources));
      count += r.resources.length; offset += PAGE;
      if (r.resources.length < PAGE) break;
    }
    return count;
  };

  /** Export a type limited to the compartments of the given patient ids (Patient → those ids). */
  const exportForPatients = async (jobId: string, rt: string, patientIds: string[]): Promise<number> => {
    const seen = new Set<string>();
    const out: FhirResource[] = [];
    if (rt === "Patient") {
      for (const pid of patientIds) { try { out.push(await repo("Patient").read(pid)); } catch { /* gone */ } }
    } else {
      const params = (patientCompartment as Record<string, string[]>)[rt];
      if (!params?.length) return 0;
      for (const pid of patientIds) {
        for (const m of await repo(rt).findReferencing(params, `Patient/${pid}`)) {
          if (m.id && !seen.has(m.id)) { seen.add(m.id); out.push(m); }
        }
      }
    }
    if (out.length) await appendNdjson(jobId, rt, ndjson(out));
    return out.length;
  };

  const runExport = async (jobId: string, opts: { scope: "system" | "patient" | "group"; typeFilter?: string[]; since?: string; patientIds?: string[] }) => {
    try {
      const candidates = opts.scope === "system" ? r4CoreResourceTypes : ["Patient", ...compartmentTypes];
      for (const rt of candidates) {
        if (!wh.hasTable(rt.toLowerCase())) continue;
        if (opts.typeFilter?.length && !opts.typeFilter.includes(rt)) continue;
        const count = opts.scope === "group"
          ? await exportForPatients(jobId, rt, opts.patientIds ?? [])
          : await exportAll(jobId, rt, opts.since);
        if (count > 0) await recordOutput(jobId, rt, fileUrl(jobId, rt), count);
      }
      await finishJob(jobId, "complete");
    } catch (e) {
      await finishJob(jobId, "failed", (e as Error)?.message ?? "export failed");
    }
  };

  const kickoff = (scope: "system" | "patient" | "group") => async (c: any) => {
    const of = c.req.query("_outputFormat") ?? "application/fhir+ndjson";
    if (!/ndjson/i.test(of)) throw badRequest("_outputFormat must be application/fhir+ndjson");
    const typeFilter = c.req.query("_type")?.split(",").map((s: string) => s.trim()).filter(Boolean);
    const since = c.req.query("_since");
    let patientIds: string[] | undefined;
    if (scope === "group") {
      const group = await repo("Group").read(c.req.param("id")); // 404/410 if missing
      patientIds = ((group as any).member ?? [])
        .map((m: any) => m?.entity?.reference)
        .filter((r: unknown): r is string => typeof r === "string" && r.startsWith("Patient/"))
        .map((r: string) => r.slice("Patient/".length));
      // Provider Access is OPT-OUT (CMS-0057): a Group/$export scoped to attributed patients must
      // exclude any patient who has opted out. Off by default; production enablement is a deploy gate.
      if (providerAccessOptOutEnabled()) patientIds = await filterProviderOptOut(wh, patientIds ?? []);
    }
    const jobId = await createExportJob(new URL(c.req.url).pathname + (c.req.url.includes("?") ? `?${c.req.url.split("?")[1]}` : ""), new Date().toISOString(), false);
    void runExport(jobId, { scope, typeFilter, since, patientIds }); // background
    c.header("Content-Location", `${baseUrl}/_export-status/${jobId}`);
    return c.body(null, 202);
  };

  app.get("/$export", kickoff("system"));
  app.get("/Patient/$export", kickoff("patient"));
  app.get("/Group/:id/$export", kickoff("group"));

  app.get("/_export-status/:jobId", async (c) => {
    const m = await readManifest(c.req.param("jobId"));
    if (!m) throw notFound("bulk export job", c.req.param("jobId"));
    if (m.status === "in-progress") {
      return c.body(null, 202, { "X-Progress": "in-progress", "Retry-After": "1" });
    }
    if (m.status === "failed") {
      return c.json({ resourceType: "OperationOutcome", issue: [{ severity: "error", code: "exception", diagnostics: m.message ?? "export failed" }] }, 500);
    }
    return c.json({
      transactionTime: m.transactionTime,
      request: `${baseUrl}${m.request}`,
      requiresAccessToken: m.requiresAccessToken,
      output: m.output,
      error: m.error,
    }, 200);
  });

  app.get("/_export-file/:jobId/:type", (c) => {
    const stream = openTypeFile(c.req.param("jobId"), c.req.param("type"));
    if (!stream) throw notFound("bulk export file", c.req.param("type"));
    return new Response(stream, { status: 200, headers: { "Content-Type": "application/fhir+ndjson" } });
  });

  app.delete("/_export-status/:jobId", async (c) => {
    await deleteExportJob(c.req.param("jobId"));
    return c.body(null, 202); // cancellation/deletion accepted
  });
}
