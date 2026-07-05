/**
 * Live OCSP revocation (ADR-0036, RFC 6960). Queries the OCSP responder from a cert's Authority
 * Information Access (AIA) extension (or `FHIRENGINE_UDAP_OCSP_URLS`) for its single-cert status. pkijs
 * builds the request and verifies the signed response (against the issuer / a delegated responder).
 *
 * Opt-in: `FHIRENGINE_UDAP_OCSP_CHECK=true`. Soft-fail by default (responder down / unknown → not rejected);
 * `FHIRENGINE_UDAP_OCSP_HARD_FAIL=true` fails closed. Uses `pkijs` + `asn1js` (approved).
 */
import { X509Certificate } from "node:crypto";
import * as asn1js from "asn1js";
import { OCSPRequest, OCSPResponse, Certificate } from "pkijs";
import "./pki-engine.js"; // sets the pkijs crypto engine (side effect)
import { assertPublicHttpUrl } from "./ssrf-guard.js";

const ab = (u8: Uint8Array): ArrayBuffer => new Uint8Array(u8).buffer as ArrayBuffer;
const toPk = (cert: X509Certificate): Certificate => new Certificate({ schema: asn1js.fromBER(ab(cert.raw)).result });

export type OcspFetcher = (url: string, requestBody: Uint8Array) => Promise<Uint8Array>;

const httpFetchOcsp: OcspFetcher = async (url, body) => {
  await assertPublicHttpUrl(url); // SSRF guard — AIA responder URL comes from the (untrusted) cert
  return new Uint8Array(await (await fetch(url, { method: "POST", headers: { "Content-Type": "application/ocsp-request" }, body })).arrayBuffer());
};

/** OCSP responder URLs from the cert's AIA extension (1.3.6.1.5.5.7.1.1 / ocsp 48.1) + operator config. */
export function ocspUrlsFor(cert: X509Certificate, env: NodeJS.ProcessEnv = process.env): string[] {
  const urls = new Set<string>();
  try {
    for (const ext of toPk(cert).extensions ?? []) {
      if (ext.extnID !== "1.3.6.1.5.5.7.1.1") continue; // Authority Information Access
      const descs = (ext.parsedValue?.accessDescriptions ?? []) as Array<{ accessMethod: string; accessLocation: { type: number; value: string } }>;
      for (const d of descs) {
        if (d.accessMethod === "1.3.6.1.5.5.7.48.1" && d.accessLocation?.type === 6) urls.add(d.accessLocation.value); // OCSP / URI
      }
    }
  } catch { /* no/unparseable AIA → rely on operator URLs */ }
  for (const u of (env.FHIRENGINE_UDAP_OCSP_URLS ?? "").split(",").map((s) => s.trim()).filter(Boolean)) urls.add(u);
  return [...urls];
}

export interface OcspResult { revoked: boolean; reason?: string }

export class OcspRevocationChecker {
  constructor(private readonly fetcher: OcspFetcher = httpFetchOcsp, private readonly env: NodeJS.ProcessEnv = process.env) {}

  /** Query the responder for `cert` (issued by `issuer`). */
  async isRevoked(cert: X509Certificate, issuer: X509Certificate): Promise<OcspResult> {
    const hardFail = this.env.FHIRENGINE_UDAP_OCSP_HARD_FAIL === "true";
    const urls = ocspUrlsFor(cert, this.env);
    if (!urls.length) return { revoked: false };

    const pkCert = toPk(cert), pkIssuer = toPk(issuer);
    const req = new OCSPRequest();
    await req.createForCertificate(pkCert, { hashAlgorithm: "SHA-1", issuerCertificate: pkIssuer });
    const body = new Uint8Array(req.toSchema(true).toBER(false));

    const fail = (reason: string): OcspResult => (hardFail ? { revoked: true, reason } : { revoked: false });
    for (const url of urls) {
      let der: Uint8Array;
      try { der = await this.fetcher(url, body); } catch { const r = fail(`OCSP unavailable (${url})`); if (r.revoked) return r; continue; }
      try {
        const resp = new OCSPResponse({ schema: asn1js.fromBER(ab(der)).result });
        if (resp.responseStatus.valueBlock.valueDec !== 0) { const r = fail(`OCSP responseStatus != successful (${url})`); if (r.revoked) return r; continue; }
        const status = await resp.getCertificateStatus(pkCert, pkIssuer); // verifies the response signature
        if (!status.isForCertificate) continue;
        if (status.status === 1) return { revoked: true, reason: `revoked by OCSP ${url}` };
        if (status.status === 0) return { revoked: false }; // definitively good
        // status 2 (unknown) → try the next responder
      } catch { const r = fail(`OCSP verification failed (${url})`); if (r.revoked) return r; continue; }
    }
    return { revoked: false };
  }
}

export const ocspCheckEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.FHIRENGINE_UDAP_OCSP_CHECK === "true";
