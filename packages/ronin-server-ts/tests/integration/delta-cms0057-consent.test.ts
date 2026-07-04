/**
 * CMS-0057 exchange-consent gates: Payer-to-Payer OPT-IN (on $member-match) + Provider Access
 * OPT-OUT (filterProviderOptOut, used to scope Group/$export). Sidecar-gated. Synthetic data only.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { DeltaWarehouse } from "../../src/lib/delta-warehouse.js";
import { createDeltaApp } from "../../src/app.js";
import { payerToPayerPermitted, providerAccessPermitted, filterProviderOptOut } from "../../src/auth/cms0057-consent.js";

const SIDECAR = process.env.RONIN_DELTA_SIDECAR_URL;
const BASE = process.env.RONIN_DELTA_BASE ?? "./.delta-test";

const consent = (patientId: string, category: string, type: "permit" | "deny") => ({
  resourceType: "Consent", status: "active",
  scope: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/consentscope", code: "patient-privacy" }] },
  category: [{ coding: [{ code: category }] }],
  patient: { reference: `Patient/${patientId}` },
  policyRule: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: type === "permit" ? "OPTIN" : "OPTOUT" }] },
  provision: { type },
});

describe.skipIf(!SIDECAR)("CMS-0057 exchange-consent gates", () => {
  const wh = SIDECAR ? new DeltaWarehouse({ sidecarUrl: SIDECAR, base: `${BASE}-consent-${Date.now()}` }) : (null as unknown as DeltaWarehouse);
  const app = SIDECAR ? createDeltaApp({ warehouse: wh, baseUrl: "http://test" }) : (null as unknown as ReturnType<typeof createDeltaApp>);
  const post = (p: string, b: unknown) => app.fetch(new Request(`http://test${p}`, { method: "POST", headers: { "Content-Type": "application/fhir+json" }, body: JSON.stringify(b) }));

  beforeAll(async () => {
    if (!SIDECAR) return;
    if (!(await wh.health())) throw new Error("sidecar down");
    // Payer-to-Payer subjects
    await post("/Patient", { resourceType: "Patient", id: "p2p-yes", identifier: [{ system: "http://payer/member", value: "P2PYES" }], name: [{ family: "OptedIn" }] });
    await post("/Patient", { resourceType: "Patient", id: "p2p-no", identifier: [{ system: "http://payer/member", value: "P2PNO" }], name: [{ family: "NoConsent" }] });
    await post("/Consent", consent("p2p-yes", "payer-to-payer", "permit"));
    // Provider Access subjects
    await post("/Patient", { resourceType: "Patient", id: "pa-in", name: [{ family: "Attributed" }] });
    await post("/Patient", { resourceType: "Patient", id: "pa-out", name: [{ family: "OptedOut" }] });
    await post("/Consent", consent("pa-out", "provider-access", "deny"));
  });

  it("Payer-to-Payer is opt-in: permit → allowed, no consent → denied", async () => {
    expect(await payerToPayerPermitted(wh, "p2p-yes")).toBe(true);
    expect(await payerToPayerPermitted(wh, "p2p-no")).toBe(false);
  });

  it("Provider Access is opt-out: no consent → allowed, deny → blocked", async () => {
    expect(await providerAccessPermitted(wh, "pa-in")).toBe(true);
    expect(await providerAccessPermitted(wh, "pa-out")).toBe(false);
  });

  it("filterProviderOptOut drops opted-out patients from an attribution set", async () => {
    expect(await filterProviderOptOut(wh, ["pa-in", "pa-out"])).toEqual(["pa-in"]);
  });

  describe("$member-match opt-in gate (RONIN_P2P_CONSENT_REQUIRED)", () => {
    beforeAll(() => { process.env.RONIN_P2P_CONSENT_REQUIRED = "true"; });
    afterAll(() => { delete process.env.RONIN_P2P_CONSENT_REQUIRED; });

    const match = (value: string) => post("/Patient/$member-match", {
      resourceType: "Parameters",
      parameter: [{ name: "MemberPatient", resource: { resourceType: "Patient", identifier: [{ system: "http://payer/member", value }] } }],
    });

    it("403 when the matched member has not opted in", async () => {
      expect((await match("P2PNO")).status).toBe(403);
    });
    it("200 when the matched member has an active permit Consent", async () => {
      expect((await match("P2PYES")).status).toBe(200);
    });
  });
});
