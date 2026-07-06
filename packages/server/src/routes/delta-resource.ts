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
import { isR4CoreResource, r4CoreResourceTypes } from "../fhir-schema/r4-registry.js";
import { searchParam } from "../fhir-schema/r4-search-params.js";
import { patientCompartment } from "../fhir-schema/patient-compartment.js";
import { mountExport } from "./export.js";
import { enforceReadConsent, filterReadConsent, consentEnabled } from "../auth/consent-enforce.js";
import { applyObligations } from "../auth/redact.js";
import { buildDataFilter, type DataFilter } from "../auth/data-filter.js";
import type { RequestVerb } from "../auth/scope-enforcer.js";
import type { AuthContext } from "../auth/auth-context.js";
import { validateResource, type ValidationResult } from "../validation/validation-chain.js";
import { badRequest, forbidden, notFound, preconditionFailed, unprocessable } from "../lib/errors.js";
import type { OperationOutcome, Resource as FhirResource } from "@fhirengine/fhir-types";

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
function historyEntry(v: { id: string; version_id: number; last_updated: string; body_json: string; deleted?: boolean | null }, baseUrl: string, rt: string, auth?: AuthContext) {
  const deleted = v.deleted === true;
  return {
    fullUrl: `${baseUrl}/${rt}/${v.id}`,
    // Obligation redaction (42 CFR Part 2 notice + inline label masking) applies to history
    // bodies too, not just read/search (audit M2).
    ...(deleted ? {} : { resource: applyObligations(JSON.parse(v.body_json), auth) }),
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
  // All 9 FHIR date/number prefixes. sa (starts-after) ≈ >, eb (ends-before) ≈ < against the
  // indexed instant; ap (approximately) degrades to a prefix/day match rather than silently
  // returning empty. (Was: sa/eb/ap unmatched → parsed as literal text → no results.)
  const m = /^(eq|ne|gt|lt|ge|le|sa|eb|ap)(.+)$/.exec(raw);
  const opMap: Record<string, string> = { gt: ">", lt: "<", ge: ">=", le: "<=", eq: "sw", ne: "!=", sa: ">", eb: "<", ap: "sw" };
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

/** Search-param types this engine can actually apply as a filter. */
const HANDLEABLE_PARAM_TYPES = new Set(["token", "string", "date", "number", "quantity", "uri", "reference"]);

/**
 * Params the engine cannot apply as a filter → must NOT be silently ignored (that returns a wrong,
 * broader result set). Always flags **known** params of an unsupported type (composite/special);
 * additionally flags **unknown** params only under `Prefer: handling=strict` (FHIR default is lenient
 * — ignore unknown params). Control (`_*`) and chained (`a.b`) params are handled elsewhere.
 */
/** Control params this engine actually consumes — the rest (`_filter`, `_tag`, `_profile`,
 * `_security`, `_source`, `_contained`, `_list`, `_text`, `_content`, `_total`, `_offset`, …)
 * are NOT implemented and must be flagged under strict rather than silently ignored. */
const SUPPORTED_CONTROL_PARAMS = new Set([
  "_id", "_lastUpdated", "_count", "_getpagesoffset", "_sort", "_summary", "_elements",
  "_include", "_revinclude", "_has", "_type", "_format", "_pretty",
]);
/** Token modifiers the index can actually apply. `:in/:not-in/:below/:above/:of-type/:text`
 * degrade to a wrong plain match — flag them under strict instead of silently mis-matching. */
const UNSUPPORTED_TOKEN_MODIFIERS = new Set(["in", "not-in", "below", "above", "of-type", "text"]);

function unsupportedSearchParams(rt: string, queries: Record<string, string[]>, strict: boolean): string[] {
  const bad: string[] = [];
  for (const key of Object.keys(queries)) {
    if (key.includes(".")) continue; // chained params handled elsewhere
    if (key.startsWith("_")) {
      const base = key.split(":")[0]!;
      if (strict && !SUPPORTED_CONTROL_PARAMS.has(base)) bad.push(base); // e.g. _filter, _tag, _profile
      continue;
    }
    const [code, modifier] = key.split(":");
    const def = searchParam(rt, code!);
    if (!def) { if (strict) bad.push(code!); continue; }
    if (!HANDLEABLE_PARAM_TYPES.has(def.type)) bad.push(`${code} (${def.type})`);
    else if (strict && modifier && UNSUPPORTED_TOKEN_MODIFIERS.has(modifier)) bad.push(`${code}:${modifier}`);
  }
  return bad;
}

function condFor(code: string, type: string, modifier: string | undefined, v: string): SearchCondition | null {
  if (modifier === "missing") return { code, type: "missing", value: v === "true" ? "true" : "false", modifier: "missing" };
  switch (type) {
    case "token": {
      // FHIR comma = OR-within-a-parameter (`status=active,completed`). Bare-code lists map to
      // an IN(...) predicate; a single value (or system-qualified) keeps the exact-match path.
      const parts = v.split(",").map((s) => s.trim()).filter(Boolean);
      if (parts.length > 1 && parts.every((p) => !p.includes("|"))) {
        const base = { code, type: "token", value: parts[0]!, valueIn: parts };
        return modifier === "not" ? { ...base, modifier: "not" } : base;
      }
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

  // --- Patient-compartment + query-restriction enforcement (auth chain points 3 + 4) ---
  // When an authenticated request carries a `patient/*` scope + launch patient, reads are scoped
  // to that patient's compartment and to any granular scope query restrictions. No auth context
  // (auth disabled) or a user/system scope → no compartment filter (open, as before).
  const cmap = patientCompartment as Record<string, string[]>;
  const dataFilterFor = (c: any, rt: string, verb: RequestVerb): DataFilter | null => {
    const auth = c.get("auth");
    return auth ? buildDataFilter(auth, rt, verb) : null;
  };
  // Ids in patient P's compartment for resource type rt (Patient → [P]; non-member type → []).
  const compartmentIds = async (rt: string, patientId: string): Promise<string[]> => {
    if (rt === "Patient") return [patientId];
    const params = cmap[rt];
    if (!params?.length) return [];
    return (await repo(rt).findReferencing(params, `Patient/${patientId}`)).map((m) => m.id!);
  };
  // Is a single fetched resource in patient P's compartment? (used to gate instance reads)
  const inCompartment = (rt: string, resource: FhirResource, patientId: string): boolean => {
    if (rt === "Patient") return resource.id === patientId;
    const params = cmap[rt];
    if (!params?.length) return false;
    const target = `Patient/${patientId}`;
    for (const code of params) {
      const def = searchParam(rt, code);
      if (!def) continue;
      let refs: string[] = [];
      try { refs = (fhirpath.evaluate(resource as any, def.expression, undefined, fhirpathR4Model) as any[]).map((x) => x?.reference).filter(Boolean); } catch { /* skip */ }
      if (refs.some((r) => r === target || r === patientId || r.endsWith(`/${patientId}`))) return true;
    }
    return false;
  };
  // Gate an instance read/vread/history by the request's compartment (404 to avoid leaking existence).
  const gateInstance = (c: any, rt: string, resource: FhirResource, verb: RequestVerb): void => {
    const df = dataFilterFor(c, rt, verb);
    if (df?.patientCompartmentId && !inCompartment(rt, resource, df.patientCompartmentId)) {
      throw notFound(rt, resource.id ?? "");
    }
  };

  /** Cross-compartment WRITE guard (reads were gated, writes were not): a patient-restricted
   * caller may only mutate resources inside its own compartment. Rejects (404, no existence
   * disclosure) when the target's current state — or the incoming body — is out-of-compartment. */
  const gateWrite = async (c: any, rt: string, id: string, incoming?: FhirResource): Promise<void> => {
    const df = dataFilterFor(c, rt, "u");
    if (!df?.patientCompartmentId) return; // system / no-auth → repo-level rules apply
    const current = await repo(rt).read(id).catch(() => null);
    if (current) gateInstance(c, rt, current, "u");
    if (incoming) gateInstance(c, rt, incoming, "u");
  };

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
      // ATOMIC conditional create: hold the table write-chain across the match-check AND the
      // create, so two concurrent If-None-Exist creates can't both see 0 matches and both
      // insert (duplicate business identifier). resolveConditional/searchByParams are reads
      // (no lock) and createUnlocked skips the self-lock, so this is race-free within-process.
      const outcome = await wh.serializeTable("bronze", rt, async (): Promise<{ created: boolean; resource: FhirResource }> => {
        const { total, match } = await resolveConditional(rt, ifNoneExist);
        if (total > 1) throw preconditionFailed(`If-None-Exist matched ${total} resources — not created`);
        if (total === 1) return { created: false, resource: match! };
        return { created: true, resource: await repo(rt).createUnlocked(resource) };
      });
      const r = outcome.resource;
      if (!outcome.created) {
        return c.json(r, 200, { Location: `${baseUrl}/${rt}/${r.id}`, ETag: `W/"${r.meta?.versionId ?? "1"}"` });
      }
      return c.json(r, 201, {
        Location: `${baseUrl}/${rt}/${r.id}`,
        ETag: `W/"${r.meta?.versionId ?? "1"}"`,
        "Last-Modified": r.meta?.lastUpdated ?? new Date().toISOString(),
      });
    }
    const created = await repo(rt).create(resource);
    return c.json(created, 201, {
      Location: `${baseUrl}/${rt}/${created.id}`,
      ETag: `W/"${created.meta?.versionId ?? "1"}"`,
      "Last-Modified": created.meta?.lastUpdated ?? new Date().toISOString(),
    });
  });

  // GET|POST /Patient/:id/$everything  — the patient + its compartment members, PAGED + _since.
  const everything = async (c: any) => {
    const id = c.req.param("id");
    // patient-compartment scope: a patient-restricted token may only run $everything for its own patient.
    const edf = dataFilterFor(c, "Patient", "r");
    if (edf?.patientCompartmentId && edf.patientCompartmentId !== id) throw notFound("Patient", id);
    const patient = await repo("Patient").read(id); // 404/410 guard
    const ref = `Patient/${id}`;
    const typeFilter = c.req.query("_type")?.split(",").map((s: string) => s.trim()).filter(Boolean);
    const since = c.req.query("_since") || undefined; // filter by meta.lastUpdated (was ignored)
    const count = clampInt(c.req.query("_count"), 100);
    const offset = clampInt(c.req.query("_getpagesoffset"), 0);
    // The patient record itself is consent-gated too (throws 403 if the caller can't see it).
    await enforceReadConsent(wh, patient, c.get("auth"));
    const auth = c.get("auth");
    const sinceOk = (r: FhirResource) => !since || String((r.meta as { lastUpdated?: string } | undefined)?.lastUpdated ?? "") >= since;

    // Assemble the full compartment (patient + members), then paginate for a stable, bounded page.
    const all: FhirResource[] = sinceOk(patient) ? [patient] : [];
    for (const [rt, params] of Object.entries(patientCompartment)) {
      if (rt === "Patient" || !wh.hasTable(rt.toLowerCase())) continue;
      if (typeFilter?.length && !typeFilter.includes(rt)) continue;
      const matches = (await filterReadConsent(wh, await repo(rt).findReferencing(params, ref), auth)).allowed;
      for (const m of matches) if (sinceOk(m)) all.push(m);
    }
    // Deterministic order (resourceType, id) so paging is stable across requests.
    all.sort((a, b) => `${(a as any).resourceType}/${a.id}`.localeCompare(`${(b as any).resourceType}/${b.id}`));
    const total = all.length;
    const page = all.slice(offset, offset + count);

    const query = new URLSearchParams(c.req.url.split("?")[1] ?? "");
    const link = [{ relation: "self", url: `${baseUrl}/Patient/${id}/$everything?${query.toString()}` }];
    if (offset + count < total) {
      const nx = new URLSearchParams(query);
      nx.set("_count", String(count));
      nx.set("_getpagesoffset", String(offset + count));
      link.push({ relation: "next", url: `${baseUrl}/Patient/${id}/$everything?${nx.toString()}` });
    }
    return c.json({
      resourceType: "Bundle", type: "searchset", timestamp: new Date().toISOString(), total, link,
      entry: page.map((r) => ({ fullUrl: `${baseUrl}/${(r as any).resourceType}/${r.id}`, resource: applyObligations(r, auth), search: { mode: "match" } })),
    });
  };
  app.get("/Patient/:id/$everything", everything);
  app.post("/Patient/:id/$everything", everything);

  // ---- Bulk Data $export (async, disk-backed) — see src/routes/export.ts ----
  mountExport(app, wh, baseUrl);

  // GET /_history  — system-level history across all resource types (merged, paged).
  app.get("/_history", async (c) => {
    // System-level history spans all patients; not available under a patient-restricted scope.
    if (dataFilterFor(c, "Resource", "s")?.patientCompartmentId) throw forbidden("system-level _history is not available under a patient-restricted scope");
    const count = clampInt(c.req.query("_count"), 50);
    const offset = clampInt(c.req.query("_getpagesoffset"), 0);
    // One DataFusion UNION+ORDER+LIMIT across all existing Bronze tables — the engine sorts +
    // pages (was: pull offset+count from all 146 tables into Node and JS-sort per request).
    const types = r4CoreResourceTypes.filter((rt) => wh.hasTable(rt.toLowerCase()));
    const { rows: page, total } = await wh.systemHistory(types, count, offset);
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
      entry: page.map((row) => historyEntry(row as any, baseUrl, row.rt, c.get("auth"))),
    });
  });

  // GET /:resourceType/:id/_history/:vid  (vread — version read)
  app.get("/:resourceType/:id/_history/:vid", async (c) => {
    const rt = c.req.param("resourceType");
    assertR4Core(rt);
    const resource = await repo(rt).readVersion(c.req.param("id"), Number(c.req.param("vid")));
    gateInstance(c, rt, resource, "r"); // patient-compartment scope
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
    // patient-compartment scope: gate on the newest version's compartment membership.
    const df = dataFilterFor(c, rt, "r");
    if (df?.patientCompartmentId) {
      const newest = JSON.parse((versions[0] as any).body_json) as FhirResource;
      if (!inCompartment(rt, newest, df.patientCompartmentId)) throw notFound(rt, id);
    }
    return c.json({
      resourceType: "Bundle",
      type: "history",
      timestamp: new Date().toISOString(),
      total: versions.length,
      entry: versions.map((v) => historyEntry(v as any, baseUrl, rt, c.get("auth"))),
    });
  });

  // GET /:resourceType/_history  (type-level history, paged)
  app.get("/:resourceType/_history", async (c) => {
    const rt = c.req.param("resourceType");
    assertR4Core(rt);
    // Type-level history spans all patients; not available under a patient-restricted scope.
    if (dataFilterFor(c, rt, "s")?.patientCompartmentId) throw forbidden("type-level _history is not available under a patient-restricted scope");
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
      entry: rows.map((v) => historyEntry(v as any, baseUrl, rt, c.get("auth"))),
    });
  });

  // GET /:resourceType/:id
  app.get("/:resourceType/:id", async (c) => {
    const rt = c.req.param("resourceType");
    assertR4Core(rt);
    const resource = await repo(rt).read(c.req.param("id"));
    gateInstance(c, rt, resource, "r"); // patient-compartment scope
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
    await gateWrite(c, rt, c.req.param("id"), resource); // cross-compartment write guard
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
    const rt = c.req.param("resourceType");
    assertR4Core(rt);
    await gateWrite(c, rt, c.req.param("id")); // cross-compartment write guard
    await repo(rt).delete(c.req.param("id"));
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
      await gateWrite(c, rt, match!.id!, resource); // cross-compartment write guard
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
    if (total === 1) {
      await gateWrite(c, rt, match!.id!); // cross-compartment write guard
      await repo(rt).delete(match!.id!);
    }
    return c.body(null, 204); // 0 or 1 → 204 (no-op when none matched)
  });

  // GET /:resourceType  — search. Reserved control params (_id/_lastUpdated on base columns,
  // paging, sort) + per-resource params (token/string/date) from the R4 SearchParameter
  // registry, matched against the materialized search index (multi-param AND).
  // Shared search executor (GET `[type]?...` and POST `[type]/_search`). `sp` is the merged
  // parameter set (URL query for GET; form body + URL query for POST per the FHIR search spec).
  const recordOf = (sp: URLSearchParams): Record<string, string[]> => {
    const rec: Record<string, string[]> = {};
    for (const k of sp.keys()) rec[k] = sp.getAll(k);
    return rec;
  };
  const runSearch = async (c: any, rt: string, sp: URLSearchParams) => {
    const count = clampInt(sp.get("_count") ?? undefined, 50);
    const offset = clampInt(sp.get("_getpagesoffset") ?? undefined, 0);
    // _sort: only the first field is applied. Numeric/quantity sorts cast so 10 > 9.
    const sortFields = (sp.get("_sort") ?? "").split(",").filter(Boolean);
    const sortRaw = (sp.get("_sort") ?? "-_lastUpdated").split(",")[0]!;
    const sortDesc = sortRaw.startsWith("-");
    const sortField = sortRaw.replace(/^-/, "");
    const sortDef = sortField !== "_lastUpdated" ? searchParam(rt, sortField) : undefined;
    const sortParam = sortDef ? sortField : undefined;
    const sortNumeric = sortDef?.type === "number" || sortDef?.type === "quantity";

    // Unified search: per-resource conditions + chaining/_has + base-column filters.
    const queries = recordOf(sp);

    // Reject search params we cannot apply rather than silently returning a broader (wrong) set:
    // composite/special params always; unknown params + multi-field _sort under Prefer:handling=strict.
    const strict = /(^|[,\s])handling=strict/.test(c.req.header("Prefer") ?? "");
    const unsupported = unsupportedSearchParams(rt, queries, strict);
    if (strict && sortFields.length > 1) unsupported.push("_sort (only the first field is applied)");
    if (unsupported.length) throw badRequest(`Unsupported search parameter(s): ${unsupported.join(", ")}`, unsupported);

    const { conds: chainConds, idIn } = await resolveChainsAndHas(rt, queries);
    const conds = [...buildConds(rt, queries), ...chainConds];
    const lastUpdated = sp.getAll("_lastUpdated").map(parseRangeParam).filter((x): x is { op: string; value: string } => x !== null);

    // Auth points 3+4: scope this search to the caller's patient compartment + granular restrictions.
    let effIdIn = idIn;
    const df = dataFilterFor(c, rt, "s");
    if (df?.patientCompartmentId) {
      const cids = await compartmentIds(rt, df.patientCompartmentId);
      effIdIn = effIdIn ? effIdIn.filter((x) => cids.includes(x)) : cids;
    }
    if (df) {
      for (const [code, values] of Object.entries(df.queryRestrictions)) {
        conds.push({ code, type: searchParam(rt, code)?.type ?? "token", value: "", valueIn: values });
      }
    }

    let resources: FhirResource[];
    let total: number;
    {
      const r = await repo(rt).searchByParams({ conds, id: sp.get("_id") ?? undefined, idIn: effIdIn, lastUpdated, count, offset, sortDesc, sortParam, sortNumeric });
      resources = r.resources;
      total = r.total;
    }

    // _include / _revinclude — resolve referenced (or referencing) resources as include entries.
    const seen = new Set(resources.map((r) => `${rt}/${r.id}`));
    const includeEntries: any[] = [];
    const addInclude = (type: string, res: FhirResource): FhirResource | null => {
      const key = `${type}/${res.id}`;
      if (seen.has(key)) return null;
      seen.add(key);
      includeEntries.push({ fullUrl: `${baseUrl}/${type}/${res.id}`, resource: res, search: { mode: "include" } });
      return res;
    };
    // Resolve one `_include` spec (`SourceType:param[:targetType]`) over a working set; returns
    // the newly-added resources (for `:iterate` to follow transitively).
    const resolveInclude = async (spec: string, sources: FhirResource[]): Promise<FhirResource[]> => {
      const [srcType, param, targetType] = spec.split(":");
      const def = srcType && param && isR4CoreResource(srcType) ? searchParam(srcType, param) : undefined;
      if (!def || def.type !== "reference") return [];
      const added: FhirResource[] = [];
      for (const res of sources) {
        if ((res as any).resourceType !== srcType) continue;
        let refs: string[] = [];
        try { refs = (fhirpath.evaluate(res as any, def.expression, undefined, fhirpathR4Model) as any[]).map((x) => x?.reference).filter(Boolean); } catch { /* skip */ }
        for (const ref of refs) {
          const [tType, tId] = ref.split("/");
          if (!tType || !tId || !isR4CoreResource(tType) || (targetType && tType !== targetType)) continue;
          try { const inc = addInclude(tType, await repo(tType).read(tId)); if (inc) added.push(inc); } catch { /* unresolvable / deleted */ }
        }
      }
      return added;
    };
    for (const inc of sp.getAll("_include")) await resolveInclude(inc, resources);
    // `_include:iterate` — follow includes transitively over the growing set (bounded depth).
    const iterateSpecs = sp.getAll("_include:iterate");
    if (iterateSpecs.length) {
      let frontier = [...resources, ...includeEntries.map((e) => e.resource as FhirResource)];
      for (let depth = 0; depth < 5 && frontier.length; depth++) {
        const next: FhirResource[] = [];
        for (const spec of iterateSpecs) next.push(...await resolveInclude(spec, frontier));
        if (!next.length) break;
        frontier = next;
      }
    }
    for (const rev of sp.getAll("_revinclude")) {
      const [srcType, param] = rev.split(":");
      if (!srcType || !param || !isR4CoreResource(srcType)) continue; // guard bogus/non-core types
      const def = searchParam(srcType, param);
      if (!def || def.type !== "reference") continue;
      for (const res of resources) {
        for (const m of await repo(srcType).findReferencing([param], `${rt}/${res.id}`)) addInclude(srcType, m);
      }
    }

    const link = [{ relation: "self", url: `${baseUrl}/${rt}?${sp.toString()}` }];
    if (offset + count < total) {
      const nx = new URLSearchParams(sp);
      nx.set("_count", String(count));
      nx.set("_getpagesoffset", String(offset + count));
      link.push({ relation: "next", url: `${baseUrl}/${rt}?${nx.toString()}` });
    }

    // _summary=count → totals only, no entries.
    if (sp.get("_summary") === "count") {
      return c.json({ resourceType: "Bundle", type: "searchset", timestamp: new Date().toISOString(), total, link });
    }
    // _elements / _summary=text → trim returned elements (mandatory id/meta always kept).
    const elements = sp.get("_elements")?.split(",").map((s) => s.trim()).filter(Boolean);
    const summaryText = sp.get("_summary") === "text";
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

    // _include/_revinclude entries are fetched by DIRECT read → they bypass both the
    // query-layer compartment filter and the match consent filter. Gate them the same way
    // (audit M1) so a caller can't exfiltrate a compartment-foreign or consent-blocked
    // resource by naming it as an include target.
    const authCtx = c.get("auth");
    let includeResources = includeEntries.map((e) => e.resource as FhirResource);
    if (authCtx) {
      includeResources = includeResources.filter((r) => {
        const df = dataFilterFor(c, (r as any).resourceType, "r");
        return !df?.patientCompartmentId || inCompartment((r as any).resourceType, r, df.patientCompartmentId);
      });
    }
    includeResources = (await filterReadConsent(wh, includeResources, authCtx)).allowed;
    const allowedInc = new Set(includeResources.map((r) => `${(r as any).resourceType}/${r.id}`));
    const visibleIncludes = includeEntries.filter((e) => allowedInc.has(`${(e.resource as any).resourceType}/${e.resource.id}`));

    return c.json({
      resourceType: "Bundle",
      type: "searchset",
      timestamp: new Date().toISOString(),
      total: matchTotal,
      link,
      entry: [
        ...visible.map((r) => ({ fullUrl: `${baseUrl}/${rt}/${r.id}`, resource: shape(r), search: { mode: "match" } })),
        ...visibleIncludes.map((e) => ({ ...e, resource: shape(e.resource) })),
      ],
    });
  };

  app.get("/:resourceType", async (c) => {
    const rt = c.req.param("resourceType");
    assertR4Core(rt);
    return runSearch(c, rt, new URL(c.req.url).searchParams);
  });

  // POST [type]/_search — form-encoded search (FHIR search spec; US Core / (g)(10) require it).
  // Params are the union of the form body and any URL query params.
  app.post("/:resourceType/_search", async (c) => {
    const rt = c.req.param("resourceType");
    assertR4Core(rt);
    const sp = new URLSearchParams(await c.req.text());
    for (const [k, v] of new URL(c.req.url).searchParams) sp.append(k, v);
    return runSearch(c, rt, sp);
  });

  return app;
}
