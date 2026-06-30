/**
 * Current-version materialization (Priority #2): `is_current` is maintained atomically on
 * write (insert new + demote prior in ONE Delta MERGE commit). Search filters `WHERE is_current`
 * instead of a window-function over all versions. This proves: exactly one current row per id
 * (no search duplicates), history preserved, and tombstones excluded from search. Sidecar-gated.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { DeltaWarehouse } from "../../src/lib/delta-warehouse.js";
import { createDeltaApp } from "../../src/app.js";

const SIDECAR = process.env.RONIN_DELTA_SIDECAR_URL;
const BASE = process.env.RONIN_DELTA_BASE ?? "./.delta-test";

describe.skipIf(!SIDECAR)("current-version materialization (is_current)", () => {
  const wh = SIDECAR ? new DeltaWarehouse({ sidecarUrl: SIDECAR, base: BASE }) : (null as unknown as DeltaWarehouse);
  const app = SIDECAR ? createDeltaApp({ warehouse: wh, baseUrl: "http://test" }) : (null as unknown as ReturnType<typeof createDeltaApp>);
  const id = `cv-${Date.now()}`;
  const req = (m: string, p: string, b?: unknown, h?: Record<string, string>) =>
    app.fetch(new Request(`http://test${p}`, { method: m, headers: { "Content-Type": "application/fhir+json", ...(h ?? {}) }, body: b ? JSON.stringify(b) : undefined }));
  const searchTotal = async (q: string) => (await (await req("GET", `/Patient?${q}`)).json()).total as number;
  const currentRows = async () =>
    Number((await wh.query<{ n: number }>(`SELECT count(*) AS n FROM patient WHERE id = ? AND is_current`, [id]))[0]?.n ?? 0);
  const allRows = async () =>
    Number((await wh.query<{ n: number }>(`SELECT count(*) AS n FROM patient WHERE id = ?`, [id]))[0]?.n ?? 0);

  beforeAll(async () => {
    if (!SIDECAR) return;
    if (!(await wh.health())) throw new Error("sidecar down");
    await req("POST", `/Patient`, { resourceType: "Patient", id, gender: "female" }); // v1 (create)
  });

  it("after update: search sees only the current version, not the demoted one", async () => {
    expect(await searchTotal(`_id=${id}&gender=female`)).toBe(1);
    await req("PUT", `/Patient/${id}`, { resourceType: "Patient", id, gender: "male" }, { "If-Match": 'W/"1"' }); // v2
    expect(await searchTotal(`_id=${id}&gender=male`)).toBe(1);   // new current
    expect(await searchTotal(`_id=${id}&gender=female`)).toBe(0); // old version demoted → not current
  });

  it("exactly one current row per id, but full history retained", async () => {
    expect(await currentRows()).toBe(1); // atomic demote: never two-current
    expect(await allRows()).toBe(2);     // both versions still on disk (history intact)
    expect((await (await req("GET", `/Patient/${id}/_history`)).json()).total).toBe(2);
  });

  it("no duplicate in an un-filtered search (the window-function dup hazard)", async () => {
    expect(await searchTotal(`_id=${id}`)).toBe(1); // one entry, not two
  });

  it("delete tombstones the current version → excluded from search, history grows", async () => {
    await req("DELETE", `/Patient/${id}`); // v3 tombstone (is_current=true, deleted=true)
    expect(await searchTotal(`_id=${id}`)).toBe(0); // tombstone not returned
    expect(await currentRows()).toBe(1);            // still exactly one current (the tombstone)
    expect(await allRows()).toBe(3);                // history preserved
  });
});
