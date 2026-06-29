/**
 * Generic `:resourceType` FHIR routes for the standalone OSS-Delta backend.
 *
 * Thin Hono layer (mirrors the curated route style): parse + Zod-validate at the
 * REST boundary, then delegate to a per-type {@link DeltaResourceRepository}
 * (delta-rs write / DataFusion read). Bronze-only CRUD + identifier search.
 */

import { Hono } from "hono";
import fhirpath from "fhirpath";
import { fhirpathR4Model } from "../lib/fhirpath-model.js";
import type { DeltaWarehouse } from "../lib/delta-warehouse.js";
import { DeltaResourceRepository, type SearchCondition } from "../repository/delta-resource-repository.js";
import { GenericResourceSchema } from "../repository/schemas.js";
import { uuidv7 } from "../lib/uuid-v7.js";
import { isR4CoreResource, r4CoreResourceTypes } from "../fhir-schema/r4-registry.js";
import { searchParam } from "../fhir-schema/r4-search-params.js";
import { patientCompartment } from "../fhir-schema/patient-compartment.js";
import { enforceReadConsent, filterReadConsent, consentEnabled } from "../auth/consent-enforce.js";
import { applyObligations } from "../auth/redact.js";
import { validateResource, type ValidationResult } from "../validation/validation-chain.js";
import { badRequest, notFound, preconditionFailed, unprocessable } from "../lib/errors.js";
import type { OperationOutcome, Resource as FhirResource } from "@ronin/fhir-types";

/** Reject anything that isn't one of the 146 R4 Core resource types. */
function assertR4Core(resourceType: string): void {
  if (!isR4CoreResource(resourceType)) {
    throw notFound("Resource", resourceType); // unknown type endpoint → 404
  }
}

function parseIdentifierToken(token: string): { system: string; value: string } | null {
  const i = token.indexOf("|");
  if (i === -1) return null;
  const system = token.slice(0, i);
  const value = token.slice(i + 1);
  return system && value ? { system, value } : null;
}

/** One history Bundle entry from a stored version row (works for instance + type history). */
function historyEntry(v: { id: string; version_id: number; last_updated: string; body_json: string; deleted?: boolean | null }, baseUrl: string, rt: string) {
  const deleted = v.deleted === true;
  return {
    fullUrl: `${baseUrl}/${rt}/${v.id}`,
    ...(deleted ? {} : { resource: JSON.parse(v.body_json) }),
    request: { method: deleted ? "DELETE" : Number(v.version_id) === 1 ? "POST" : "PUT", url: `${rt}/${v.id}` },
    response: { status: deleted ? "204" : "200", etag: `W/"${v.version_id}"`, lastModified: v.last_updated },
  };
}

/** Return a copy of `r` with only the listed top-level keys (for _elements / _summary). */
function pick(r: FhirResource, keys: string[]): FhirResource {
  const out: Record<string, unknown> = {};
  for (const k of keys) if ((r as any)[k] !== undefined) out[k] = (r as any)[k];
  return out as unknown as FhirResource;
}

function clampInt(raw: string | undefined, dflt: number): number {
  const n = raw === undefined ? dflt : Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : dflt;
}

/** FHIR date/number prefix → SQL comparison (`sw` = prefix/day match for no-prefix & eq). */
function parseRangeParam(raw: string): { op: string; value: string } | null {
  const m = /^(eq|ne|gt|lt|ge|le)(.+)$/.exec(raw);
  const opMap: Record<string, string> = { gt: ">", lt: "<", ge: ">=", le: "<=", eq: "sw", ne: "!=" };
  if (m) {
    const op = opMap[m[1]!];
    return op ? { op, value: m[2]! } : null;
  }
  return { op: "sw", value: raw };
}

/**
 * Build per-resource search conditions from query params (control `_*` params skipped).
 * Handles token/string/date/number/quantity/uri/reference + modifiers (:exact :contains
 * :not :missing). Chained params (containing ".") are skipped here — handled separately.
 */
function buildConds(rt: string, queries: Record<string, string[]>): SearchCondition[] {
  const conds: SearchCondition[] = [];
  for (const [key, values] of Object.entries(queries)) {
    if (key.startsWith("_") || key.includes(".")) continue; // control params / chaining
    const [code, modifier] = key.split(":");
    const def = searchParam(rt, code!);
    if (!def) continue; // unsupported param for this type → ignored (lenient)
    for (const v of values) {
      const cond = condFor(code!, def.type, modifier, v);
      if (cond) conds.push(cond);
    }
  }
  return conds;
}

