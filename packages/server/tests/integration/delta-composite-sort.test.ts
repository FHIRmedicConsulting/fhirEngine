/**
 * REST surface — composite search params (same-element semantics via composite index rows) and
 * multi-field `_sort` (chained ORDER BY). Gated on sidecar.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { DeltaWarehouse } from "../../src/lib/delta-warehouse.js";
import { createDeltaApp } from "../../src/app.js";

const SIDECAR = process.env.FHIRENGINE_DELTA_SIDECAR_URL;
const BASE = process.env.FHIRENGINE_DELTA_BASE ?? "./.delta-test";

describe.skipIf(!SIDECAR)("REST: composite search + multi-field _sort", () => {
  const wh = SIDECAR ? new DeltaWarehouse({ sidecarUrl: SIDECAR, base: BASE }) : (null as unknown as DeltaWarehouse);
  const app = SIDECAR ? createDeltaApp({ warehouse: wh, baseUrl: "http://test" }) : (null as unknown as ReturnType<typeof createDeltaApp>);
  const run = Date.now();
  const pid = `cs${run}p`;
  const LOINC = "http://loinc.org";
  const req = (m: string, p: string, b?: unknown, h?: Record<string, string>) =>
    app.fetch(new Request(`http://test${p}`, { method: m, headers: { "Content-Type": "application/fhir+json", ...(h ?? {}) }, body: b ? JSON.stringify(b) : undefined }));

  const obs = (id: string, code: string, extra: Record<string, unknown>) => ({
    resourceType: "Observation", id, status: "final",
    code: { coding: [{ system: LOINC, code }] },
    subject: { reference: `Patient/${pid}` },
    ...extra,
  });

  beforeAll(async () => {
    if (!SIDECAR) return;
    if (!(await wh.health())) throw new Error("sidecar down");
    await req("POST", "/Patient", { resourceType: "Patient", id: pid, name: [{ family: "Composite" }] });
    // Two simple quantity observations sharing a code, distinct values + dates.
    await req("POST", "/Observation", obs(`cs${run}hi`, "8480-6", { valueQuantity: { value: 150 }, effectiveDateTime: "2024-03-02T10:00:00Z" }));
    await req("POST", "/Observation", obs(`cs${run}lo`, "8480-6", { valueQuantity: { value: 95 }, effectiveDateTime: "2024-03-01T10:00:00Z" }));
    // A BP panel whose components carry the values — same-element pairing target.
    await req("POST", "/Observation", obs(`cs${run}bp`, "85354-9", {
      effectiveDateTime: "2024-03-03T10:00:00Z",
      component: [
        { code: { coding: [{ system: LOINC, code: "8480-6" }] }, valueQuantity: { value: 120 } },
        { code: { coding: [{ system: LOINC, code: "8462-4" }] }, valueQuantity: { value: 80 } },
      ],
    }));
  });

  const idsOf = (b: any) => (b.entry ?? []).map((e: any) => e.resource.id).filter((i: string) => i.startsWith(`cs${run}`));

  it("code-value-quantity with a gt prefix matches only the qualifying same-element pair", async () => {
    const b = await (await req("GET", `/Observation?subject=Patient/${pid}&code-value-quantity=${encodeURIComponent(`${LOINC}|8480-6`)}%24gt100`)).json();
    expect(idsOf(b)).toEqual([`cs${run}hi`]);
  });

  it("bare-code component-1 form matches via the bare-code row encoding", async () => {
    const b = await (await req("GET", `/Observation?subject=Patient/${pid}&code-value-quantity=8480-6%24ge95`)).json();
    expect(idsOf(b).sort()).toEqual([`cs${run}hi`, `cs${run}lo`]);
  });

  it("component-code-value-quantity enforces SAME-component pairing", async () => {
    // 8462-4 (diastolic) is 80 — a gt100 against it must NOT borrow the systolic 120.
    const none = await (await req("GET", `/Observation?subject=Patient/${pid}&component-code-value-quantity=8462-4%24gt100`)).json();
    expect(idsOf(none)).toEqual([]);
    const hit = await (await req("GET", `/Observation?subject=Patient/${pid}&component-code-value-quantity=8480-6%24ge120`)).json();
    expect(idsOf(hit)).toEqual([`cs${run}bp`]);
  });

  it("combo-code-value-quantity unions root and component values", async () => {
    const b = await (await req("GET", `/Observation?subject=Patient/${pid}&combo-code-value-quantity=8480-6%24ge120`)).json();
    expect(idsOf(b).sort()).toEqual([`cs${run}bp`, `cs${run}hi`]);
  });

  it("composite params are accepted under Prefer: handling=strict (no longer rejected)", async () => {
    const r = await req("GET", `/Observation?subject=Patient/${pid}&code-value-quantity=8480-6%24gt100`, undefined, { Prefer: "handling=strict" });
    expect(r.status).toBe(200);
  });

  it("multi-field _sort chains keys in order (code asc, then date desc within code)", async () => {
    const b = await (await req("GET", `/Observation?subject=Patient/${pid}&_sort=code,-date`)).json();
    // code 8480-6 group first (hi=03-02, lo=03-01 → date desc: hi, lo), then 85354-9 (bp).
    expect(idsOf(b)).toEqual([`cs${run}hi`, `cs${run}lo`, `cs${run}bp`]);
  });

  it("single-field _sort still works (date ascending)", async () => {
    const b = await (await req("GET", `/Observation?subject=Patient/${pid}&_sort=date`)).json();
    expect(idsOf(b)).toEqual([`cs${run}lo`, `cs${run}hi`, `cs${run}bp`]);
  });

  it("an unknown _sort field is rejected under strict, lenient-ignored otherwise", async () => {
    const strict = await req("GET", `/Observation?subject=Patient/${pid}&_sort=nope,-date`, undefined, { Prefer: "handling=strict" });
    expect(strict.status).toBe(400);
    const lenient = await req("GET", `/Observation?subject=Patient/${pid}&_sort=nope,-date`);
    expect(lenient.status).toBe(200);
  });
});
