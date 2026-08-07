/**
 * FHIR terminology *operation* endpoints — exposing the local Delta-backed terminology store
 * (the same `validateCode` used internally for L3 binding validation) as a real terminology
 * server, so external clients — including the HL7 validator Inferno drives — can use THIS
 * server for `$validate-code` / `$expand` / `$lookup` instead of a remote tx server.
 *
 *   POST|GET /ValueSet/$validate-code    (url = ValueSet, + code/system or coding)
 *   POST|GET /CodeSystem/$validate-code  (url|system = CodeSystem, + code or coding)
 *   POST|GET /ValueSet/$expand           (url = ValueSet)
 *   POST|GET /CodeSystem/$lookup         (system + code or coding)
 *
 * These MUST be mounted before the generic `/:resourceType/:id` routes.
 */
import { Hono } from "hono";
import type { DeltaWarehouse } from "../lib/delta-warehouse.js";
import { validateCode } from "../terminology/validate-code.js";
import { overlayFor, type TxOverlay } from "../terminology/tx-resource-overlay.js";

interface Coding { system?: string; code?: string; display?: string; version?: string }

/** Read operation params from the query string and/or a POST `Parameters` body — flat params
 * plus the set of codings to validate (from `coding`, `codeableConcept`, or `code`+`system`)
 * and the request-scoped terminology overlay (`tx-resource` / `cache-id` — the
 * CodeSystemAsParameter capability the HL7 validator ecosystem requires). */
async function readParams(c: any): Promise<{ p: Record<string, string>; codings: Coding[]; overlay: TxOverlay }> {
  const p: Record<string, string> = {};
  const codings: Coding[] = [];
  const txResources: any[] = [];
  for (const [k, v] of new URL(c.req.url).searchParams) p[k] = v;
  if (c.req.method === "POST") {
    const body = await c.req.json().catch(() => null);
    if (body?.resourceType === "Parameters") {
      for (const pr of body.parameter ?? []) {
        if (pr.name === "tx-resource" && pr.resource) { txResources.push(pr.resource); continue; }
        if (pr.valueUri != null) p[pr.name] = pr.valueUri;
        else if (pr.valueString != null) p[pr.name] = pr.valueString;
        else if (pr.valueCode != null) p[pr.name] = pr.valueCode;
        else if (pr.valueId != null) p[pr.name] = pr.valueId;
        else if (pr.valueUuid != null) p[pr.name] = pr.valueUuid;
        else if (pr.valueBoolean != null) p[pr.name] = String(pr.valueBoolean);
        else if (pr.valueInteger != null) p[pr.name] = String(pr.valueInteger);
        else if (pr.valueCoding) { codings.push({ ...pr.valueCoding }); p.system ??= pr.valueCoding.system; p.code ??= pr.valueCoding.code; }
        else if (pr.valueCodeableConcept?.coding) for (const cd of pr.valueCodeableConcept.coding) codings.push({ ...cd });
        else if (pr.resource?.resourceType === "ValueSet" && pr.resource.url) {
          // inline valueSet param: usable both as the target url and as overlay content
          p.url ??= pr.resource.url;
          txResources.push(pr.resource);
        }
      }
    } else if (body?.resourceType === "ValueSet" && body.url) {
      p.url = body.url; // inline ValueSet resource → validate against its canonical (if loaded)
      txResources.push(body);
    }
  }
  if (p.code && !codings.length) codings.push({ system: p.system, code: p.code }); // code+system → a coding
  const overlay = overlayFor(p["cache-id"], txResources);
  return { p, codings, overlay };
}

const param = (name: string, value: unknown, kind = "valueString") =>
  value === undefined || value === null ? [] : [{ name, [kind]: value }];

/** OperationOutcome carried in the `issues` param — severity drives how the validator reports it. */
function issues(severity: "error" | "warning", code: string, text: string) {
  return { name: "issues", resource: { resourceType: "OperationOutcome", issue: [{ severity, code, details: { text } }] } };
}