function condFor(code: string, type: string, modifier: string | undefined, v: string): SearchCondition | null {
  if (modifier === "missing") return { code, type: "missing", value: v === "true" ? "true" : "false", modifier: "missing" };
  switch (type) {
    case "token": {
      const m = parseIdentifierToken(v); // "system|code" or bare code
      const base = m ? { code, type: "token", value: m.value, system: m.system } : { code, type: "token", value: v };
      return modifier === "not" ? { ...base, modifier: "not" } : base;
    }
    case "string":
      return { code, type: "string", value: v, ...(modifier === "exact" || modifier === "contains" ? { modifier } : {}) };
    case "date": {
      const d = parseRangeParam(v);
      return d ? { code, type: "date", op: d.op, value: d.value } : null;
    }
    case "number": {
      const d = parseRangeParam(v);
      return d ? { code, type: "number", op: d.op === "sw" ? "=" : d.op, value: d.value } : null;
    }
    case "quantity": {
      const [numPart, system] = v.split("|");
      const d = parseRangeParam(numPart ?? "");
      return d ? { code, type: "quantity", op: d.op === "sw" ? "=" : d.op, value: d.value, ...(system ? { system } : {}) } : null;
    }
    case "uri":
      return { code, type: "uri", value: v };
    case "reference":
      return { code, type: "reference", value: v, ...(modifier === "not" ? { modifier: "not" } : {}) };
    default:
      return null;
  }
}

function stripWeakEtag(etag: string): string {
  let s = etag.trim();
  if (s.startsWith("W/")) s = s.slice(2);
  if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
  return s;
}

/** Unwrap a $validate input: a bare resource, or a Parameters with a `resource` param. */
function unwrapValidateInput(body: any): unknown {
  if (body && body.resourceType === "Parameters" && Array.isArray(body.parameter)) {
    const p = body.parameter.find((x: any) => x?.name === "resource" && x?.resource);
    if (p) return p.resource;
  }
  return body;
}

/** Map a ValidationResult to an OperationOutcome (the $validate response shape). */
function validationOutcome(vr: ValidationResult): OperationOutcome {
  if (vr.valid) {
    return { resourceType: "OperationOutcome", issue: [{ severity: "information", code: "informational", diagnostics: "Validation successful" }] };
  }
  return {
    resourceType: "OperationOutcome",
    issue: vr.issues.map((i) => ({
      severity: "error",
      code: "invariant",
      diagnostics: i.message,
      ...(i.path ? { expression: [i.path] } : {}),
    })),
  };
}

function validate(body: unknown, resourceType: string): FhirResource {
  assertR4Core(resourceType);
  if (body === null || typeof body !== "object") throw badRequest("Request body must be JSON");
  const parsed = GenericResourceSchema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0]!;
    throw unprocessable(
      `${resourceType} validation failed: ${first.message}`,
      first.path.length > 0 ? [first.path.join(".")] : undefined,
    );
  }
  if (parsed.data.resourceType !== resourceType) {
    throw badRequest(`Body resourceType '${parsed.data.resourceType}' does not match URL '${resourceType}'`);
  }
  return parsed.data as FhirResource;
}

