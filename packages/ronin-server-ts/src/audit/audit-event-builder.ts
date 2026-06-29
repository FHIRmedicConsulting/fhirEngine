/**
 * AuditEvent construction helpers per ADR-0016 §2.
 *
 * Captures one FHIR R4 AuditEvent per authenticated FHIR resource access.
 * The middleware module composes captured request metadata + auth context
 * into a stamped AuditEvent body that the AuditEventRepository persists.
 *
 * Field mapping rationale per ADR-0016 §2.1 + §2.2:
 *   - `type` = `{ system: "http://terminology.hl7.org/CodeSystem/audit-event-type",
 *      code: "rest" }` — RESTful operation event.
 *   - `subtype` = HTTP-method-derived interaction code (`create` | `read` |
 *     `update` | `delete` | `search-type`).
 *   - `action` = ATNA action code (`C` | `R` | `U` | `D` | `E`).
 *   - `recorded` = ISO-8601 instant of the request.
 *   - `outcome` = `0` (success), `4` (minor fail), `8` (serious), `12` (major).
 *   - `agent[0].who` = the OAuth-authenticated subject (Patient or Practitioner
 *     reference where resolvable; opaque `altId` otherwise).
 *   - `agent[0].altId` = OAuth `sub` claim.
 *   - `agent[0].name` = formatted "client_id:<id>" for searchability.
 *   - `agent[0].requestor` = true (the calling identity is the requestor).
 *   - `agent[0].purposeOfUse` = parsed from `X-Purpose-Of-Use` request header.
 *   - `source.observer` = Ronin server's `Device` reference; `source.site` =
 *     the deployment name.
 *   - `entity[0].what` = Reference to the touched resource (`Patient/<id>`,
 *     `Coverage/<id>`, etc.).
 *   - `entity[0].type` = entity type Coding from the FHIR audit-entity-type
 *     code system (`2` = system object / web resource).
 *
 * Per ADR-0016 §various PHI redaction rules: we do NOT capture the request /
 * response body. Only metadata (method, URL, status, resource type + ID).
 */

import type { AuditEvent, Reference } from "@ronin/fhir-types";

const AUDIT_EVENT_TYPE_SYSTEM = "http://terminology.hl7.org/CodeSystem/audit-event-type";
const AUDIT_EVENT_SUBTYPE_SYSTEM = "http://hl7.org/fhir/restful-interaction";
const AUDIT_ENTITY_TYPE_SYSTEM = "http://terminology.hl7.org/CodeSystem/audit-entity-type";

/** Maps HTTP method + path shape → ATNA action + FHIR restful-interaction subtype. */
function classifyInteraction(method: string, hasResourceId: boolean): {
  action: "C" | "R" | "U" | "D" | "E";
  subtype: string;
} {
  const m = method.toUpperCase();
  if (m === "POST" && !hasResourceId) return { action: "C", subtype: "create" };
  if (m === "POST" && hasResourceId) return { action: "E", subtype: "operation" }; // operation invocation (e.g., $member-match)
  if (m === "GET" && hasResourceId) return { action: "R", subtype: "read" };
  if (m === "GET" && !hasResourceId) return { action: "E", subtype: "search-type" };
  if (m === "PUT") return { action: "U", subtype: "update" };
  if (m === "PATCH") return { action: "U", subtype: "patch" };
  if (m === "DELETE") return { action: "D", subtype: "delete" };
  return { action: "E", subtype: "operation" };
}

/** Maps HTTP status code → ATNA outcome code. */
function classifyOutcome(status: number): "0" | "4" | "8" | "12" {
  if (status >= 200 && status < 300) return "0"; // success
  if (status >= 400 && status < 500) return "4"; // minor failure (client error)
  if (status >= 500) return "8"; // serious failure (server error)
  return "0";
}

