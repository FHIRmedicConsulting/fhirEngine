/**
 * FHIR validation PRIOR to Bronze (R4 Core) + dead-letter / failed-message queue.
 * Invalid resources never land in Bronze; they go to the dead-letter Delta queue and
 * the caller gets 422. Gated on RONIN_DELTA_SIDECAR_URL (sidecar needs fhir.resources):
 *   python sidecar/delta_sidecar.py --port 8078 --base ./.delta-test
 *   RONIN_DELTA_SIDECAR_URL=http://127.0.0.1:8078 RONIN_DELTA_BASE=./.delta-test \
 *     npx vitest run tests/integration/delta-validation.test.ts
 */
import { describe, it, expect, beforeAll } from "vitest";
import { DeltaWarehouse } from "../../src/lib/delta-warehouse.js";
import { createDeltaApp } from "../../src/app.js";

const SIDECAR = process.env.RONIN_DELTA_SIDECAR_URL;
const BASE = process.env.RONIN_DELTA_BASE ?? "./.delta-test";

describe.skipIf(!SIDECAR)("Validation prior to Bronze + dead-letter queue", () => {
  const wh = SIDECAR ? new DeltaWarehouse({ sidecarUrl: SIDECAR, base: BASE }) : (null as unknown as DeltaWarehouse);
  const app = SIDECAR ? createDeltaApp({ warehouse: wh, baseUrl: "http://test" }) : (null as unknown as ReturnType<typeof createDeltaApp>);
  const run = `v${Date.now()}`;
  const goodId = `${run}-good`;
  const badId = `${run}-bad`;

  const req = (method: string, path: string, body?: unknown) =>
    app.fetch(new Request(`http://test${path}`, {
      method, headers: { "Content-Type": "application/fhir+json" },
      body: body ? JSON.stringify(body) : undefined,
    }));

  beforeAll(async () => {
    if (SIDECAR && !(await wh.health())) throw new Error(`sidecar not reachable at ${SIDECAR}`);
  });

  it("accepts a valid R4 Core Patient (201 → Bronze)", async () => {
    const res = await req("POST", "/Patient", {
      resourceType: "Patient", id: goodId, gender: "female", birthDate: "1990-01-01",
    });
    expect(res.status).toBe(201);
  });

  it("rejects a structurally-invalid Patient with 422 (NOT in Bronze)", async () => {
    const res = await req("POST", "/Patient", {
      resourceType: "Patient", id: badId, birthDate: "not-a-date", // invalid FHIR date
    });
    expect(res.status).toBe(422);
    // the bad one must NOT be readable from Bronze
    const get = await req("GET", `/Patient/${badId}`);
    expect(get.status).toBe(404);
  });

  it("routes the invalid resource to the dead-letter queue", async () => {
    const dlt = wh.registerDeadLetter("Patient");
    const rows = await wh.query<{ id: string; resourceType: string; error: string }>(
      `SELECT id, resourceType, error FROM ${dlt} WHERE id = ?`,
      [badId],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].resourceType).toBe("Patient");
    expect(rows[0].error.toLowerCase()).toContain("date");
  });
});
