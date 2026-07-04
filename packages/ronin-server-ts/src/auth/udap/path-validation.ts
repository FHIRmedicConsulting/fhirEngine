/**
 * RFC 5280 path hardening (ADR-0036). Beyond trust.ts's chain-linkage + validity + anchor check,
 * this enforces the path rules that matter for B2B trust, over the full leaf→root path:
 *   - **Basic Constraints**: every issuer must be a CA (cA=true); `pathLenConstraint` respected.
 *   - **Key Usage**: a CA that declares keyUsage must assert `keyCertSign`.
 *   - **Name Constraints**: a CA's permitted/excluded subtrees (dNSName / URI / rfc822) constrain the
 *     names of every certificate below it.
 * (pkijs' chain engine does not reliably enforce name constraints, so these are implemented directly;
 * pkijs is used only to parse the extensions.) Revocation stays in crl.ts / ocsp.ts.
 *
 * On by default when UDAP is used; `RONIN_UDAP_STRICT_PATH=false` disables. Fail-closed. Uses `pkijs`.
 */
import { X509Certificate } from "node:crypto";
import * as asn1js from "asn1js";
import { Certificate, type GeneralName, type GeneralSubtree } from "pkijs";
import { parseX5c, issuerOf } from "./trust.js";
import "./pki-engine.js";

const toPk = (cert: X509Certificate): Certificate =>
  new Certificate({ schema: asn1js.fromBER(new Uint8Array(cert.raw).buffer as ArrayBuffer).result });

const ext = (cert: Certificate, oid: string) => (cert.extensions ?? []).find((e) => e.extnID === oid);

function basicConstraints(cert: Certificate): { cA: boolean; pathLen?: number } | null {
  const e = ext(cert, "2.5.29.19");
  if (!e) return null;
  const v = e.parsedValue as { cA?: boolean; pathLenConstraint?: number };
  return { cA: Boolean(v.cA), pathLen: typeof v.pathLenConstraint === "number" ? v.pathLenConstraint : undefined };
}

function hasKeyCertSign(cert: Certificate): boolean | null {
  const e = ext(cert, "2.5.29.15"); // keyUsage
  if (!e) return null; // not asserted → not restricted
  const bytes = new Uint8Array((e.parsedValue as asn1js.BitString).valueBlock.valueHexView);
  return ((bytes[0] ?? 0) & 0x04) !== 0; // bit 5 = keyCertSign
}

interface Subtree { type: number; value: string }
function nameConstraints(cert: Certificate): { permitted: Subtree[]; excluded: Subtree[] } | null {
  const e = ext(cert, "2.5.29.30");
  if (!e) return null;
  const v = e.parsedValue as { permittedSubtrees?: GeneralSubtree[]; excludedSubtrees?: GeneralSubtree[] };
  const map = (sts?: GeneralSubtree[]): Subtree[] =>
    (sts ?? []).map((st) => ({ type: st.base.type, value: typeof st.base.value === "string" ? st.base.value : "" })).filter((s) => s.value);
  return { permitted: map(v.permittedSubtrees), excluded: map(v.excludedSubtrees) };
}

function sanNames(cert: Certificate): Subtree[] {
  const e = ext(cert, "2.5.29.17");
  if (!e) return [];
  return ((e.parsedValue as { altNames?: GeneralName[] }).altNames ?? [])
    .map((n) => ({ type: n.type, value: typeof n.value === "string" ? n.value : "" }))
    .filter((s) => s.value);
}

/** RFC 5280 DNS/URI-host constraint match: constraint "example.com" matches "example.com" and any
 *  sub-domain; an empty constraint matches everything (per §4.2.1.10). */
function hostMatches(host: string, constraint: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  const c = constraint.toLowerCase().replace(/^\.|\.$/g, "");
  return !c || h === c || h.endsWith(`.${c}`);
}

function uriHost(uri: string): string { try { return new URL(uri).hostname.toLowerCase(); } catch { return ""; } }

/** The comparable host string for a SAN entry of a given type (dNSName=2, URI=6, rfc822=1). */
function hostOf(name: Subtree): string | null {
  if (name.type === 2) return name.value;                 // dNSName
  if (name.type === 6) return uriHost(name.value);        // URI → host
  if (name.type === 1) return name.value.split("@").pop() ?? ""; // rfc822 → domain
  return null;
}

/** Returns a violation message if `cert`'s names fall outside `nc`, else null. */
function nameConstraintViolation(cert: Certificate, nc: { permitted: Subtree[]; excluded: Subtree[] }): string | null {
  for (const name of sanNames(cert)) {
    const host = hostOf(name);
    if (host == null) continue; // unsupported name type → not constrained here
    const sameType = (s: Subtree) => s.type === name.type;
    if (nc.excluded.filter(sameType).some((s) => hostMatches(host, s.value))) {
      return `name '${name.value}' is within an excluded subtree`;
    }
    const permittedForType = nc.permitted.filter(sameType);
    if (permittedForType.length && !permittedForType.some((s) => hostMatches(host, s.value))) {
      return `name '${name.value}' is outside the permitted subtrees`;
    }
  }
  return null;
}

export interface PathResult { ok: boolean; reason?: string }

export const strictPathEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.RONIN_UDAP_STRICT_PATH !== "false";

/**
 * Enforce RFC 5280 basic-constraints / key-usage / name-constraints over the full path (leaf→anchor).
 * Fail-closed on any error. Assumes trust.ts already checked linkage + validity + anchor.
 */
export async function validateCertPath(x5c: string[], anchors: X509Certificate[]): Promise<PathResult> {
  if (!x5c.length) return { ok: false, reason: "empty certificate chain" };
  if (!anchors.length) return { ok: false, reason: "no trust anchors configured" };
  try {
    const chain = parseX5c(x5c); // leaf-first
    const top = chain[chain.length - 1]!;
    const isAnchor = anchors.some((a) => a.fingerprint256 === top.fingerprint256);
    const anchor = isAnchor ? undefined : issuerOf(top, anchors);
    const fullPath = (anchor ? [...chain, anchor] : chain).map(toPk); // leaf … root

    // Basic constraints + key usage for every issuer (index ≥ 1 = signs the cert below it).
    for (let i = 1; i < fullPath.length; i++) {
      const bc = basicConstraints(fullPath[i]!);
      if (!bc?.cA) return { ok: false, reason: `path validation failed: issuer #${i} is not a CA` };
      if (bc.pathLen != null && i - 1 > bc.pathLen) return { ok: false, reason: "path validation failed: pathLenConstraint exceeded" };
      const kcs = hasKeyCertSign(fullPath[i]!);
      if (kcs === false) return { ok: false, reason: `path validation failed: issuer #${i} keyUsage lacks keyCertSign` };
    }

    // Name constraints: a CA's constraints bind every cert below it (lower index).
    for (let i = 1; i < fullPath.length; i++) {
      const nc = nameConstraints(fullPath[i]!);
      if (!nc) continue;
      for (let j = 0; j < i; j++) {
        const v = nameConstraintViolation(fullPath[j]!, nc);
        if (v) return { ok: false, reason: `path validation failed: ${v}` };
      }
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `path validation error: ${e instanceof Error ? e.message : String(e)}` };
  }
}