export interface AuditEventInput {
  /** ISO-8601 instant when the request was received. */
  recordedAt: string;
  /** HTTP method (GET/POST/PUT/DELETE/PATCH). */
  method: string;
  /** Request URL path (e.g., "/Patient/jane"). */
  path: string;
  /** Resource type extracted from path (first capitalized segment). null for non-FHIR paths. */
  resourceType: string | null;
  /** Resource ID extracted from path when present. */
  resourceId: string | null;
  /** Response HTTP status code. */
  status: number;
  /** OAuth `sub` claim of the requesting identity. */
  authSubject: string;
  /** SMART `client_id`. */
  clientId: string;
  /** Optional Patient compartment ID (when patient-bound). */
  launchPatientId: string | null;
  /** X-Purpose-Of-Use header value, if present. */
  purposeOfUse: string | null;
  /** Source IP / network address of the caller, if available. */
  networkAddress: string | null;
  /** Ronin server identity (Device reference) per ADR-0016 §2.1.1. */
  serverDeviceId: string;
  /** Deployment name for `source.site`. */
  deploymentName: string;
}

/**
 * Build an AuditEvent resource from a captured request/response. The result
 * is the canonical FHIR body the AuditEventRepository persists.
 *
 * The fhir_id is minted by the repository on write; this builder produces
 * the body without an id.
 */
export function buildAuditEvent(input: AuditEventInput): AuditEvent {
  const { action, subtype } = classifyInteraction(
    input.method,
    input.resourceId !== null,
  );
  const outcome = classifyOutcome(input.status);

  // Generated AuditEventEntity.what is typed `Reference<"Resource">` — the
  // abstract base, requiring `reference: \`Resource/${string}\``. In practice
  // the concrete reference carries the real resource type (`Patient/jane`,
  // `Coverage/abc`, etc.). Cast through `unknown` because our reference
  // value is the runtime-correct string but doesn't satisfy the template
  // literal at the type level.
  const entity = input.resourceType
    ? [
        {
          what: (input.resourceId
            ? { reference: `${input.resourceType}/${input.resourceId}` }
            : undefined) as unknown as Reference<"Resource"> | undefined,
          type: {
            system: AUDIT_ENTITY_TYPE_SYSTEM,
            code: "2", // "2" = system object (URI / web resource)
            display: input.resourceType,
          },
          name: `${input.method} ${input.path}`,
        },
      ]
    : undefined;

  // `agent.who` references the authenticated identity. We don't always know
  // whether `sub` is a Patient or Practitioner — represent as a Device for
  // application-context tokens and let downstream queries discriminate by
  // `altId`. When `launchPatientId` is present (patient-context), use a
  // Patient reference for the patient self-view query path per ADR-0016 §3.
  const agentWho =
    input.launchPatientId !== null
      ? { reference: `Patient/${input.launchPatientId}` as const }
      : { reference: `Device/${input.clientId}` as const };

  const event: AuditEvent = {
    resourceType: "AuditEvent",
    type: {
      system: AUDIT_EVENT_TYPE_SYSTEM,
      code: "rest",
      display: "RESTful Operation",
    },
    subtype: [
      {
        system: AUDIT_EVENT_SUBTYPE_SYSTEM,
        code: subtype,
      },
    ],
    action,
    recorded: input.recordedAt,
    outcome,
    agent: [
      {
        type: {
          coding: [
            {
              system: "http://dicom.nema.org/resources/ontology/DCM",
              code: "humanuser",
              display: "human user",
            },
          ],
        },
        who: agentWho,
        altId: input.authSubject,
        name: `client_id:${input.clientId}`,
        requestor: true,
        network: input.networkAddress
          ? { address: input.networkAddress, type: "2" }
          : undefined,
        purposeOfUse: input.purposeOfUse
          ? [{ text: input.purposeOfUse }]
          : undefined,
      },
    ],
    source: {
      site: input.deploymentName,
      observer: { reference: `Device/${input.serverDeviceId}` },
      type: [
        {
          system: "http://terminology.hl7.org/CodeSystem/security-source-type",
          code: "3", // Web Server
          display: "Web Server",
        },
      ],
    },
    entity,
  };

  return event;
}
