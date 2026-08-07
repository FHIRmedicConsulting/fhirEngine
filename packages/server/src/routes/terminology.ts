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
 *
 * Version-aware behavior (multiple CodeSystem versions, ValueSet version pins,
 * system-version / check-system-version / force-system-version) follows the
 * tx-ecosystem battery contract; see terminology/tx-resource-overlay.ts.
 */
import { Hono } from "hono";
import type { DeltaWarehouse } from "../lib/delta-warehouse.js";
import { validateCode } from "../terminology/validate-code.js";
import {
  overlayFor,
  parseVersionParams,
  txMessages,
  type RichValidation,
  type TxIssueSpec,
  type TxOverlay,
  type VersionParams,
} from "../terminology/tx-resource-overlay.js";

interface Coding { system?: string; code?: string; display?: string; version?: string }

type InputKind = "code" | "coding" | "codeableConcept";

interface ReadResult {
  p: Record<string, string>;
  codings: Coding[];
  overlay: TxOverlay;
  versionParams: VersionParams;
  inputKind: InputKind;
  /** original codeableConcept for the response echo */
  codeableConcept?: any;
  /** the target ValueSet arrived inline (valueSet param / raw body) — its
   * compose is not echoed in expansions, per the tx.fhir.org contract */
  inlineValueSet: boolean;
  /** repeatable params captured as lists (version params, property) */
  repeat: Record<string, string[]>;
}

/** Read operation params from the query string and/or a POST `Parameters` body — flat params
 * plus the set of codings to validate (from `coding`, `codeableConcept`, or `code`+`system`)
 * and the request-scoped terminology overlay (`tx-resource` / `cache-id` — the
 * CodeSystemAsParameter capability the HL7 validator ecosystem requires). */
async function readParams(c: any): Promise<ReadResult> {
  const p: Record<string, string> = {};
  const codings: Coding[] = [];
  const txResources: any[] = [];
  const repeat: Record<string, string[]> = { "force-system-version": [], "check-system-version": [], "system-version": [], property: [] };
  let inputKind: InputKind = "code";
  let codeableConcept: any;
  let inlineValueSet = false;
  const scalar = (name: string, value: string) => {
    if (name in repeat) repeat[name].push(value);
    else p[name] = value;
  };
  for (const [k, v] of new URL(c.req.url).searchParams) scalar(k, v);
  if (c.req.method === "POST") {
    const body = await c.req.json().catch(() => null);
    if (body?.resourceType === "Parameters") {
      for (const pr of body.parameter ?? []) {
        if (pr.name === "tx-resource" && pr.resource) { txResources.push(pr.resource); continue; }
        const v =
          pr.valueUri ?? pr.valueCanonical ?? pr.valueString ?? pr.valueCode ?? pr.valueId ?? pr.valueUuid ??
          (pr.valueBoolean != null ? String(pr.valueBoolean) : undefined) ??
          (pr.valueInteger != null ? String(pr.valueInteger) : undefined);
        if (v != null) { scalar(pr.name, v); continue; }
        if (pr.valueCoding) {
          inputKind = "coding";
          codings.push({ ...pr.valueCoding });
          p.system ??= pr.valueCoding.system;
          p.code ??= pr.valueCoding.code;
        } else if (pr.valueCodeableConcept?.coding) {
          inputKind = "codeableConcept";
          codeableConcept = pr.valueCodeableConcept;
          for (const cd of pr.valueCodeableConcept.coding) codings.push({ ...cd });
        } else if (pr.resource?.resourceType === "ValueSet" && pr.resource.url) {
          // inline valueSet param: usable both as the target url and as overlay content
          p.url ??= pr.resource.url;
          txResources.push(pr.resource);
          inlineValueSet = true;
        }
      }
    } else if (body?.resourceType === "ValueSet" && body.url) {
      p.url = body.url; // inline ValueSet resource → validate against its canonical (if loaded)
      txResources.push(body);
      inlineValueSet = true;
    }
  }
  if (p.code && !codings.length) {
    // code (+ optional systemVersion/display) form
    codings.push({ system: p.system, code: p.code, ...(p.systemVersion ? { version: p.systemVersion } : {}), ...(p.display ? { display: p.display } : {}) });
  }
  const overlay = overlayFor(p["cache-id"], txResources);
  const versionParams = parseVersionParams({
    force: repeat["force-system-version"],
    check: repeat["check-system-version"],
    deflt: repeat["system-version"],
  });
  return { p, codings, overlay, versionParams, inputKind, codeableConcept, inlineValueSet, repeat };
}

