/**
 * DS4P obligations (ADR-0030 control #4, Phase 4): 42 CFR Part 2 redisclosure notice +
 * element-level inline-label redaction (PROCESSINLINELABEL). Gated on sidecar.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { DeltaWarehouse } from "../../src/lib/delta-warehouse.js";
import { createDeltaApp } from "../../src/app.js";

const SIDECAR = process.env.RONIN_DELTA_SIDECAR_URL;
const ts = Date.now();
const BASE = `${process.env.RONIN_DELTA_BASE ?? "./.delta-test"}-obl-${ts}`;
const ACTCODE = "http://terminology.hl7.org/CodeSystem/v3-ActCode";
const INLINE_URL = "http://hl7.org/fhir/uv/security-label-ds4p/StructureDefinition/extension-inline-sec-label";

describe.skipIf(!SIDECAR)("DS4P obligations — Part 2 notice + inline redaction", () => {
  const wh = SIDECAR ? new DeltaWarehouse({ sidecarUrl: SIDECAR, base: BASE }) : (null as unknown as DeltaWarehouse);
  let app: ReturnType<typeof createDeltaApp>;
  const req = (m: string, p: string, token: string, b?: unknown) =>
    app.fetch(new Request(`http://test${p}`, { method: m, headers: { "Content-Type": "application/fhir+json", Authorization: `Bearer ${token}` }, body: b ? JSON.stringify(b) : undefined }));
  const json = async (m: string, p: string, token: string) => (await req(m, p, token)).json();

  const sud = `sud${ts}`, inl = `inl${ts}`;

  beforeAll(async () => {
    if (!SIDECAR) return;
    if (!(await wh.health())) throw new Error("sidecar down");
    process.env.RONIN_AUTH_ENABLED = "true";
    process.env.RONIN_AUTH_STRATEGY = "stub";
    process.env.RONIN_CONSENT_ENFORCEMENT = "true";
    app = createDeltaApp({ warehouse: wh, baseUrl: "http://test" });
    // a 42 CFR Part 2 (SUD/ETH-labeled) Observation
    await req("POST", "/Observation", "stub-system-all", { resourceType: "Observation", id: sud, status: "final", code: { text: "sud" }, subject: { reference: "Patient/p" }, meta: { security: [{ system: ACTCODE, code: "ETH" }] } });
    // a normal Patient with an INLINE security label on birthDate (element-level)
    await req("POST", "/Patient", "stub-system-all", {
      resourceType: "Patient", id: inl, name: [{ family: "Inline" }], birthDate: "1980-01-01",
      _birthDate: { extension: [{ url: INLINE_URL, valueCoding: { system: ACTCODE, code: "ETH" } }] },
    });
  });
  afterAll(() => { for (const k of ["RONIN_AUTH_ENABLED", "RONIN_AUTH_STRATEGY", "RONIN_CONSENT_ENFORCEMENT"]) delete process.env[k]; });

  it("stamps a 42 CFR Part 2 no-redisclosure label on a disclosed SUD resource", async () => {
    const r = await json("GET", `/Observation/${sud}`, "stub-system-all"); // system may read it
    const codes = (r.meta?.security ?? []).map((l: any) => l.code);
    expect(codes).toContain("ETH");
    expect(codes).toContain("NORDSCLCD"); // redisclosure prohibition stamped
  });

  it("masks an inline-labeled element for user-context (PROCESSINLINELABEL)", async () => {
    const asUser = await json("GET", `/Patient/${inl}`, "stub-user-rs");
    expect(asUser.birthDate).toBeUndefined();           // value masked
    expect(asUser._birthDate?.extension?.[0]?.valueCode).toBe("masked"); // data-absent-reason
    expect((asUser.meta?.security ?? []).map((l: any) => l.code)).toContain("REDACTED");
  });

  it("leaves the inline-labeled element intact for system-context", async () => {
    const asSystem = await json("GET", `/Patient/${inl}`, "stub-system-all");
    expect(asSystem.birthDate).toBe("1980-01-01"); // system sees all → not masked
  });
});
