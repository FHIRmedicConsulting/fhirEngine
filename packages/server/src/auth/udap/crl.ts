/**
 * Live CRL revocation (ADR-0036). Downloads the CRL from a certificate's CRL Distribution Point
 * (and/or operator-supplied URLs), verifies the CRL is signed by a trusted issuer in the chain
 * (so a forged/empty CRL can't hide a revocation), and checks the cert's serial against it.
 *
 * Opt-in: `FHIRENGINE_UDAP_CRL_CHECK=true`. Extra/override CRL URLs: `FHIRENGINE_UDAP_CRL_URLS` (comma-sep).
 * Soft-fail by default (a CRL we can't fetch/verify → "unknown", not rejected) so a down CRL server
 * doesn't block all B2B; `FHIRENGINE_UDAP_CRL_HARD_FAIL=true` flips it to fail-closed.
 *
 * Uses `pkijs` + `asn1js` (pure-JS; approved 2026-07-04) with Node's Web Crypto engine.
 */
import { X509Certificate } from "node:crypto";
import * as asn1js from "asn1js";
import { CertificateRevocationList, Certificate } from "pkijs";
import "./pki-engine.js"; // sets the pkijs crypto engine (side effect)
import { assertPublicHttpUrl } from "./ssrf-guard.js";

/** A standalone ArrayBuffer copy of a byte view (avoids SharedArrayBuffer / offset issues). */
const ab = (u8: Uint8Array): ArrayBuffer => new Uint8Array(u8).buffer as ArrayBuffer;

/** Normalize a serial number: uppercase hex, no separators, no leading zeros. */
const serialKey = (hex: string): string => (hex.replace(/[^0-9a-fA-F]/g, "").toUpperCase().replace(/^0+/, "") || "0");

export type CrlFetcher = (url: string) => Promise<Uint8Array>;

const httpFetchCrl: CrlFetcher = async (url) => {
  await assertPublicHttpUrl(url); // SSRF guard — CDP URL comes from the (untrusted) cert
  return new Uint8Array(await (await fetch(url)).arrayBuffer());
};

interface ParsedCrl {
  crl: CertificateRevocationList;
  serials: Set<string>;
  nextUpdate?: number;
}

function parseCrl(der: Uint8Array): ParsedCrl {
  const asn1 = asn1js.fromBER(ab(der));
  if (asn1.offset === -1) throw new Error("malformed CRL");
  const crl = new CertificateRevocationList({ schema: asn1.result });
  const serials = new Set<string>();
  for (const rc of crl.revokedCertificates ?? []) {
    serials.add(serialKey(Buffer.from(rc.userCertificate.valueBlock.valueHexView).toString("hex")));
  }
  return { crl, serials, nextUpdate: crl.nextUpdate?.value?.getTime() };
}

/** CRL Distribution Point URIs from a cert (extension 2.5.29.31) + operator-configured URLs. */
export function crlUrlsFor(cert: X509Certificate, env: NodeJS.ProcessEnv = process.env): string[] {
  const urls = new Set<string>();
  try {
    const asn1 = asn1js.fromBER(ab(cert.raw));
    const pk = new Certificate({ schema: asn1.result });
    for (const ext of pk.extensions ?? []) {
      if (ext.extnID !== "2.5.29.31") continue;
      const dps = (ext.parsedValue?.distributionPoints ?? []) as Array<{ distributionPoint?: Array<{ type: number; value: string }> }>;
      for (const dp of dps) for (const name of dp.distributionPoint ?? []) {
        if (name.type === 6 && typeof name.value === "string") urls.add(name.value); // GeneralName URI
      }
    }
  } catch { /* no/unparseable CDP → rely on operator URLs */ }
  for (const u of (env.FHIRENGINE_UDAP_CRL_URLS ?? "").split(",").map((s) => s.trim()).filter(Boolean)) urls.add(u);
  return [...urls];
}

export interface CrlResult { revoked: boolean; reason?: string }

/** Checks certs against their CRLs, verifying each CRL against a trusted issuer. Caches per URL. */
export class CrlRevocationChecker {
  private readonly cache = new Map<string, ParsedCrl>();
  constructor(
    private readonly fetcher: CrlFetcher = httpFetchCrl,
    private readonly now: () => number = Date.now,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  private async getCrl(url: string): Promise<ParsedCrl | null> {
    const cached = this.cache.get(url);
    if (cached && (!cached.nextUpdate || cached.nextUpdate > this.now())) return cached;
    try {
      const parsed = parseCrl(await this.fetcher(url));
      this.cache.set(url, parsed);
      return parsed;
    } catch { return null; }
  }

  /** Is `cert` revoked? `issuers` are candidate CRL-signer certs (the chain + anchors). */
  async isRevoked(cert: X509Certificate, issuers: X509Certificate[]): Promise<CrlResult> {
    const hardFail = this.env.FHIRENGINE_UDAP_CRL_HARD_FAIL === "true";
    const serial = serialKey(cert.serialNumber);
    const urls = crlUrlsFor(cert, this.env);
    if (!urls.length) return { revoked: false }; // no CRL to consult
    for (const url of urls) {
      const parsed = await this.getCrl(url);
      if (!parsed) { if (hardFail) return { revoked: true, reason: `CRL unavailable (${url}) and hard-fail is on` }; continue; }
      if (!(await this.verifyCrl(parsed, issuers))) { if (hardFail) return { revoked: true, reason: `CRL signature not trusted (${url})` }; continue; }
      if (parsed.serials.has(serial)) return { revoked: true, reason: `revoked by CRL ${url}` };
    }
    return { revoked: false };
  }

  private async verifyCrl(parsed: ParsedCrl, issuers: X509Certificate[]): Promise<boolean> {
    for (const iss of issuers) {
      try {
        const asn1 = asn1js.fromBER(ab(iss.raw));
        if (await parsed.crl.verify({ issuerCertificate: new Certificate({ schema: asn1.result }) })) return true;
      } catch { /* wrong issuer / verify error → try the next */ }
    }
    return false;
  }
}

export const crlCheckEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.FHIRENGINE_UDAP_CRL_CHECK === "true";