const param = (name: string, value: unknown, kind = "valueString") =>
  value === undefined || value === null ? [] : [{ name, [kind]: value }];

/** OperationOutcome carried in the `issues` param — severity drives how the validator reports it. */
function issues(severity: "error" | "warning", code: string, text: string) {
  return { name: "issues", resource: { resourceType: "OperationOutcome", issue: [{ severity, code, details: { text } }] } };
}

const MSG_ID_EXT = "http://hl7.org/fhir/StructureDefinition/operationoutcome-message-id";
const TX_ISSUE_TYPE = "http://hl7.org/fhir/tools/CodeSystem/tx-issue-type";

/** Map a TxIssueSpec element onto the concrete input path for location/expression. */
function issuePath(element: TxIssueSpec["element"], kind: InputKind): string | undefined {
  if (element === "coding") {
    // whole-value reference (e.g. INACTIVE_CONCEPT_FOUND)
    return kind === "codeableConcept" ? "CodeableConcept.coding[0]" : kind === "coding" ? "Coding" : undefined;
  }
  if (element !== "version" && element !== "system" && element !== "code" && element !== "display") return undefined;
  if (kind === "code") return element;
  if (kind === "coding") return `Coding.${element}`;
  return `CodeableConcept.coding[0].${element}`;
}

function issueToOO(spec: TxIssueSpec, kind: InputKind) {
  const path = issuePath(spec.element, kind);
  // version/system issues carry location+expression; code-level issues carry
  // expression only (matches current tx.fhir.org output — location is legacy there)
  const withLocation = spec.element === "version" || spec.element === "system";
  return {
    ...(spec.msgId ? { extension: [{ url: MSG_ID_EXT, valueString: spec.msgId }] } : {}),
    severity: spec.severity ?? "error",
    code: spec.issueCode,
    details: { coding: [{ system: TX_ISSUE_TYPE, code: spec.txType }], text: spec.text },
    ...(path ? { ...(withLocation ? { location: [path] } : {}), expression: [path] } : {}),
  };
}

function outcomeResource(specs: TxIssueSpec[], kind: InputKind) {
  return { resourceType: "OperationOutcome", issue: specs.map((s) => issueToOO(s, kind)) };
}

/** Render a rich overlay validation as the battery-shaped Parameters response
 * (parameters in alphabetical order; message = sorted ERROR-issue texts joined by "; "). */
function renderRichValidation(rich: RichValidation, kind: InputKind, codeableConcept: any | undefined, vsLabel?: string) {
  // per-coding informational "this-code-not-in-vs" issues only appear on
  // CodeableConcept responses (they support the aggregate wrapper)
  let specs = rich.issues.filter((i) => !(i.txType === "this-code-not-in-vs" && kind !== "codeableConcept"));
  // A failing CodeableConcept whose codings were unknown (bad code or bad
  // system) gets the aggregate contract: a "no valid coding" wrapper first,
  // per-coding not-in-vs errors demoted to informational, code/system echoes
  // dropped (tx.fhir.org shape).
  const ccAggregate =
    kind === "codeableConcept" &&
    !rich.result &&
    vsLabel !== undefined &&
    (rich.unknownSystem !== undefined || rich.issues.some((i) => i.txType === "invalid-code" && (i.severity ?? "error") === "error"));
  if (ccAggregate) {
    const transformed: TxIssueSpec[] = specs.map((i) =>
      i.txType === "not-in-vs" && (i.severity ?? "error") === "error"
        ? { ...i, severity: "information", txType: "this-code-not-in-vs" }
        : i,
    );
    specs = [
      { msgId: "TX_GENERAL_CC_ERROR_MESSAGE", issueCode: "code-invalid", txType: "not-in-vs", element: "none", text: `No valid coding was found for the value set '${vsLabel}'` },
      ...transformed.filter((i) => (i.severity ?? "error") === "error"),
      ...transformed.filter((i) => i.severity === "warning"),
      ...transformed.filter((i) => i.severity === "information"),
    ];
  }
  // tx.fhir.org echo quirks: CC responses drop code+system when the ValueSet
  // pinned an unknown version, and everything but the CC itself when the
  // codings were unknown.
  const dropCodeSystem = kind === "codeableConcept" && (rich.pinUnknown === true || ccAggregate);
  const parameter: any[] = [];
  if (rich.code !== undefined && !dropCodeSystem) parameter.push({ name: "code", valueCode: rich.code });
  if (codeableConcept !== undefined) parameter.push({ name: "codeableConcept", valueCodeableConcept: codeableConcept });
  if (rich.display !== undefined && !ccAggregate) parameter.push({ name: "display", valueString: rich.display });
  if (rich.inactive) parameter.push({ name: "inactive", valueBoolean: true });
  if (specs.length) parameter.push({ name: "issues", resource: outcomeResource(specs, kind) });
  if (specs.length) {
    // message = error texts; warnings message only for display mismatches
    // (fragment/inactive warnings stay issue-only, per tx.fhir.org)
    const errors = [...new Set(specs.filter((i) => (i.severity ?? "error") === "error").map((i) => i.text))].sort();
    const warnings = [...new Set(specs.filter((i) => i.severity === "warning" && i.txType === "invalid-display").map((i) => i.text))].sort();
    const texts = errors.length ? errors : warnings;
    if (texts.length) parameter.push({ name: "message", valueString: texts.join("; ") });
  }
  parameter.push({ name: "result", valueBoolean: rich.result });
  if (rich.system !== undefined && !dropCodeSystem) parameter.push({ name: "system", valueUri: rich.system });
  if (rich.version !== undefined && rich.unknownSystem === undefined && !ccAggregate) parameter.push({ name: "version", valueString: rich.version });
  if (rich.causedByUnknown !== undefined) parameter.push({ name: "x-caused-by-unknown-system", valueCanonical: rich.causedByUnknown });
  if (rich.unknownSystem !== undefined) parameter.push({ name: "x-unknown-system", valueCanonical: rich.unknownSystem });
  parameter.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { resourceType: "Parameters", parameter };
}

