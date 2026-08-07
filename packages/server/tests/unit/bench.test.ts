import { describe, it, expect } from "vitest";
import {
  percentile, summarize, throughput, generatePatient, transactionBundle, formatReport,
  type BenchReport,
} from "../../src/lib/bench.js";

describe("latency stats", () => {
  it("nearest-rank percentile", () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(xs, 0.5)).toBe(5);
    expect(percentile(xs, 0.9)).toBe(9);
    expect(percentile(xs, 0.99)).toBe(10);
    expect(percentile(xs, 1)).toBe(10);
    expect(percentile([], 0.5)).toBe(0);
  });

  it("summarize computes count/min/mean/percentiles/max order-independently", () => {
    const s = summarize([10, 1, 5, 3, 9, 7, 2, 8, 4, 6]);
    expect(s.count).toBe(10);
    expect(s.min).toBe(1);
    expect(s.max).toBe(10);
    expect(s.mean).toBe(5.5);
    expect(s.p50).toBe(5);
    expect(s.p90).toBe(9);
  });

  it("empty input yields zeros, not NaN", () => {
    expect(summarize([])).toEqual({ count: 0, min: 0, mean: 0, p50: 0, p90: 0, p95: 0, p99: 0, max: 0 });
  });

  it("throughput is items per second over the ms window", () => {
    expect(throughput(1000, 2000)).toBe(500);
    expect(throughput(500, 0)).toBe(0);
  });
});

describe("synthetic population generator", () => {
  it("is deterministic per index", () => {
    expect(JSON.stringify(generatePatient(42))).toBe(JSON.stringify(generatePatient(42)));
  });

  it("distinct indices produce distinct patients + stable ids/MRNs", () => {
    const a = generatePatient(1), b = generatePatient(2);
    expect(a.patient.id).toBe("bench-p-1");
    expect(b.patient.id).toBe("bench-p-2");
    expect((a.patient.identifier as any)[0].value).toBe("MRN-1");
    expect(JSON.stringify(a.patient)).not.toBe(JSON.stringify(b.patient));
  });

  it("generates resourcesPerPatient total (1 patient + N-1 clinical) all referencing the patient", () => {
    const g = generatePatient(7, 5);
    expect(g.clinical).toHaveLength(4);
    for (const c of g.clinical) expect((c.subject as any).reference).toBe("Patient/bench-p-7");
    // alternating Observation / Condition
    expect(g.clinical.map((c) => c.resourceType)).toEqual(["Observation", "Condition", "Observation", "Condition"]);
  });

  it("resourcesPerPatient=1 yields just the patient", () => {
    expect(generatePatient(3, 1).clinical).toHaveLength(0);
  });

  it("produces valid-looking demographics (name, birthDate, address)", () => {
    const p = generatePatient(99).patient as any;
    expect(p.name[0].family).toBeTruthy();
    expect(p.birthDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(p.address[0].postalCode).toBeTruthy();
    expect(["male", "female"]).toContain(p.gender);
  });
});

describe("transactionBundle", () => {
  it("wraps resources as PUT-by-id transaction entries", () => {
    const g = generatePatient(1, 3);
    const b = transactionBundle([g.patient, ...g.clinical]) as any;
    expect(b.type).toBe("transaction");
    expect(b.entry).toHaveLength(3);
    expect(b.entry[0].request).toEqual({ method: "PUT", url: "Patient/bench-p-1" });
    expect(b.entry[0].resource.id).toBe("bench-p-1");
  });
});

describe("formatReport", () => {
  it("renders a human summary with ingest, search, promote sections", () => {
    const rep: BenchReport = {
      config: { patients: 100 },
      ingest: { resources: 500, elapsedMs: 2500, throughputPerSec: 200, batchLatency: summarize([10, 20, 30]) },
      search: { "read-by-id": summarize([1, 2, 3]) },
      promote: { "full:Patient": 1500 },
    };
    const out = formatReport(rep);
    expect(out).toContain("INGEST  500 resources");
    expect(out).toContain("200/s");
    expect(out).toContain("read-by-id");
    expect(out).toContain("PROMOTE");
    expect(out).toContain("full:Patient");
  });
});
