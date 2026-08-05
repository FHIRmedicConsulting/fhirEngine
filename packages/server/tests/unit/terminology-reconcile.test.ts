import { describe, it, expect, vi, beforeEach } from "vitest";
import { reconcileTerminology, kickReconcile } from "../../src/terminology/reconcile.js";
import type { DeltaWarehouse } from "../../src/lib/delta-warehouse.js";
import { validateResource } from "../../src/validation/validation-chain.js";
import { loadVsacExpansion } from "../../src/terminology/sources/vsac.js";

vi.mock("../../src/validation/validation-chain.js", () => ({ validateResource: vi.fn() }));
vi.mock("../../src/terminology/sources/vsac.js", () => ({ loadVsacExpansion: vi.fn() }));

const mockValidate = vi.mocked(validateResource);
const mockVsac = vi.mocked(loadVsacExpansion);

const VSAC_VS = "https://cts.nlm.nih.gov/fhir/ValueSet/2.16.840.1.113762.1.4.1010.4|20240101";
const OTHER_VS = "http://example.org/fhir/ValueSet/custom-codes";

function pendingRow(over: Partial<Record<string, unknown>> = {}) {
  const body = { resourceType: "Observation", id: "obs-1", status: "final", code: { text: "x" } };
  return {
    row_id: "r1", resource_type: "Observation", resource_id: "obs-1",
    version_id: 1, last_updated: "2024-06-01T00:00:00.000Z", deleted: false,
    body_json: JSON.stringify(body), missing: VSAC_VS,
    ...over,
  };
}

function fakeWh(pending: unknown[] | Error) {
  return {
    registerPendingTerminology: vi.fn(),
    query: vi.fn(async () => { if (pending instanceof Error) throw pending; return pending; }),
    writeDeadLetter: vi.fn(async () => {}),
    deletePendingTerminology: vi.fn(async () => {}),
    writeVersion: vi.fn(async () => {}),
  };
}

beforeEach(() => {
  mockValidate.mockReset();
  mockVsac.mockReset();
  mockVsac.mockResolvedValue({ valueset: "vs", expansions: 5 });
});