export function terminologyRoutes(wh: DeltaWarehouse): Hono {
  const app = new Hono();

  const doValidateCode = (kind: "valueSet" | "codeSystem") => async (c: any) => {
    const { p, codings, overlay, versionParams, inputKind, codeableConcept } = await readParams(c);
    const target = p.url ?? (kind === "codeSystem" ? p.system : undefined);
    if (!target || !codings.length) {
      return c.json({ resourceType: "Parameters", parameter: [{ name: "result", valueBoolean: false }, ...param("message", `${kind} $validate-code requires url${kind === "codeSystem" ? "|system" : ""} + a code/coding/codeableConcept`)] }, 400);
    }
    // Overlay first: if the client supplied the ValueSet/CodeSystem via
    // tx-resource, answer from those resources (definitive — the client's
    // terminology is the truth for its own IG content).
    if (kind === "valueSet") {
      const [urlPart] = target.split("|");
      if (overlay.hasValueSetUrl(urlPart)) {
        const vs = overlay.valueSet(target, p.valueSetVersion);
        if (!vs) {
          const ver = p.valueSetVersion ?? target.split("|")[1];
          const canonical = ver ? `${urlPart}|${ver}` : urlPart;
          return c.json(
            outcomeResource(
              [{ msgId: "Unable_to_resolve_value_Set_", issueCode: "not-found", txType: "not-found", element: "none", text: txMessages.vsNotFound(canonical) }],
              inputKind,
            ),
            404,
          );
        }
        let rich: RichValidation | null = null;
        for (const cd of codings) {
          if (!cd.code) continue;
          const r = overlay.validateRich(vs, { system: cd.system, code: cd.code, version: cd.version, display: cd.display }, versionParams, {
            lenientDisplay: p["lenient-display-validation"] === "true",
          });
          if (r === null) { rich = null; break; } // needs store data → fall through
          rich = r;
          if (r.result) break;
        }
        const vsLabel = vs.version ? `${vs.url}|${vs.version}` : vs.url;
        if (rich !== null) return c.json(renderRichValidation(rich, inputKind, codeableConcept, vsLabel));
      }
    } else {
      const [urlPart] = target.split("|");
      const first = codings.find((cd) => cd.code);
      if (first?.code) {
        const versionReq = target.includes("|") ? target.split("|")[1] : (first.version ?? p.version);
        const r = overlay.validateInCodeSystem(urlPart, { code: first.code, version: versionReq });
        if (r !== null) return c.json(renderRichValidation(r, inputKind, codeableConcept));
      }
    }
    // CodeableConcept / multiple codings: valid if ANY coding validates; else invalid if the VS/CS
    // is loaded and none match; else unknown (not loaded → can't validate).
    let anyValid = false, anyInvalid = false, anyUnknown = false;
    let matched: { system?: string; code: string; display: string | null } | null = null;
    let lastMsg: string | undefined;
    for (const cd of codings) {
      if (!cd.code) continue;
      // The store may have no terminology tables at all (fresh server) — an
      // unreachable/unprovisioned store means "cannot validate", not a 500.
      let r: Awaited<ReturnType<typeof validateCode>>;
      try {
        r = await validateCode(wh, kind === "valueSet" ? { code: cd.code, valueSet: target, system: cd.system } : { code: cd.code, system: target });
      } catch {
        r = { status: "unknown", message: `ValueSet or CodeSystem not loaded on this server` } as any;
      }
      lastMsg = r.message ?? lastMsg;
      if (r.status === "valid") { anyValid = true; matched = { system: cd.system, code: cd.code, display: r.display }; break; }
      if (r.status === "invalid") anyInvalid = true; else anyUnknown = true;
    }
    // An unknown ValueSet url is a 4xx OperationOutcome when the request came
    // with client-supplied terminology (battery/validator style) — the client
    // clearly expected resolution, and $validate-code has nothing to answer.
    if (kind === "valueSet" && !anyValid && !anyInvalid && anyUnknown && !overlay.empty) {
      return c.json(
        outcomeResource([{ msgId: "Unable_to_resolve_value_Set_", issueCode: "not-found", txType: "not-found", element: "none", text: txMessages.vsNotFound(target) }], inputKind),
        404,
      );
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
        { name: "version", valueCode: "5.0.0" },
        { name: "default", valueString: "5.0.0" },
      ],
    });
  app.get("/$versions", doVersions);
  app.post("/$versions", doVersions);

  const doExpand = async (c: any) => {
    const { p, overlay, versionParams, inputKind, inlineValueSet, repeat } = await readParams(c);
    if (!p.url) return c.json({ resourceType: "OperationOutcome", issue: [{ severity: "error", code: "required", details: { text: "$expand requires url" } }] }, 400);
    // Overlay first: expand a client-supplied ValueSet against client-supplied
    // CodeSystems (in-memory), falling back to the Delta store otherwise.
    const [urlPart] = p.url.split("|");
    if (overlay.hasValueSetUrl(urlPart)) {
      const vs = overlay.valueSet(p.url, p.valueSetVersion);
      if (!vs) {
        const canonical = `${urlPart}|${p.valueSetVersion ?? p.url.split("|")[1] ?? ""}`;
        return c.json(
          outcomeResource([{ msgId: "Unable_to_resolve_value_Set_", issueCode: "not-found", txType: "not-found", element: "none", text: txMessages.vsNotFound(canonical) }], inputKind),
          404,
        );
      }
      const r = overlay.expand(vs, {
        count: p.count !== undefined ? Math.max(0, Math.min(Number(p.count), 5000)) : undefined,
        offset: p.offset !== undefined ? Math.max(0, Math.trunc(Number(p.offset)) || 0) : undefined,
        textFilter: p.filter,
        activeOnly: p.activeOnly !== undefined ? p.activeOnly === "true" : undefined,
        excludeNested: p.excludeNested !== undefined ? p.excludeNested === "true" : undefined,
        includeDesignations: p.includeDesignations !== undefined ? p.includeDesignations === "true" : undefined,
        properties: repeat["property"].length ? repeat["property"] : undefined,
        versionParams,
      });
      if (r.valueSet) {
        if (inlineValueSet) delete r.valueSet.compose;
        return c.json(r.valueSet);
      }
      const err = r.error!;
      if (err.kind === "unknown-version") {
        return c.json(
          outcomeResource([{ msgId: "UNKNOWN_CODESYSTEM_VERSION_EXP", issueCode: "not-found", txType: "not-found", element: "none", text: txMessages.unknownVersionExpand(err.system, err.version, err.valid) }], inputKind),
          400,
        );
      }
      if (err.kind === "check-violation") {
        return c.json(
          outcomeResource([{ msgId: "VALUESET_VERSION_CHECK", issueCode: "exception", txType: "version-error", element: "none", text: txMessages.checkViolation(err.version, err.system, err.pattern) }], inputKind),
          400,
        );
      }
      const text = err.kind === "vs-not-found" ? txMessages.vsNotFound(err.canonical) : err.text;
      return c.json({ resourceType: "OperationOutcome", issue: [{ severity: "error", code: "not-supported", details: { text } }] }, 422);
    }
    // Battery/validator-style requests (client-supplied terminology) expect a
    // 4xx OperationOutcome for a ValueSet we cannot resolve anywhere.
    if (!overlay.empty) {
      return c.json(
        outcomeResource([{ msgId: "Unable_to_resolve_value_Set_", issueCode: "not-found", txType: "not-found", element: "none", text: txMessages.vsNotFound(p.url) }], inputKind),
        404,
      );
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
    const fromOverlay = overlay.lookupDisplay(p.system, p.code, p.version);
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
