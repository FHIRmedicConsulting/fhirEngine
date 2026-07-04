/**
 * HRex Patient/$member-match (CMS-0057 Payer-to-Payer): match a submitted member to a single local
 * Patient by identifier / subscriberId / demographics; unique match required (else 422). Sidecar-gated.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { DeltaWarehouse } from "../../src/lib/delta-warehouse.js";
import { createDeltaApp } from "../../src/app.js";

const SIDECAR = process.env.RONIN_DELTA_SIDECAR_URL;
const BASE = process.env.RONIN_DELTA_BASE ?? "./.delta-test";

describe.skipIf(!SIDECAR)("Patient/$member-match", () => {
  const wh = SIDECAR ? new DeltaWarehouse({ sidecarUrl: SIDECAR, base: `${BASE}-mm-${Date.now()}` }) : (null as unknown as DeltaWarehouse);
  const app = SIDECAR ? createDeltaApp({ warehouse: wh, baseUrl: "http://test" }) : (null as unknown as ReturnType<typeof createDeltaApp>);
  const post = (p: string, b: unknown) => app.fetch(new Request(`http://test${p}`, { method: "POST", headers: { "Content-Type": "application/fhir+json" }, body: JSON.stringify(b) }));

  const match = (member: Record<string, unknown>, coverage?: Record<string, unknown>) =>
    post("/Patient/$member-match", {
      resourceType: "Parameters",
      parameter: [
        { name: "MemberPatient", resource: { resourceType: "Patient", ...member } },
        ...(coverage ? [{ name: "CoverageToMatch", resource: { resourceType: "Coverage", ...coverage } }] : []),
      ],
    });

  beforeAll(async () => {
    if (!SIDECAR) return;
    if (!(await wh.health())) throw new Error("sidecar down");
    await post("/Patient", { resourceType: "Patient", id: "mm-p1", identifier: [{ system: "http://payer/member", value: "M1001" }], name: [{ family: "Smith", given: ["Jane"] }], birthDate: "1985-03-15", gender: "female" });
    await post("/Patient", { resourceType: "Patient", id: "mm-p2", name: [{ family: "Jones" }], birthDate: "1990-01-01", gender: "male" });
    // two indistinguishable patients → demographic ambiguity
    await post("/Patient", { resourceType: "Patient", id: "mm-twinA", name: [{ family: "Twin" }], birthDate: "2000-02-02", gender: "female" });
    await post("/Patient", { resourceType: "Patient", id: "mm-twinB", name: [{ family: "Twin" }], birthDate: "2000-02-02", gender: "female" });
  });

  it("matches by identifier → returns the member (MemberIdentifier)", async () => {
    const res = await match({ identifier: [{ system: "http://payer/member", value: "M1001" }] });
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out.resourceType).toBe("Parameters");
    const mi = out.parameter.find((p: { name: string }) => p.name === "MemberIdentifier");
    expect(mi.resource.id).toBe("mm-p1");
  });

  it("matches by coverage subscriberId", async () => {
    const res = await match({ name: [{ family: "Smith" }] }, { subscriberId: "M1001" });
    expect(res.status).toBe(200);
    expect((await res.json()).parameter[0].resource.id).toBe("mm-p1");
  });

  it("matches by demographics (family + birthDate + gender) when unique", async () => {
    const res = await match({ name: [{ family: "Smith" }], birthDate: "1985-03-15", gender: "female" });
    expect(res.status).toBe(200);
    expect((await res.json()).parameter[0].resource.id).toBe("mm-p1");
  });

  it("returns 422 when nothing matches", async () => {
    const res = await match({ name: [{ family: "Nobody" }], birthDate: "1970-01-01", gender: "male" });
    expect(res.status).toBe(422);
    expect((await res.json()).resourceType).toBe("OperationOutcome");
  });

  it("returns 422 when the match is ambiguous (multiple candidates)", async () => {
    const res = await match({ name: [{ family: "Twin" }], birthDate: "2000-02-02", gender: "female" });
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toMatch(/unique match/i);
  });

  it("rejects a non-Parameters body (400)", async () => {
    const res = await post("/Patient/$member-match", { resourceType: "Patient" });
    expect(res.status).toBe(400);
  });
});