export function deltaResourceRoutes(wh: DeltaWarehouse, baseUrl: string): Hono {
  const app = new Hono();
  const repo = (rt: string) => new DeltaResourceRepository(wh, rt);

  /** Resolve a conditional query (If-None-Exist / conditional PUT/DELETE) → count + first hit. */
  const resolveConditional = async (rt: string, queryStr: string): Promise<{ total: number; match?: FhirResource }> => {
    const params = new URLSearchParams(queryStr);
    const queries: Record<string, string[]> = {};
    for (const [k, v] of params) (queries[k] ??= []).push(v);
    const conds = buildConds(rt, queries);
    const lastUpdated = params.getAll("_lastUpdated").map(parseRangeParam).filter((x): x is { op: string; value: string } => x !== null);
    const r = await repo(rt).searchByParams({ conds, id: params.get("_id") ?? undefined, lastUpdated, count: 2, offset: 0 });
    return { total: r.total, match: r.resources[0] };
  };

  /**
   * Resolve chained params (`ref[:Type].chained=v`) and reverse-chained `_has`
   * (`_has:Source:refParam:searchParam=v`) into reference conditions + an id restriction.
   * Each is a 2-step search across resources.
   */
  const resolveChainsAndHas = async (rt: string, queries: Record<string, string[]>): Promise<{ conds: SearchCondition[]; idIn?: string[] }> => {
    const conds: SearchCondition[] = [];
    let idIn: string[] | undefined;
    for (const [key, values] of Object.entries(queries)) {
      if (!key.startsWith("_") && key.includes(".")) {
        const dot = key.indexOf(".");
        const [ref, explicitType] = key.slice(0, dot).split(":");
        const chained = key.slice(dot + 1);
        const def = searchParam(rt, ref!);
        if (!def || def.type !== "reference") continue;
        const targets = explicitType ? [explicitType] : def.target ?? [];
        const [chainCode, chainMod] = chained.split(":");
        const refs: string[] = [];
        for (const v of values) {
          for (const tt of targets) {
            if (!isR4CoreResource(tt) || !wh.hasTable(tt.toLowerCase())) continue;
            const tdef = searchParam(tt, chainCode!);
            const cond = tdef ? condFor(chainCode!, tdef.type, chainMod, v) : null;
            if (!cond) continue;
            const r = await repo(tt).searchByParams({ conds: [cond], count: 1000, offset: 0 });
            for (const m of r.resources) refs.push(`${tt}/${m.id}`);
          }
        }
        conds.push({ code: ref!, type: "reference", value: "", valueIn: refs });
      }
      if (key.startsWith("_has:")) {
        const [sourceType, refParam, searchCode] = key.slice(5).split(":");
        const refDef = sourceType && refParam ? searchParam(sourceType, refParam) : undefined;
        const sdef = sourceType && searchCode ? searchParam(sourceType, searchCode) : undefined;
        if (!sourceType || !refDef || !sdef || !wh.hasTable(sourceType.toLowerCase())) { idIn = []; continue; }
        const ids = new Set<string>();
        for (const v of values) {
          const cond = condFor(searchCode!, sdef.type, undefined, v);
          if (!cond) continue;
          const r = await repo(sourceType).searchByParams({ conds: [cond], count: 1000, offset: 0 });
          for (const m of r.resources) {
            let rrefs: string[] = [];
            try { rrefs = (fhirpath.evaluate(m as any, refDef.expression, undefined, fhirpathR4Model) as any[]).map((x) => x?.reference).filter(Boolean); } catch { /* skip */ }
            for (const rr of rrefs) { const [tt, tid] = rr.split("/"); if (tt === rt && tid) ids.add(tid); }
          }
        }
        idIn = idIn ? idIn.filter((x) => ids.has(x)) : [...ids];
      }
    }
    return { conds, idIn };
  };

  // POST /$validate  (system-level — resourceType from the body)
  app.post("/$validate", async (c) => {
    const resource = unwrapValidateInput(await c.req.json().catch(() => null)) as any;
    const rt = resource?.resourceType;
    if (!rt || !isR4CoreResource(rt)) throw badRequest("$validate body must be an R4 Core resource");
    const vr = await validateResource(resource as Record<string, unknown>, { warehouse: wh });
    return c.json(validationOutcome(vr), 200);
  });

  // POST /:resourceType/$validate  (validate without persisting)
  app.post("/:resourceType/$validate", async (c) => {
    const rt = c.req.param("resourceType");
    assertR4Core(rt);
    const resource = unwrapValidateInput(await c.req.json().catch(() => null)) as any;
    if (resource?.resourceType && resource.resourceType !== rt) {
      throw badRequest(`Body resourceType '${resource.resourceType}' does not match URL '${rt}'`);
    }
    const vr = await validateResource({ ...resource, resourceType: rt } as Record<string, unknown>, { warehouse: wh });
    return c.json(validationOutcome(vr), 200);
  });

  // POST /:resourceType  (with optional conditional create via If-None-Exist)
  app.post("/:resourceType", async (c) => {
    const rt = c.req.param("resourceType");
    const resource = validate(await c.req.json().catch(() => null), rt);
    const ifNoneExist = c.req.header("If-None-Exist");
    if (ifNoneExist) {
      const { total, match } = await resolveConditional(rt, ifNoneExist);
      if (total === 1) {
        return c.json(match!, 200, {
          Location: `${baseUrl}/${rt}/${match!.id}`,
          ETag: `W/"${match!.meta?.versionId ?? "1"}"`,
        });
      }
      if (total > 1) throw preconditionFailed(`If-None-Exist matched ${total} resources — not created`);
      // total === 0 → fall through to a normal create
    }
    const created = await repo(rt).create(resource);
    return c.json(created, 201, {
      Location: `${baseUrl}/${rt}/${created.id}`,
      ETag: `W/"${created.meta?.versionId ?? "1"}"`,
      "Last-Modified": created.meta?.lastUpdated ?? new Date().toISOString(),
    });
  });

  // GET|POST /Patient/:id/$everything  — the patient + its compartment members.
  const everything = async (c: any) => {
    const id = c.req.param("id");
    const patient = await repo("Patient").read(id); // 404/410 guard
    const ref = `Patient/${id}`;
    const typeFilter = c.req.query("_type")?.split(",").map((s: string) => s.trim()).filter(Boolean);
    // The patient record itself is consent-gated too (throws 403 if the caller can't see it).
    await enforceReadConsent(wh, patient, c.get("auth"));
    const auth = c.get("auth");
    const entry: any[] = [{ fullUrl: `${baseUrl}/Patient/${id}`, resource: applyObligations(patient, auth), search: { mode: "match" } }];
    for (const [rt, params] of Object.entries(patientCompartment)) {
      if (rt === "Patient" || !wh.hasTable(rt.toLowerCase())) continue;
      if (typeFilter?.length && !typeFilter.includes(rt)) continue;
      const matches = (await filterReadConsent(wh, await repo(rt).findReferencing(params, ref), auth)).allowed;
      for (const m of matches) entry.push({ fullUrl: `${baseUrl}/${rt}/${m.id}`, resource: applyObligations(m, auth), search: { mode: "match" } });
    }
    return c.json({ resourceType: "Bundle", type: "searchset", timestamp: new Date().toISOString(), total: entry.length, entry });
  };
  app.get("/Patient/:id/$everything", everything);
  app.post("/Patient/:id/$everything", everything);

  // ---- Bulk Data $export (async-shaped; job completes synchronously at kickoff) ----
  // DEV scope: in-memory job store (not persisted, single-process). NDJSON held in memory.
  const exportJobs = new Map<string, { transactionTime: string; types: Record<string, string> }>();

  const kickoffExport = (scope: "system" | "patient") => async (c: any) => {
    const since = c.req.query("_since");
    const typeFilter = c.req.query("_type")?.split(",").map((s: string) => s.trim()).filter(Boolean);
    const candidates = scope === "patient" ? ["Patient", ...Object.keys(patientCompartment)] : r4CoreResourceTypes;
    const transactionTime = new Date().toISOString();
    const types: Record<string, string> = {};
    for (const rt of candidates) {
      if (!wh.hasTable(rt.toLowerCase())) continue;
      if (typeFilter?.length && !typeFilter.includes(rt)) continue;
      const lastUpdated = since ? [{ op: ">=", value: since }] : [];
      const r = await repo(rt).searchByParams({ conds: [], lastUpdated, count: 100000, offset: 0 });
      if (r.resources.length) types[rt] = r.resources.map((x) => JSON.stringify(x)).join("\n") + "\n";
    }
    const jobId = uuidv7();
    exportJobs.set(jobId, { transactionTime, types });
    c.header("Content-Location", `${baseUrl}/_export-status/${jobId}`);
    return c.body(null, 202); // async kickoff accepted (this dev impl finishes immediately)
  };
  app.get("/$export", kickoffExport("system"));
  app.get("/Patient/$export", kickoffExport("patient"));

  app.get("/_export-status/:jobId", (c) => {
    const jobId = c.req.param("jobId");
    const job = exportJobs.get(jobId);
    if (!job) throw notFound("bulk export job", jobId);
    return c.json({
      transactionTime: job.transactionTime,
      request: `${baseUrl}/$export`,
      requiresAccessToken: false,
      output: Object.keys(job.types).map((type) => ({ type, url: `${baseUrl}/_export-file/${jobId}/${type}` })),
      error: [],
    });
  });

  app.get("/_export-file/:jobId/:type", (c) => {
    const job = exportJobs.get(c.req.param("jobId"));
    const ndjson = job?.types[c.req.param("type")];
    if (ndjson === undefined) throw notFound("bulk export file", c.req.param("type"));
    return c.body(ndjson, 200, { "Content-Type": "application/fhir+ndjson" });
  });

  app.delete("/_export-status/:jobId", (c) => {
    exportJobs.delete(c.req.param("jobId"));
    return c.body(null, 202); // cancellation accepted
  });

  // GET /_history  — system-level history across all resource types (merged, paged).
  app.get("/_history", async (c) => {
    const count = clampInt(c.req.query("_count"), 50);
    const offset = clampInt(c.req.query("_getpagesoffset"), 0);
    const all: Array<{ rt: string; v: any }> = [];
    let total = 0;
    for (const rt of r4CoreResourceTypes) {
      if (!wh.hasTable(rt.toLowerCase())) continue;
      const { rows, total: t } = await repo(rt).historyAll(offset + count, 0); // enough to page post-merge
      total += t;
      for (const v of rows) all.push({ rt, v });
    }
    all.sort((a, b) => (String(b.v.last_updated)).localeCompare(String(a.v.last_updated))); // newest first
    const page = all.slice(offset, offset + count);
    const query = new URLSearchParams(c.req.url.split("?")[1] ?? "");
    const link = [{ relation: "self", url: `${baseUrl}/_history?${query.toString()}` }];
    if (offset + count < total) {
      const nx = new URLSearchParams(query);
      nx.set("_count", String(count));
      nx.set("_getpagesoffset", String(offset + count));
      link.push({ relation: "next", url: `${baseUrl}/_history?${nx.toString()}` });
    }
    return c.json({
      resourceType: "Bundle",
      type: "history",
      timestamp: new Date().toISOString(),
      total,
      link,
      entry: page.map(({ rt, v }) => historyEntry(v, baseUrl, rt)),
    });
  });

  // GET /:resourceType/:id/_history/:vid  (vread — version read)
  app.get("/:resourceType/:id/_history/:vid", async (c) => {
    const rt = c.req.param("resourceType");
    assertR4Core(rt);
    const resource = await repo(rt).readVersion(c.req.param("id"), Number(c.req.param("vid")));
    await enforceReadConsent(wh, resource, c.get("auth"));
    const disclosed = applyObligations(resource, c.get("auth"));
    return c.json(disclosed, 200, {
      ETag: `W/"${resource.meta?.versionId ?? c.req.param("vid")}"`,
      "Last-Modified": resource.meta?.lastUpdated ?? new Date().toISOString(),
    });
  });

  // GET /:resourceType/:id/_history  (instance history)
  app.get("/:resourceType/:id/_history", async (c) => {
    const rt = c.req.param("resourceType");
    assertR4Core(rt);
    const id = c.req.param("id");
    const versions = await repo(rt).history(id);
    if (versions.length === 0) throw notFound(rt, id);
    return c.json({
      resourceType: "Bundle",
      type: "history",
      timestamp: new Date().toISOString(),
      total: versions.length,
      entry: versions.map((v) => historyEntry(v as any, baseUrl, rt)),
    });
  });

  // GET /:resourceType/_history  (type-level history, paged)
  app.get("/:resourceType/_history", async (c) => {
    const rt = c.req.param("resourceType");
    assertR4Core(rt);
    const count = clampInt(c.req.query("_count"), 50);
    const offset = clampInt(c.req.query("_getpagesoffset"), 0);
    const { rows, total } = await repo(rt).historyAll(count, offset);
    const query = new URLSearchParams(c.req.url.split("?")[1] ?? "");
    const link = [{ relation: "self", url: `${baseUrl}/${rt}/_history?${query.toString()}` }];
    if (offset + count < total) {
      const nx = new URLSearchParams(query);
      nx.set("_count", String(count));
      nx.set("_getpagesoffset", String(offset + count));
      link.push({ relation: "next", url: `${baseUrl}/${rt}/_history?${nx.toString()}` });
    }
    return c.json({
      resourceType: "Bundle",
      type: "history",
      timestamp: new Date().toISOString(),
      total,
      link,
      entry: rows.map((v) => historyEntry(v as any, baseUrl, rt)),
    });
  });

  // GET /:resourceType/:id
  app.get("/:resourceType/:id", async (c) => {
    assertR4Core(c.req.param("resourceType"));
    const resource = await repo(c.req.param("resourceType")).read(c.req.param("id"));
    await enforceReadConsent(wh, resource, c.get("auth"));
    const disclosed = applyObligations(resource, c.get("auth"));
    return c.json(disclosed, 200, {
      ETag: `W/"${resource.meta?.versionId ?? "1"}"`,
      "Last-Modified": resource.meta?.lastUpdated ?? new Date().toISOString(),
    });
  });

  // PUT /:resourceType/:id
  app.put("/:resourceType/:id", async (c) => {
    const rt = c.req.param("resourceType");
    const resource = validate(await c.req.json().catch(() => null), rt);
    const ifMatch = c.req.header("If-Match");
    const updated = await repo(rt).update(
      c.req.param("id"),
      resource,
      ifMatch ? stripWeakEtag(ifMatch) : null,
    );
    return c.json(updated, 200, {
      ETag: `W/"${updated.meta?.versionId ?? "1"}"`,
      "Last-Modified": updated.meta?.lastUpdated ?? new Date().toISOString(),
    });
  });

  // DELETE /:resourceType/:id
  app.delete("/:resourceType/:id", async (c) => {
    assertR4Core(c.req.param("resourceType"));
    await repo(c.req.param("resourceType")).delete(c.req.param("id"));
    return c.body(null, 204);
  });

  // PUT /:resourceType?<search>  (conditional update by search)
  app.put("/:resourceType", async (c) => {
    const rt = c.req.param("resourceType");
    const query = c.req.url.split("?")[1] ?? "";
    if (!query) throw badRequest(`conditional update requires a search query (PUT /${rt}?...)`);
    const resource = validate(await c.req.json().catch(() => null), rt);
    const { total, match } = await resolveConditional(rt, query);
    if (total > 1) throw preconditionFailed(`conditional update matched ${total} resources`);
    if (total === 1) {
      const updated = await repo(rt).update(match!.id!, { ...resource, id: match!.id }, null);
      return c.json(updated, 200, {
        ETag: `W/"${updated.meta?.versionId ?? "1"}"`,
        "Last-Modified": updated.meta?.lastUpdated ?? new Date().toISOString(),
      });
    }
    const created = await repo(rt).create(resource); // 0 matches → create
    return c.json(created, 201, {
      Location: `${baseUrl}/${rt}/${created.id}`,
      ETag: `W/"${created.meta?.versionId ?? "1"}"`,
      "Last-Modified": created.meta?.lastUpdated ?? new Date().toISOString(),
    });
  });

  // DELETE /:resourceType?<search>  (conditional delete by search; single-match)
  app.delete("/:resourceType", async (c) => {
    const rt = c.req.param("resourceType");
    assertR4Core(rt);
    const query = c.req.url.split("?")[1] ?? "";
    if (!query) throw badRequest(`conditional delete requires a search query (DELETE /${rt}?...)`);
    const { total, match } = await resolveConditional(rt, query);
    if (total > 1) throw preconditionFailed(`conditional delete matched ${total} resources`);
    if (total === 1) await repo(rt).delete(match!.id!);
    return c.body(null, 204); // 0 or 1 → 204 (no-op when none matched)
  });

  // GET /:resourceType  — search. Reserved control params (_id/_lastUpdated on base columns,
  // paging, sort) + per-resource params (token/string/date) from the R4 SearchParameter
  // registry, matched against the materialized search index (multi-param AND).
  app.get("/:resourceType", async (c) => {
    const rt = c.req.param("resourceType");
    assertR4Core(rt);
    const count = clampInt(c.req.query("_count"), 50);
    const offset = clampInt(c.req.query("_getpagesoffset"), 0);
    const sortRaw = c.req.query("_sort") ?? "-_lastUpdated"; // default newest-first
    const sortDesc = sortRaw.startsWith("-");
    const sortField = sortRaw.replace(/^-/, "");
    const sortParam = sortField !== "_lastUpdated" && searchParam(rt, sortField) ? sortField : undefined;

    // Unified search: per-resource conditions + chaining/_has + base-column filters.
    const { conds: chainConds, idIn } = await resolveChainsAndHas(rt, c.req.queries());
    const conds = [...buildConds(rt, c.req.queries()), ...chainConds];
    const lastUpdated = (c.req.queries("_lastUpdated") ?? []).map(parseRangeParam).filter((x): x is { op: string; value: string } => x !== null);
    let resources: FhirResource[];
    let total: number;
    {
      const r = await repo(rt).searchByParams({ conds, id: c.req.query("_id"), idIn, lastUpdated, count, offset, sortDesc, sortParam });
      resources = r.resources;
      total = r.total;
    }

    // _include / _revinclude — resolve referenced (or referencing) resources as include entries.
    const seen = new Set(resources.map((r) => `${rt}/${r.id}`));
    const includeEntries: any[] = [];
    const addInclude = (type: string, res: FhirResource) => {
      const key = `${type}/${res.id}`;
      if (seen.has(key)) return;
      seen.add(key);
      includeEntries.push({ fullUrl: `${baseUrl}/${type}/${res.id}`, resource: res, search: { mode: "include" } });
    };
    for (const inc of c.req.queries("_include") ?? []) {
      const [srcType, param] = inc.split(":");
      const def = srcType === rt && param ? searchParam(rt, param) : undefined;
      if (!def || def.type !== "reference") continue;
      for (const res of resources) {
        let refs: string[] = [];
        try { refs = (fhirpath.evaluate(res as any, def.expression, undefined, fhirpathR4Model) as any[]).map((x) => x?.reference).filter(Boolean); } catch { /* skip */ }
        for (const ref of refs) {
          const [tType, tId] = ref.split("/");
          if (!tType || !tId || !isR4CoreResource(tType)) continue;
          try { addInclude(tType, await repo(tType).read(tId)); } catch { /* unresolvable / deleted */ }
        }
      }
    }
    for (const rev of c.req.queries("_revinclude") ?? []) {
      const [srcType, param] = rev.split(":");
      const def = srcType && param ? searchParam(srcType, param) : undefined;
      if (!def || def.type !== "reference") continue;
      for (const res of resources) {
        for (const m of await repo(srcType!).findReferencing([param!], `${rt}/${res.id}`)) addInclude(srcType!, m);
      }
    }

    const query = new URLSearchParams(c.req.url.split("?")[1] ?? "");
    const link = [{ relation: "self", url: `${baseUrl}/${rt}?${query.toString()}` }];
    if (offset + count < total) {
      const nx = new URLSearchParams(query);
      nx.set("_count", String(count));
      nx.set("_getpagesoffset", String(offset + count));
      link.push({ relation: "next", url: `${baseUrl}/${rt}?${nx.toString()}` });
    }

    // _summary=count → totals only, no entries.
    if (c.req.query("_summary") === "count") {
      return c.json({ resourceType: "Bundle", type: "searchset", timestamp: new Date().toISOString(), total, link });
    }
    // _elements / _summary=text → trim returned elements (mandatory id/meta always kept).
    const elements = c.req.query("_elements")?.split(",").map((s) => s.trim()).filter(Boolean);
    const summaryText = c.req.query("_summary") === "text";
    const shape = (r: FhirResource) => {
      const o = applyObligations(r, c.get("auth")); // 42 CFR Part 2 notice + inline redaction
      if (summaryText) return pick(o, ["text", "id", "meta", "resourceType"]);
      if (elements?.length) return pick(o, [...elements, "id", "meta", "resourceType"]);
      return o;
    };

    // Read-time consent/DS4P filter on this page (controls #3/#4). When it removes entries,
    // total reflects the visible count so it doesn't leak the existence of hidden records.
    // (Consent-aware total across pages needs label predicates in the query — a follow-up.)
    const visible = (await filterReadConsent(wh, resources, c.get("auth"))).allowed;
    const matchTotal = consentEnabled() && c.get("auth") && visible.length !== resources.length ? visible.length : total;

    return c.json({
      resourceType: "Bundle",
      type: "searchset",
      timestamp: new Date().toISOString(),
      total: matchTotal,
      link,
      entry: [
        ...visible.map((r) => ({ fullUrl: `${baseUrl}/${rt}/${r.id}`, resource: shape(r), search: { mode: "match" } })),
        ...includeEntries.map((e) => ({ ...e, resource: shape(e.resource) })),
      ],
    });
  });

  return app;
}
