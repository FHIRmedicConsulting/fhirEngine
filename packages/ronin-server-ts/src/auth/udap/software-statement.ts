/**
 * UDAP software-statement verification (ADR-0036). A UDAP dynamic client registration presents a
 * signed JWT ("software statement") whose `x5c` header carries the client's certificate chain. We
 * verify the chain roots in a trusted anchor (trust.ts), verify the JWT under the leaf cert's key,
 * and validate the DCR claims — then derive the client's token-signing JWKS from that same cert
 * (UDAP clients authenticate with the same certificate via private_key_jwt).
 */
import { jwtVerify, decodeProtectedHeader, exportJWK, calculateJwkThumbprint } from "jose";
import type { X509Certificate } from "node:crypto";
import { verifyCertChain, loadTrustAnchors, leafPublicKey, parseX5c, issuerOf } from "./trust.js";
import { CrlRevocationChecker, crlCheckEnabled } from "./crl.js";
import { OcspRevocationChecker, ocspCheckEnabled } from "./ocsp.js";
import { validateCertPath, strictPathEnabled } from "./path-validation.js";

export class UdapError extends Error {}

export interface SoftwareStatement {
  iss: string;
  clientName: string;
  grantTypes: string[];
  responseTypes: string[];
  scope?: string;
  redirectUris?: string[];
  tokenEndpointAuthMethod: string;
  /** The client's token-signing key, derived from the leaf certificate. */
  jwks: { keys: Record<string, unknown>[] };
}

export interface VerifyOptions {
  /** Expected `aud` — the registration endpoint URL. */
  audience: string;
  anchors?: X509Certificate[];
  now?: Date;
  /** Injectable live-CRL checker (tests); defaults to a real one when RONIN_UDAP_CRL_CHECK=true. */
  crlChecker?: CrlRevocationChecker;
  /** Injectable OCSP checker (tests); defaults to a real one when RONIN_UDAP_OCSP_CHECK=true. */
  ocspChecker?: OcspRevocationChecker;
  /** Override RFC 5280 strict path validation (tests); defaults to strictPathEnabled(). */
  strictPath?: boolean;
}

export async function verifySoftwareStatement(jwt: string, opts: VerifyOptions): Promise<SoftwareStatement> {
  const anchors = opts.anchors ?? loadTrustAnchors();

  let header: { alg?: string; x5c?: unknown };
  try { header = decodeProtectedHeader(jwt); } catch { throw new UdapError("malformed software statement"); }
  const x5c = header.x5c as string[] | undefined;
  if (!Array.isArray(x5c) || !x5c.length) throw new UdapError("software statement missing x5c certificate chain");

  const chain = verifyCertChain(x5c, anchors, opts.now);
  if (!chain.ok || !chain.leaf) throw new UdapError(`untrusted certificate: ${chain.reason}`);

  // RFC 5280 strict path validation (basic constraints, key usage, name constraints, path length).
  if (opts.strictPath ?? strictPathEnabled()) {
    const pv = await validateCertPath(x5c, anchors);
    if (!pv.ok) throw new UdapError(`certificate path validation failed: ${pv.reason}`);
  }

  // Live revocation (opt-in, async): CRL and/or OCSP. CRL verifies vs any trusted issuer; OCSP needs
  // the cert's specific issuer. Either mechanism reporting "revoked" rejects the statement.
  if (opts.crlChecker || opts.ocspChecker || crlCheckEnabled() || ocspCheckEnabled()) {
    const certs = parseX5c(x5c);
    const candidates = [...certs, ...anchors];
    if (opts.crlChecker || crlCheckEnabled()) {
      const crl = opts.crlChecker ?? new CrlRevocationChecker();
      for (const cert of certs) {
        const r = await crl.isRevoked(cert, candidates);
        if (r.revoked) throw new UdapError(`untrusted certificate: ${r.reason}`);
      }
    }
    if (opts.ocspChecker || ocspCheckEnabled()) {
      const ocsp = opts.ocspChecker ?? new OcspRevocationChecker();
      for (const cert of certs) {
        const issuer = issuerOf(cert, candidates);
        if (!issuer) continue; // no issuer available → can't OCSP this cert
        const r = await ocsp.isRevoked(cert, issuer);
        if (r.revoked) throw new UdapError(`untrusted certificate: ${r.reason}`);
      }
    }
  }

  const leafKey = leafPublicKey(chain.leaf);
  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(jwt, leafKey, { audience: opts.audience }));
  } catch { throw new UdapError("software statement signature or audience invalid"); }

  if (!payload.iss || payload.iss !== payload.sub) {
    throw new UdapError("software statement iss must equal sub (the client URI)");
  }

  // Derive the client's JWKS from the leaf cert key (same-cert private_key_jwt auth).
  const jwk = await exportJWK(leafKey);
  const kid = await calculateJwkThumbprint(jwk);
  const clientJwk = { ...jwk, kid, alg: header.alg ?? "RS256", use: "sig" };

  return {
    iss: String(payload.iss),
    clientName: String(payload.client_name ?? payload.iss),
    grantTypes: Array.isArray(payload.grant_types) ? (payload.grant_types as string[]) : [],
    responseTypes: Array.isArray(payload.response_types) ? (payload.response_types as string[]) : [],
    scope: payload.scope != null ? String(payload.scope) : undefined,
    redirectUris: Array.isArray(payload.redirect_uris) ? (payload.redirect_uris as string[]) : undefined,
    tokenEndpointAuthMethod: payload.token_endpoint_auth_method != null ? String(payload.token_endpoint_auth_method) : "private_key_jwt",
    jwks: { keys: [clientJwk] },
  };
}
