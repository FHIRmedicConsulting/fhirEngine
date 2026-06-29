/**
 * Batch / transaction Bundle processing (`POST /`).
 *
 * Each entry is dispatched back through the app's own routes via `app.fetch` — so CRUD,
 * validation, search, etc. are reused verbatim and responses are assembled into a
 * batch-response / transaction-response Bundle.
 *
 *  - **batch**: entries are independent; a failing entry yields a 4xx response entry and
 *    does NOT affect the others (the batch contract).
 *  - **transaction**: urn:uuid references are resolved (ids assigned up front + rewritten),
 *    then ALL resources are pre-validated — if any is invalid the whole transaction is
 *    rejected with nothing written (**validation atomicity**). NOTE: the append-only Delta
 *    store has no cross-resource rollback, so a mid-apply infra error (e.g. a version
 *    conflict that pre-validation can't catch) can leave earlier entries written; that
 *    surfaces as a 4xx with an OperationOutcome rather than a silent partial success.
 */
import type { Hono } from "hono";
import type { DeltaWarehouse } from "../lib/delta-warehouse.js";
import { validateResource } from "../validation/validation-chain.js";
import { uuidv7 } from "../lib/uuid-v7.js";
import { badRequest, unprocessable } from "../lib/errors.js";

/** Deep-rewrite `{ reference: "urn:uuid:..." }` values using the assigned-id map. */
function rewriteReferences(node: unknown, idMap: Map<string, string>): void {
  if (Array.isArray(node)) {
    for (const v of node) rewriteReferences(v, idMap);
  } else if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    if (typeof obj.reference === "string" && idMap.has(obj.reference)) {
      obj.reference = idMap.get(obj.reference);
    }
    for (const k of Object.keys(obj)) rewriteReferences(obj[k], idMap);
  }
}

export function mountTransaction(app: Hono, wh: DeltaWarehouse, _baseUrl: string): void {
  app.post("/", async (c) => {
    const bundle = (await c.req.json().catch(() => null)) as any;
    if (!bundle || bundle.resourceType !== "Bundle" || !["batch", "transaction"].includes(bundle.type)) {
      throw badRequest("POST / requires a Bundle of type 'batch' or 'transaction'");
    }
    const entries: any[] = Array.isArray(bundle.entry) ? bundle.entry : [];
    const isTx = bundle.type === "transaction";

    if (isTx) {
      // 1. Assign ids to urn:uuid POSTs and rewrite references across the bundle.
      const idMap = new Map<string, string>();
      for (const e of entries) {
        if (e.request?.method === "POST" && typeof e.fullUrl === "string" && e.fullUrl.startsWith("urn:uuid:") && e.resource?.resourceType) {
          const newId = uuidv7();
          idMap.set(e.fullUrl, `${e.resource.resourceType}/${newId}`);
          e.resource.id = newId;
        }
      }
      if (idMap.size) rewriteReferences(entries, idMap);

      // 2. Pre-validate every written resource — reject the whole transaction if any fails.
      for (const e of entries) {
        const m = e.request?.method;
        if ((m === "POST" || m === "PUT") && e.resource) {
          const vr = await validateResource(e.resource as Record<string, unknown>, { warehouse: wh });
          if (!vr.valid) {
            throw unprocessable(`transaction entry ${e.fullUrl ?? e.request?.url} failed validation: ${vr.issues[0]?.message ?? "invalid"}`);
          }
        }
      }
    }

    // 3. Apply each entry by self-dispatching through the app's own routes.
    const respEntries: any[] = [];
    for (const e of entries) {
      const r = e.request ?? {};
      const method = String(r.method ?? "GET").toUpperCase();
      const url = String(r.url ?? "").replace(/^\//, "");
      const headers: Record<string, string> = { "Content-Type": "application/fhir+json" };
      if (r.ifMatch) headers["If-Match"] = r.ifMatch;
      const init: RequestInit = { method, headers };
      if (e.resource && (method === "POST" || method === "PUT")) init.body = JSON.stringify(e.resource);

      const res = await app.fetch(new Request(`http://internal/${url}`, init));
      const text = await res.text();
      let body: any;
      try { body = text ? JSON.parse(text) : undefined; } catch { body = undefined; }
      const isOutcome = body?.resourceType === "OperationOutcome";

      respEntries.push({
        ...(body && !isOutcome ? { resource: body } : {}),
        response: {
          status: String(res.status),
          ...(res.headers.get("Location") ? { location: res.headers.get("Location") } : {}),
          ...(res.headers.get("ETag") ? { etag: res.headers.get("ETag") } : {}),
          ...(isOutcome ? { outcome: body } : {}),
        },
      });
    }

    return c.json({
      resourceType: "Bundle",
      type: isTx ? "transaction-response" : "batch-response",
      entry: respEntries,
    });
  });
}
