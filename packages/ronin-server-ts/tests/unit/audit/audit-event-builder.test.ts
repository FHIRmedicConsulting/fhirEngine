import { describe, it, expect } from "vitest";
import { buildAuditEvent } from "../../../src/audit/audit-event-builder.js";

function baseInput(
  overrides: Partial<Parameters<typeof buildAuditEvent>[0]> = {},
): Parameters<typeof buildAuditEvent>[0] {
  return {
    recordedAt: "2026-06-23T20:00:00Z",
    method: "GET",
    path: "/Patient/jane",
    resourceType: "Patient",
    resourceId: "jane",
    status: 200,
    authSubject: "user-12345",
    clientId: "test-app",
    launchPatientId: null,
    purposeOfUse: null,
    networkAddress: null,
    serverDeviceId: "ronin-test",
    deploymentName: "ronin-test-deployment",
    ...overrides,
  };
}

describe("buildAuditEvent", () => {
  it("emits AuditEvent with REST type + read subtype for GET /Resource/{id}", () => {
    const event = buildAuditEvent(baseInput());
    expect(event.resourceType).toBe("AuditEvent");
    expect(event.type.code).toBe("rest");
    expect(event.subtype?.[0]?.code).toBe("read");
    expect(event.action).toBe("R");
    expect(event.outcome).toBe("0");
    expect(event.recorded).toBe("2026-06-23T20:00:00Z");
  });

  it("classifies POST without resourceId as create / C", () => {
    const event = buildAuditEvent(
      baseInput({ method: "POST", path: "/Patient", resourceType: "Patient", resourceId: null }),
    );
    expect(event.subtype?.[0]?.code).toBe("create");
    expect(event.action).toBe("C");
  });

  it("classifies PUT as update / U", () => {
    const event = buildAuditEvent(baseInput({ method: "PUT" }));
    expect(event.subtype?.[0]?.code).toBe("update");
    expect(event.action).toBe("U");
  });

  it("classifies DELETE as delete / D", () => {
    const event = buildAuditEvent(baseInput({ method: "DELETE" }));
    expect(event.subtype?.[0]?.code).toBe("delete");
    expect(event.action).toBe("D");
  });

  it("classifies GET without resourceId as search-type / E", () => {
    const event = buildAuditEvent(
      baseInput({ method: "GET", path: "/Patient", resourceId: null }),
    );
    expect(event.subtype?.[0]?.code).toBe("search-type");
    expect(event.action).toBe("E");
  });

  it("classifies POST with $operation as operation / E", () => {
    const event = buildAuditEvent(
      baseInput({ method: "POST", path: "/Patient/$member-match", resourceId: "$member-match" }),
    );
    expect(event.subtype?.[0]?.code).toBe("operation");
    expect(event.action).toBe("E");
  });

  it("maps 2xx → 0 (success), 4xx → 4 (minor), 5xx → 8 (serious)", () => {
    expect(buildAuditEvent(baseInput({ status: 200 })).outcome).toBe("0");
    expect(buildAuditEvent(baseInput({ status: 201 })).outcome).toBe("0");
    expect(buildAuditEvent(baseInput({ status: 401 })).outcome).toBe("4");
    expect(buildAuditEvent(baseInput({ status: 422 })).outcome).toBe("4");
    expect(buildAuditEvent(baseInput({ status: 500 })).outcome).toBe("8");
  });

  it("populates agent with authSubject + clientId + requestor=true", () => {
    const event = buildAuditEvent(
      baseInput({ authSubject: "abc", clientId: "my-app" }),
    );
    expect(event.agent).toHaveLength(1);
    expect(event.agent[0]!.altId).toBe("abc");
    expect(event.agent[0]!.name).toBe("client_id:my-app");
    expect(event.agent[0]!.requestor).toBe(true);
  });

  it("agent.who is Patient/<id> when launchPatientId is present (patient-context)", () => {
    const event = buildAuditEvent(
      baseInput({ launchPatientId: "patient-bound-id" }),
    );
    const who = event.agent[0]!.who as { reference?: string } | undefined;
    expect(who?.reference).toBe("Patient/patient-bound-id");
  });

  it("agent.who is Device/<client_id> when no launchPatient (system/app context)", () => {
    const event = buildAuditEvent(baseInput({ clientId: "system-app", launchPatientId: null }));
    const who = event.agent[0]!.who as { reference?: string } | undefined;
    expect(who?.reference).toBe("Device/system-app");
  });

  it("captures network.address when provided", () => {
    const event = buildAuditEvent(baseInput({ networkAddress: "10.0.0.42" }));
    expect(event.agent[0]!.network?.address).toBe("10.0.0.42");
    expect(event.agent[0]!.network?.type).toBe("2"); // IP address per FHIR codes
  });

  it("captures purposeOfUse from X-Purpose-Of-Use header", () => {
    const event = buildAuditEvent(baseInput({ purposeOfUse: "TREATMENT" }));
    expect(event.agent[0]!.purposeOfUse?.[0]?.text).toBe("TREATMENT");
  });

  it("entity carries Reference to the touched resource + name", () => {
    const event = buildAuditEvent(
      baseInput({ resourceType: "Coverage", resourceId: "cov-001", method: "GET", path: "/Coverage/cov-001" }),
    );
    expect(event.entity).toHaveLength(1);
    const what = event.entity![0]!.what as { reference?: string } | undefined;
    expect(what?.reference).toBe("Coverage/cov-001");
    expect(event.entity![0]!.name).toBe("GET /Coverage/cov-001");
  });

  it("entity is undefined when resourceType is null (non-FHIR path)", () => {
    const event = buildAuditEvent(
      baseInput({ resourceType: null, resourceId: null, path: "/health" }),
    );
    expect(event.entity).toBeUndefined();
  });

  it("source.site reflects the deployment name", () => {
    const event = buildAuditEvent(baseInput({ deploymentName: "ronin-acme-prod" }));
    expect(event.source.site).toBe("ronin-acme-prod");
  });

  it("source.observer references the Ronin server's Device id", () => {
    const event = buildAuditEvent(baseInput({ serverDeviceId: "ronin-acme-server-7" }));
    expect(event.source.observer.reference).toBe("Device/ronin-acme-server-7");
  });
});