describe("reconcileTerminology", () => {
  it("returns an empty report when the queue table is not provisioned", async () => {
    const wh = fakeWh(new Error("table not found"));
    const report = await reconcileTerminology(wh as unknown as DeltaWarehouse);
    expect(report).toEqual({ queued: 0, pulled: [], resolved: 0, deadLettered: 0, stillPending: 0 });
    expect(wh.registerPendingTerminology).toHaveBeenCalled();
    expect(mockVsac).not.toHaveBeenCalled();
  });

  it("empty queue → nothing pulled, nothing written", async () => {
    const wh = fakeWh([]);
    const report = await reconcileTerminology(wh as unknown as DeltaWarehouse);
    expect(report.queued).toBe(0);
    expect(mockVsac).not.toHaveBeenCalled();
    expect(wh.writeVersion).not.toHaveBeenCalled();
  });

  it("now-valid resource → ingested to Bronze via the shared bronzeRow and dequeued", async () => {
    mockValidate.mockResolvedValue({ valid: true, issues: [] });
    const wh = fakeWh([pendingRow()]);
    const report = await reconcileTerminology(wh as unknown as DeltaWarehouse);

    expect(report).toMatchObject({ queued: 1, resolved: 1, deadLettered: 0, stillPending: 0 });
    expect(wh.writeVersion).toHaveBeenCalledTimes(1);
    const [rt, row, prev] = wh.writeVersion.mock.calls[0]!;
    expect(rt).toBe("Observation");
    expect(prev).toBeNull(); // version 1 → no predecessor
    expect(row).toMatchObject({ id: "obs-1", version_id: 1, deleted: false, is_current: true });
    expect(JSON.parse(row.body_json).id).toBe("obs-1");
    expect(Array.isArray(row.search_param_index)).toBe(true); // materialized identically to the write path
    expect(wh.deletePendingTerminology).toHaveBeenCalledWith("row_id = 'r1'");
  });

  it("re-ingest of a later version links to its predecessor (version_id - 1)", async () => {
    mockValidate.mockResolvedValue({ valid: true, issues: [] });
    const wh = fakeWh([pendingRow({ version_id: 3 })]);
    await reconcileTerminology(wh as unknown as DeltaWarehouse);
    expect(wh.writeVersion.mock.calls[0]![2]).toBe(2);
  });

  it("genuinely-invalid resource → dead-letter (with truncated issue text) and dequeued", async () => {
    mockValidate.mockResolvedValue({
      valid: false,
      issues: [{ path: "Observation.code", message: "m".repeat(2000) }] as any,
    });
    const wh = fakeWh([pendingRow()]);
    const report = await reconcileTerminology(wh as unknown as DeltaWarehouse);

    expect(report).toMatchObject({ deadLettered: 1, resolved: 0, stillPending: 0 });
    expect(wh.writeVersion).not.toHaveBeenCalled();
    const [rt, dl] = wh.writeDeadLetter.mock.calls[0]!;
    expect(rt).toBe("Observation");
    expect(dl).toMatchObject({ id: "obs-1", resourceType: "Observation" });
    expect((dl.error as string).length).toBeLessThanOrEqual(1500);
    expect(dl.error).toContain("Observation.code");
    expect(wh.deletePendingTerminology).toHaveBeenCalledWith("row_id = 'r1'");
  });

  it("terminology still unknown → kept queued (no ingest, no dequeue, no dead-letter)", async () => {
    mockValidate.mockResolvedValue({ valid: true, issues: [], pending: [{ valueSet: OTHER_VS, path: "code" }] });
    const wh = fakeWh([pendingRow({ missing: OTHER_VS })]);
    const report = await reconcileTerminology(wh as unknown as DeltaWarehouse);

    expect(report).toMatchObject({ stillPending: 1, resolved: 0, deadLettered: 0 });
    expect(wh.writeVersion).not.toHaveBeenCalled();
    expect(wh.writeDeadLetter).not.toHaveBeenCalled();
    expect(wh.deletePendingTerminology).not.toHaveBeenCalled();
  });

  it("pulls each distinct missing VSAC value set once (by OID); non-VSAC sets are not auto-pulled", async () => {
    mockValidate.mockResolvedValue({ valid: true, issues: [] });
    const wh = fakeWh([
      pendingRow({ row_id: "r1", missing: `${VSAC_VS},${OTHER_VS}` }),
      pendingRow({ row_id: "r2", resource_id: "obs-2", missing: VSAC_VS }),
    ]);
    const report = await reconcileTerminology(wh as unknown as DeltaWarehouse);

    expect(mockVsac).toHaveBeenCalledTimes(1); // distinct VSAC set pulled once, not per row
    expect(mockVsac.mock.calls[0]![1]).toBe("2.16.840.1.113762.1.4.1010.4"); // OID, version suffix stripped
    expect(report.pulled).toEqual([{ valueSet: VSAC_VS, expansions: 5 }]);
  });

  it("a failed VSAC pull is tolerated: rows still re-validate, nothing crashes", async () => {
    mockVsac.mockRejectedValue(new Error("VSAC 500"));
    mockValidate.mockResolvedValue({ valid: true, issues: [] });
    const wh = fakeWh([pendingRow()]);
    const report = await reconcileTerminology(wh as unknown as DeltaWarehouse);

    expect(report.pulled).toEqual([]);
    expect(report.resolved).toBe(1); // validation ran regardless
  });

  it("routes a mixed queue correctly in one drain", async () => {
    mockValidate
      .mockResolvedValueOnce({ valid: true, issues: [] })
      .mockResolvedValueOnce({ valid: false, issues: [{ path: "p", message: "bad" }] as any })
      .mockResolvedValueOnce({ valid: true, issues: [], pending: [{ valueSet: OTHER_VS, path: "c" }] });
    const wh = fakeWh([
      pendingRow({ row_id: "r1", resource_id: "a" }),
      pendingRow({ row_id: "r2", resource_id: "b" }),
      pendingRow({ row_id: "r3", resource_id: "c" }),
    ]);
    const report = await reconcileTerminology(wh as unknown as DeltaWarehouse);
    expect(report).toMatchObject({ queued: 3, resolved: 1, deadLettered: 1, stillPending: 1 });
  });
});

describe("kickReconcile", () => {
  it("honors the FHIRENGINE_DISABLE_AUTO_RECONCILE operator knob", () => {
    const wh = fakeWh([]);
    process.env.FHIRENGINE_DISABLE_AUTO_RECONCILE = "true";
    try {
      kickReconcile(wh as unknown as DeltaWarehouse);
      expect(wh.query).not.toHaveBeenCalled();
    } finally {
      delete process.env.FHIRENGINE_DISABLE_AUTO_RECONCILE;
    }
  });
});
