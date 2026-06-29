/**
 * DS4P obligations on the disclosure path (ADR-0030 control #4, Phase 4):
 *
 *  - **42 CFR Part 2 redisclosure notice** — a disclosed SUD/Part-2 resource is stamped with
 *    a `NORDSCLCD` (no-redisclosure-without-consent) security label so the recipient sees the
 *    prohibition.
 *  - **PROCESSINLINELABEL** — element-level inline security labels: fields carrying an inline
 *    label the requester can't access are masked with `data-absent-reason: masked`.
 *
 * Enforce-not-tag boundary holds: the server reads inline labels the tagger applied and acts
 * on them; it does not create the clinical labels.
 */
import { SENSITIVITY_CODES } from "./consent-gate.js";
import { consentEnabled } from "./consent-enforce.js";
import type { AuthContext } from "./auth-context.js";

const ACTCODE = "http://terminology.hl7.org/CodeSystem/v3-ActCode";
const DAR_URL = "http://hl7.org/fhir/StructureDefinition/data-absent-reason";
const INLINE_LABEL_URL = process.env.RONIN_INLINE_LABEL_URL
  ?? "http://hl7.org/fhir/uv/security-label-ds4p/StructureDefinition/extension-inline-sec-label";
const PART2_SENSITIVITIES = new Set(["ETH", "SUD"]); // 42 CFR Part 2 (substance use disorder)

function scopeContext(auth: AuthContext): "system" | "patient" | "user" {
  const raw = auth.rawScopeString ?? "";
  if (raw.includes("system/")) return "system";
  if (raw.includes("patient/")) return "patient";
  return "user";
}

/** Sensitivities the requester may NOT see inline (user-context blocks all; system/patient none). */
export function blockedSensitivitiesFor(auth: AuthContext): Set<string> {
  return scopeContext(auth) === "user" ? new Set(SENSITIVITY_CODES) : new Set();
}

/** Stamp a no-redisclosure obligation on a disclosed 42 CFR Part 2 (SUD) resource (idempotent). */
export function stampRedisclosureNotice<R>(resource: R): R {
  const r = resource as any;
  const labels: any[] = r.meta?.security ?? [];
  if (!labels.some((l) => PART2_SENSITIVITIES.has(l.code)) || labels.some((l) => l.code === "NORDSCLCD")) return resource;
  const clone = structuredClone(r);
  clone.meta = clone.meta ?? {};
  clone.meta.security = [...(clone.meta.security ?? []), { system: ACTCODE, code: "NORDSCLCD", display: "no redisclosure without consent directive" }];
  return clone;
}

function inlineLabelCodes(ext: any[] | undefined): string[] {
  return (ext ?? []).filter((e) => e?.url === INLINE_LABEL_URL).map((e) => e?.valueCoding?.code).filter(Boolean);
}

/** Mask top-level fields carrying an inline security label in `blocked` (PROCESSINLINELABEL). */
export function redactInlineLabels<R>(resource: R, blocked: Set<string>): R {
  if (blocked.size === 0) return resource;
  const r = resource as any;
  const clone = structuredClone(r);
  let changed = false;
  for (const key of Object.keys(clone)) {
    if (key.startsWith("_") || key === "resourceType" || key === "id" || key === "meta") continue;
    const v = clone[key];
    const codes = [
      ...inlineLabelCodes(clone["_" + key]?.extension), // primitive sibling
      ...(v && typeof v === "object" && !Array.isArray(v) ? inlineLabelCodes(v.extension) : []), // complex
      ...(Array.isArray(v) ? v.flatMap((x: any) => (x && typeof x === "object" ? inlineLabelCodes(x.extension) : [])) : []), // array
    ];
    if (codes.some((c) => blocked.has(c))) {
      delete clone[key];
      clone["_" + key] = { extension: [{ url: DAR_URL, valueCode: "masked" }] };
      changed = true;
    }
  }
  if (changed) {
    clone.meta = clone.meta ?? {};
    clone.meta.security = [...(clone.meta.security ?? []), { system: ACTCODE, code: "REDACTED", display: "redacted" }];
  }
  return changed ? clone : resource;
}

/** Apply disclosure obligations to an allowed resource (no-op unless consent enforcement is on). */
export function applyObligations<R>(resource: R, auth: AuthContext | undefined): R {
  if (!consentEnabled() || !auth) return resource;
  return redactInlineLabels(stampRedisclosureNotice(resource), blockedSensitivitiesFor(auth));
}