export function terminologyRoutes(wh: DeltaWarehouse): Hono {
  const app = new Hono();

  const doValidateCode = (kind: "valueSet" | "codeSystem") => async (c: any) => {
    const { p, codings, overlay } = await readParams(c);
    const target = p.url ?? (kind === "codeSystem" ? p.system : undefined);
    if (!target || !codings.length) {
      return c.json({ resourceType: "Parameters", parameter: [{ name: "result", valueBoolean: false }, ...param("message", `${kind} $validate-code requires url${kind === "codeSystem" ? "|system" : ""} + a code/coding/codeableConcept`)] }, 400);
    }
    // Overlay first: if the client supplied the ValueSet/CodeSystem via
    // tx-resource, answer from those resources (definitive — the client's
    // terminology is the truth for its own IG content).
    const overlayKnowsTarget =
      kind === "valueSet" ? overlay.valueSet(target) !== undefined : overlay.codeSystem(target) !== undefined;
    if (overlayKnowsTarget) {
      let verdict = null;
      for (const cd of codings) {
        if (!cd.code) continue;
        const r = overlay.validate(kind === "valueSet" ? target : undefined, { system: kind === "codeSystem" ? target : cd.system, code: cd.code, version: cd.version });
        if (r === null) { verdict = null; break; } // needs store data → fall through
        verdict = r;
        if (r.status === "valid") break;
      }
      if (verdict !== null) {
        const parameter: any[] = [];
        parameter.push({ name: "code", valueCode: verdict.code });
        if (verdict.status === "valid") {
          if (verdict.display) parameter.push({ name: "display", valueString: verdict.display });
          parameter.push({ name: "result", valueBoolean: true });
          parameter.push({ name: "system", valueUri: verdict.system });
          if (verdict.version) parameter.push({ name: "version", valueString: verdict.version });
        } else {
          const txIssue = (code: string, type: string, text: string) => ({
            name: "issues",
            resource: {
              resourceType: "OperationOutcome",
              issue: [{ severity: "error", code, details: { coding: [{ system: "http://hl7.org/fhir/tools/CodeSystem/tx-issue-type", code: type }], text } }],
            },
          });
          parameter.push({ name: "message", valueString: verdict.message });
          parameter.push({ name: "result", valueBoolean: false });
          if (verdict.system) parameter.push({ name: "system", valueUri: verdict.system });
          if ("version" in verdict && verdict.version) parameter.push({ name: "version", valueString: verdict.version });
          if (verdict.status === "not-in-vs") parameter.push(txIssue("code-invalid", "not-in-vs", verdict.message));
          else if (verdict.status === "invalid-code") parameter.push(txIssue("code-invalid", "invalid-code", verdict.message));
          else parameter.push(txIssue("not-found", "not-found", verdict.message));
        }
        return c.json({ resourceType: "Parameters", parameter });
      }
    }
    // CodeableConcept / multiple codings: valid if ANY coding validates; else invalid if the VS/CS
    // is loaded and none match; else unknown (not loaded → can't validate).
    let anyValid = false, anyInvalid = false, anyUnknown = false;
    let matched: { system?: string; code: string; display: string | null } | null = null;
    let lastMsg: string | undefined;
    for (const cd of codings) {
      if (!cd.code) continue;
      const r = await validateCode(wh, kind === "valueSet" ? { code: cd.code, valueSet: target, system: cd.system } : { code: cd.code, system: target });
      lastMsg = r.message ?? lastMsg;
      if (r.status === "valid") { anyValid = true; matched = { system: cd.system, code: cd.code, display: r.display }; break; }
      if (r.status === "invalid") anyInvalid = true; else anyUnknown = true;
    }
    const first = codings.find((cd) => cd.code) ?? {};
    const parameter: any[] = [{ name: "result", valueBoolean: anyValid }];
    if (matched?.display) parameter.push({ name: "display", valueString: matched.display });
    if ((matched?.system ?? first.system)) parameter.push({ name: "system", valueUri: matched?.system ?? first.system });
    parameter.push({ name: "code", valueCode: matched?.code ?? first.code });
    if (!anyValid && lastMsg) parameter.push({ name: "message", valueString: lastMsg });
    if (!anyValid && anyInvalid) parameter.push(issues("error", "code-invalid", lastMsg ?? "no coding in the value set"));
    else if (!anyValid && anyUnknown) parameter.push(issues("warning", "not-found", lastMsg ?? "not validated"));
    return c.json({ resourceType: "Parameters", parameter });
  };

  app.get("/ValueSet/$validate-code", doValidateCode("valueSet"));
  app.post("/ValueSet/$validate-code", doValidateCode("valueSet"));
  app.get("/CodeSystem/$validate-code", doValidateCode("codeSystem"));
  app.post("/CodeSystem/$validate-code", doValidateCode("codeSystem"));

  // System-level $versions (CapabilityStatement-versions operation): the FHIR
  // versions this server speaks. HL7 tx clients (validator, TxTester) probe
  // GET /$versions at connect time to pick a version-specific endpoint. Note:
  // the ecosystem clients read `default` via valueString (the OperationDefinition
  // says valueCode), so `default` is emitted as valueString for compatibility
  // while the repeating `version` stays spec-shaped.
  const doVersions = (c: any) =>
    c.json({
      resourceType: "Parameters",
      parameter: [
        { name: "version", valueCode: "4.0.1" },
        { name: "default", valueString: "4.0.1" },
      ],
    });
  app.get("/$versions", doVersions);
  app.post("/$versions", doVersions);

  const doExpand = async (c: any) => {
    const { p, overlay } = await readParams(c);
    if (!p.url) return c.json({ resourceType: "OperationOutcome", issue: [{ severity: "error", code: "required", details: { text: "$expand requires url" } }] }, 400);
    // Overlay first: expand a client-supplied ValueSet against client-supplied
    // CodeSystems (in-memory), falling back to the Delta store otherwise.
    const overlayVs = overlay.valueSet(p.url);
    if (overlayVs) {
      const r = overlay.expand(overlayVs, {
        count: p.count !== undefined ? Math.max(0, Math.min(Number(p.count), 5000)) : undefined,
        offset: p.offset !== undefined ? Math.max(0, Math.trunc(Number(p.offset)) || 0) : undefined,
        textFilter: p.filter,
        activeOnly: p.activeOnly !== undefined ? p.activeOnly === "true" : undefined,
        excludeNested: p.excludeNested !== undefined ? p.excludeNested === "true" : undefined,
      });
      if (r.valueSet) return c.json(r.valueSet);
      return c.json({ resourceType: "OperationOutcome", issue: [{ severity: "error", code: "not-supported", details: { text: r.error } }] }, 422);
    }
    const count = Math.max(0, Math.min(Number(p.count ?? "1000"), 5000));
    const offset = Math.max(0, Math.trunc(Number(p.offset ?? "0")) || 0);
    const filter = p.filter?.toLowerCase();
    wh.registerTerminology("valueset_expansion");
    // `filter` is a case-insensitive substring over code + display (FHIR $expand text filter).
    const where = filter ? "valueset = ? AND (lower(code) LIKE ? OR lower(display) LIKE ?)" : "valueset = ?";
    const args = filter ? [p.url, `%${filter}%`, `%${filter}%`] : [p.url];
    const totalRows = await wh.query<{ n: number }>(`SELECT count(*) AS n FROM valueset_expansion WHERE ${where}`, args);
    const total = Number(totalRows[0]?.n ?? 0);
    const rows = await wh.query<{ system: string; code: string; display: string | null }>(
      `SELECT system, code, display FROM valueset_expansion WHERE ${where} LIMIT ${count} OFFSET ${offset}`, args,
    );
    return c.json({
      resourceType: "ValueSet", url: p.url, status: "active",
      expansion: {
        timestamp: new Date().toISOString(), total, offset,
        ...(filter ? { parameter: [{ name: "filter", valueString: p.filter }] } : {}),
        contains: rows.map((r) => ({ system: r.system, code: r.code, ...(r.display ? { display: r.display } : {}) })),
      },
    });
  };
  app.get("/ValueSet/$expand", doExpand);
  app.post("/ValueSet/$expand", doExpand);

  const doLookup = async (c: any) => {
    const { p, overlay } = await readParams(c);
    if (!p.system || !p.code) return c.json({ resourceType: "OperationOutcome", issue: [{ severity: "error", code: "required", details: { text: "$lookup requires system + code" } }] }, 400);
    const fromOverlay = overlay.lookupDisplay(p.system, p.code);
    if (fromOverlay) {
      return c.json({ resourceType: "Parameters", parameter: [...param("name", p.system, "valueString"), ...param("display", fromOverlay.display ?? "", "valueString"), ...(fromOverlay.version ? param("version", fromOverlay.version, "valueString") : [])] });
    }
    wh.registerTerminology("codesystem_concept");
    const hit = await wh.query<{ display: string | null }>(
      "SELECT display FROM codesystem_concept WHERE system = ? AND code = ? LIMIT 1", [p.system, p.code],
    );
    if (!hit.length) return c.json({ resourceType: "Parameters", parameter: [...param("message", `code '${p.code}' not found in ${p.system}`), issues("error", "not-found", "code not found")] }, 404);
    return c.json({ resourceType: "Parameters", parameter: [...param("name", p.system, "valueString"), ...param("display", hit[0].display ?? "", "valueString")] });
  };
  app.get("/CodeSystem/$lookup", doLookup);
  app.post("/CodeSystem/$lookup", doLookup);

  return app;
}
