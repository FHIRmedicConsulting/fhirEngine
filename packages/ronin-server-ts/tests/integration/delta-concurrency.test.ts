/**
 * Single-writer concurrency / durability (Priority #3). delta-rs is single-writer per table;
 * concurrent commits to the same table conflict. The warehouse serializes mutating ops per
 * table path (and the sidecar retries cross-process conflicts), so concurrent writes don't
 * raise or get lost. Sidecar-gated.
 */
import { describe, it, expect } from "vitest";
import { DeltaWarehouse } from "../../src/lib/delta-warehouse.js";
import { createDeltaApp } from "../../src/app.js";
import { bronzeRow } from "../../src/repository/ingest.js";

const SIDECAR = process.env.RONIN_DELTA_SIDECAR_URL;
const BASE = process.env.RONIN_DELTA_BASE ?? "./.delta-test";

describe.skipIf(!SIDECAR)("single-writer concurrency (no lost writes)", () => {
  const wh = SIDECAR ? new DeltaWarehouse({ sidecarUrl: SIDECAR, base: BASE }) : (null as unknown as DeltaWarehouse);
  const app = SIDECAR ? createDeltaApp({ warehouse: wh, baseUrl: "http://test" }) : (null as unknown as ReturnType<typeof createDeltaApp>);
  const ts = Date.now();
  const req = (m: string, p: string, b?: unknown) =>
    app.fetch(new Request(`http://test${p}`, { method: m, headers: { "Content-Type": "application/fhir+json" }, body: b ? JSON.stringify(b) : undefined }));

  it("N concurrent creates to the SAME table all land (no commit-conflict failures)", async () => {
    const N = 24;
    const ids = Array.from({ length: N }, (_, i) => `conc-${ts}-${i}`);
    const results = await Promise.all(ids.map((id) => req("POST", "/Patient", { resourceType: "Patient", id })));
    expect(results.map((r) => r.status)).toEqual(Array(N).fill(201)); // all created, none conflicted
    const reads = await Promise.all(ids.map((id) => req("GET", `/Patient/${id}`)));
    expect(reads.every((r) => r.status === 200)).toBe(true); // each individually durable
    const n = Number((await wh.query<{ n: number }>(`SELECT count(*) AS n FROM patient WHERE id LIKE ? AND is_current`, [`conc-${ts}-%`]))[0]?.n ?? 0);
    expect(n).toBe(N); // exactly N current rows — nothing lost
  });

  it("concurrent version writes to the SAME id serialize: no duplicate/lost version, one current", async () => {
    const id = `concU-${ts}`;
    const patient = (v: number) => ({ resourceType: "Patient" as const, id, meta: { versionId: String(v) } });
    await req("POST", "/Patient", patient(1)); // v1
    // Fire v2..v6 at the warehouse write layer concurrently; the per-table chain serializes them.
    await Promise.all([2, 3, 4, 5, 6].map((v) =>
      wh.writeVersion("Patient", bronzeRow(patient(v), v, new Date(ts + v).toISOString(), false), v - 1),
    ));
    const versions = await wh.query<{ version_id: number; is_current: boolean }>(
      `SELECT version_id, is_current FROM patient WHERE id = ? ORDER BY version_id`, [id],
    );
    expect(versions.map((r) => Number(r.version_id))).toEqual([1, 2, 3, 4, 5, 6]); // contiguous, none lost/dup
    expect(versions.filter((r) => r.is_current === true).length).toBe(1);          // exactly one current
  });
});
