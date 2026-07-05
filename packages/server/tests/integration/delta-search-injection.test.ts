/**
 * Injection defense (security deep-dive §2.5 D3 / OWASP): hostile search inputs must never
 * reach DataFusion SQL as syntax. The repository parameterizes every user value and
 * whitelists operators (`_lastUpdated` prefixes) — these are the regression tests for that
 * contract, driven through the real sidecar.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { DeltaWarehouse } from "../../src/lib/delta-warehouse.js";
import { DeltaResourceRepository } from "../../src/repository/delta-resource-repository.js";

const SIDECAR = process.env.FHIRENGINE_DELTA_SIDECAR_URL;
const BASE = `${process.env.FHIRENGINE_DELTA_BASE ?? "./.delta-test"}-inj-${Date.now()}`;

const HOSTILE = [
  `'; DROP TABLE patient; --`,
  `" OR 1=1 --`,
  `\\'); DELETE FROM patient WHERE (1=1`,
  `%' UNION SELECT body_json FROM patient --`,
  `Robert'); DROP TABLE Students;--`,
];

describe.skipIf(!SIDECAR)("search injection defense (parameterized SQL)", () => {
  const wh = SIDECAR ? new DeltaWarehouse({ sidecarUrl: SIDECAR, base: BASE }) : (null as unknown as DeltaWarehouse);
  const repo = () => new DeltaResourceRepository(wh, "Patient");
  const id = `inj-${Date.now()}`;

  beforeAll(async () => {
    if (!SIDECAR) return;
    if (!(await wh.health())) throw new Error(`sidecar not reachable at ${SIDECAR}`);
    await repo().create({
      resourceType: "Patient", id, gender: "female",
      identifier: [{ system: "urn:inj:test", value: "safe-1" }],
    } as never);
  });

  it("hostile identifier values are matched literally, never executed", async () => {
    for (const evil of HOSTILE) {
      const r = await repo().searchByParams({
        conds: [{ code: "identifier", value: evil }] as never, count: 10, offset: 0,
      });
      expect(r.total).toBe(0); // no match, no error, no side effects
    }
    // the table survived every attempt
    const ok = await repo().searchByParams({ conds: [{ code: "identifier", system: "urn:inj:test", value: "safe-1" }] as never, count: 10, offset: 0 });
    expect(ok.total).toBe(1);
  });

  it("hostile _sort param codes and _lastUpdated values are inert", async () => {
    for (const evil of HOSTILE) {
      const bySort = await repo().searchByParams({ conds: [], count: 10, offset: 0, sortParam: evil });
      expect(bySort.total).toBeGreaterThanOrEqual(1); // sort key just doesn't exist — query still sound
      // Literal string comparison (may lexically match or not) — the property under test
      // is that it executes as a VALUE, never as SQL syntax.
      const byDate = await repo().searchByParams({ conds: [], lastUpdated: [{ op: ">=", value: evil }], count: 10, offset: 0 });
      expect(typeof byDate.total).toBe("number");
    }
    const alive = await repo().read(id);
    expect((alive as { id?: string }).id).toBe(id);
  });

  it("hostile ids via _id and direct read are literal lookups", async () => {
    for (const evil of HOSTILE) {
      const r = await repo().searchByParams({ conds: [], id: evil, count: 10, offset: 0 });
      expect(r.total).toBe(0);
      await expect(repo().read(evil)).rejects.toMatchObject({ status: 404 });
    }
  });
});
