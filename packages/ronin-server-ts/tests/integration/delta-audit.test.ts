/**
 * Audit (ADR-0030 control #2 / ADR-0016): every PHI access writes an AuditEvent; failed
 * access attempts are audited; accounting-of-disclosures by patient. Gated on sidecar.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { DeltaWarehouse } from "../../src/lib/delta-warehouse.js";
import { createDeltaApp } from "../../src/app.js";
import { DeltaAuditSink } from "../../src/audit/delta-audit-sink.js";

const SIDECAR = process.env.RONIN_DELTA_SIDECAR_URL;
const ts = Date.now();
const BASE = `${process.env.RONIN_DELTA_BASE ?? "./.delta-test"}-audit-${ts}`;

describe.skipIf(!SIDECAR)("audit — AuditEvent per access + accounting", () => {
  const wh = SIDECAR ? new DeltaWarehouse({ sidecarUrl: SIDECAR, base: BASE }) : (null as unknown as DeltaWarehouse);
  let app: ReturnType<typeof createDeltaApp>;
  const req = (m: string, p: string, b?: unknown, token?: string) =>
    app.fetch(new Request(`http://test${p}`, { method: m, headers: { "Content-Type": "application/fhir+json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: b ? JSON.stringify(b) : undefined }));
  const auditRows = async () => { wh.registerAudit(); return wh.query<{ action: string; outcome: string; agent_who: string; entity_ref: string; patient: string; subtype: string }>("SELECT action, outcome, agent_who, entity_ref, patient, subtype FROM audit_event"); };

  beforeAll(async () => {
    if (!SIDECAR) return;
    if (!(await wh.health())) throw new Error("sidecar down");
    process.env.RONIN_AUDIT_ENABLED = "true";
    app = createDeltaApp({ warehouse: wh, baseUrl: "http://test", deploymentName: "test-deploy" });
  });
  afterAll(() => { delete process.env.RONIN_AUDIT_ENABLED; });

  it("writes an AuditEvent for a create + a read", async () => {
    const id = `aud${ts}`;
    expect((await req("POST", "/Patient", { resourceType: "Patient", id, name: [{ family: "Aud" }] })).status).toBe(201);
    expect((await req("GET", `/Patient/${id}`)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 600)); // fire-and-forget writes flush (serialized)
    const rows = await auditRows();
    expect(rows.some((r) => r.action === "C")).toBe(true); // create (POST → no URL id → entity_ref null)
    expect(rows.some((r) => r.action === "R" && r.entity_ref === `Patient/${id}`)).toBe(true); // read of the resource
  });

  it("does not audit public routes (/health, /metadata)", async () => {
    const before = (await auditRows()).length;
    await req("GET", "/health");
    await req("GET", "/metadata");
    await new Promise((r) => setTimeout(r, 200));
    expect((await auditRows()).length).toBe(before); // unchanged
  });

  it("accounting-of-disclosures: findByPatient returns that patient's access events", async () => {
    const id = `acct${ts}`;
    await req("POST", "/Patient", { resourceType: "Patient", id, name: [{ family: "Acct" }] });
    await req("GET", `/Patient/${id}`);
    await new Promise((r) => setTimeout(r, 600));
    const events = await new DeltaAuditSink(wh).findByPatient(id); // read tags patient=<id>
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.every((e) => e.resourceType === "AuditEvent")).toBe(true);
  });
});
