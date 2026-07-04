/**
 * UDAP trust — X.509 certificate-chain validation against a configured trust community
 * (ADR-0036). The heart of UDAP/TEFCA B2B trust: a partner proves identity with a certificate
 * whose chain roots in a CA the operator trusts.
 *
 * Trust anchors: `RONIN_UDAP_TRUST_ANCHORS` = comma-separated PEM file paths (root/intermediate CAs).
 *
 * Scope: chain linkage + signature + validity-window checks anchored to a trusted CA, PLUS
 * **revocation** against an operator-supplied revocation list (cert fingerprints/serials). NOT yet:
 * live CRL/OCSP fetching, full RFC 5280 path validation, or name-constraints — documented follow-ups
 * (see ADR-0036). Uses Node's built-in `crypto.X509Certificate` — no new dependency.
 */
import { X509Certificate, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";

/** Normalize a fingerprint/serial for comparison (strip `:`/whitespace, uppercase hex). */
const normId = (s: string): string => s.replace(/[:\s]/g, "").toUpperCase();

/** A cert's revocation identifiers: its SHA-256 fingerprint and its serial number (both normalized). */
const certIds = (c: X509Certificate): string[] => [normId(c.fingerprint256), normId(c.serialNumber)];

/**
 * Load the revocation list: cert SHA-256 fingerprints and/or serial numbers the operator has revoked.
 * `RONIN_UDAP_REVOKED_CERTS` = comma-separated; `RONIN_UDAP_REVOKED_CERTS_FILE` = a file (one per
 * line, `#` comments). A revoked cert anywhere in a presented chain rejects the whole chain.
 */
export function loadRevokedCerts(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const out = new Set<string>();
  for (const v of (env.RONIN_UDAP_REVOKED_CERTS ?? "").split(",")) {
    const n = normId(v.trim());
    if (n) out.add(n);
  }
  const file = env.RONIN_UDAP_REVOKED_CERTS_FILE;
  if (file) {
    try {
      for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
        const n = normId((line.split("#")[0] ?? "").trim());
        if (n) out.add(n);
      }
    } catch { /* no revocation file → nothing revoked */ }
  }
  return out;
}

/** Load configured trust anchors (PEM paths). Empty if none configured (UDAP effectively off). */
export function loadTrustAnchors(env: NodeJS.ProcessEnv = process.env): X509Certificate[] {
  const paths = (env.RONIN_UDAP_TRUST_ANCHORS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const anchors: X509Certificate[] = [];
  for (const p of paths) {
    // A PEM file may hold multiple concatenated certs; X509Certificate reads the first, so split.
    const pem = readFileSync(p, "utf8");
    for (const block of pem.split(/(?=-----BEGIN CERTIFICATE-----)/g)) {
      if (block.includes("BEGIN CERTIFICATE")) anchors.push(new X509Certificate(block));
    }
  }
  return anchors;
}

/** Parse an `x5c` chain (base64 DER entries, leaf-first) into X509 certificates. */
export function parseX5c(x5c: string[]): X509Certificate[] {
  return x5c.map((b64) => new X509Certificate(Buffer.from(b64, "base64")));
}

const isAnchor = (c: X509Certificate, anchors: X509Certificate[]): boolean =>
  anchors.some((a) => a.fingerprint256 === c.fingerprint256);

const issuedBy = (cert: X509Certificate, issuer: X509Certificate): boolean => {
  try { return cert.checkIssued(issuer) !== undefined && cert.verify(issuer.publicKey); }
  catch { return false; }
};

export interface ChainResult {
  ok: boolean;
  leaf?: X509Certificate;
  reason?: string;
}

/**
 * Validate a leaf-first cert chain: every link is issued-and-signed by the next, all certs are
 * within their validity window, and the chain terminates at a trusted anchor.
 */
export function verifyCertChain(
  x5c: string[],
  anchors: X509Certificate[],
  now: Date = new Date(),
  revoked: Set<string> = loadRevokedCerts(),
): ChainResult {
  if (!x5c.length) return { ok: false, reason: "empty certificate chain" };
  if (!anchors.length) return { ok: false, reason: "no trust anchors configured" };

  let chain: X509Certificate[];
  try { chain = parseX5c(x5c); } catch { return { ok: false, reason: "malformed certificate in x5c" }; }

  for (const c of chain) {
    if (now < new Date(c.validFrom) || now > new Date(c.validTo)) {
      return { ok: false, reason: `certificate outside validity window (${c.subject})` };
    }
    // Revocation: reject if this cert (leaf or any intermediate) is on the revocation list.
    if (revoked.size && certIds(c).some((id) => revoked.has(id))) {
      return { ok: false, reason: `certificate revoked (${c.subject})` };
    }
  }

  for (let i = 0; i < chain.length; i++) {
    const cert = chain[i]!;
    if (isAnchor(cert, anchors)) return { ok: true, leaf: chain[0] };
    const nextInChain = chain[i + 1];
    const issuer = nextInChain ?? anchors.find((a) => issuedBy(cert, a));
    if (!issuer) return { ok: false, reason: "chain does not terminate at a trusted anchor" };
    if (!issuedBy(cert, issuer)) return { ok: false, reason: "broken chain link (bad issuer signature)" };
    if (isAnchor(issuer, anchors)) return { ok: true, leaf: chain[0] };
  }
  return { ok: false, reason: "chain does not terminate at a trusted anchor" };
}

/** The leaf certificate's public key as a KeyObject (for verifying the software statement JWT). */
export function leafPublicKey(leaf: X509Certificate): KeyObject {
  return leaf.publicKey; // already a public KeyObject
}
