/**
 * Hardened TLS options for the in-process HTTPS listener (ADR-0031, Proposed).
 *
 * Baseline: NIST SP 800-52r2 + ONC (g)(10)(viii) — TLS 1.2 minimum (1.3 preferred),
 * AEAD-only ECDHE cipher suites, server cipher-order honored. FIPS 140-3 validated crypto
 * is a *platform* property (the OpenSSL/Node build + the OS module) — this pins the policy;
 * the operator supplies FIPS-validated crypto and certs.
 *
 * Transport security (45 CFR §164.312(e)(1)) can be terminated here (single-node / dev) OR at
 * a reverse proxy / load balancer (the documented production default). See `profile.ts` for the
 * production fail-closed check that requires one or the other.
 */
import { readFileSync, watch } from "node:fs";
import { dirname, basename } from "node:path";
import { constants as cryptoConstants } from "node:crypto";
import type { Server as HttpsServer } from "node:https";

/**
 * FIPS-approved AEAD suites for TLS 1.2, in preference order (SP 800-52r2 §3.3.1.1).
 * ChaCha20-Poly1305 is intentionally excluded — it is not FIPS 140-3 approved.
 * TLS 1.3 suites (TLS_AES_128_GCM_SHA256, TLS_AES_256_GCM_SHA384) are negotiated by OpenSSL
 * for 1.3 connections; the FIPS provider drops the non-approved 1.3 suite automatically.
 */
export const NIST_TLS12_CIPHERS = [
  "ECDHE-ECDSA-AES256-GCM-SHA384",
  "ECDHE-RSA-AES256-GCM-SHA384",
  "ECDHE-ECDSA-AES128-GCM-SHA256",
  "ECDHE-RSA-AES128-GCM-SHA256",
].join(":");

export interface TlsConfig {
  enabled: boolean;
  /** Node https serverOptions when a cert/key are configured, else undefined. */
  serverOptions?: {
    cert: Buffer;
    key: Buffer;
    minVersion: "TLSv1.2";
    maxVersion: "TLSv1.3";
    ciphers: string;
    honorCipherOrder: true;
    secureOptions: number;
  };
}

/**
 * Build hardened TLS server options from RONIN_TLS_CERT / RONIN_TLS_KEY (PEM paths).
 * `RONIN_TLS_CIPHERS` overrides the TLS 1.2 suite list (advanced/operator use).
 * Returns { enabled:false } when no cert/key are set (TLS then belongs to a proxy).
 */
export function buildTlsConfig(env: NodeJS.ProcessEnv = process.env): TlsConfig {
  const certPath = env.RONIN_TLS_CERT;
  const keyPath = env.RONIN_TLS_KEY;
  if (!certPath || !keyPath) return { enabled: false };

  const ciphers = env.RONIN_TLS_CIPHERS?.trim() || NIST_TLS12_CIPHERS;
  return {
    enabled: true,
    serverOptions: {
      cert: readFileSync(certPath),
      key: readFileSync(keyPath),
      minVersion: "TLSv1.2",
      maxVersion: "TLSv1.3",
      ciphers,
      honorCipherOrder: true,
      // Belt-and-suspenders: disable the obsolete protocol versions at the OpenSSL layer too.
      secureOptions:
        cryptoConstants.SSL_OP_NO_SSLv2 |
        cryptoConstants.SSL_OP_NO_SSLv3 |
        cryptoConstants.SSL_OP_NO_TLSv1 |
        cryptoConstants.SSL_OP_NO_TLSv1_1,
    },
  };
}

/**
 * Hot-reload the TLS certificate/key without a restart (ADR-0031) — so an ACME/cert-manager
 * renewal takes effect on new connections via `server.setSecureContext(...)`. Watches the parent
 * directories of the cert/key (renewals typically replace files, breaking a direct file watch) and
 * debounces bursty writes. Returns a stop() to close the watchers, or undefined if TLS is off.
 */
export function watchTlsCert(
  server: HttpsServer,
  onReload?: (err?: unknown) => void,
  env: NodeJS.ProcessEnv = process.env,
): (() => void) | undefined {
  const certPath = env.RONIN_TLS_CERT;
  const keyPath = env.RONIN_TLS_KEY;
  if (!certPath || !keyPath) return undefined;

  const files = new Set([basename(certPath), basename(keyPath)]);
  const dirs = new Set([dirname(certPath), dirname(keyPath)]);
  let timer: NodeJS.Timeout | undefined;

  const reload = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        const cfg = buildTlsConfig(env);
        if (cfg.enabled && cfg.serverOptions) {
          server.setSecureContext(cfg.serverOptions);
          onReload?.();
        }
      } catch (err) {
        onReload?.(err); // keep serving with the existing context on a bad/partial write
      }
    }, 500);
  };

  const watchers = [...dirs].map((d) =>
    watch(d, (_event, filename) => { if (filename && files.has(filename.toString())) reload(); }),
  );
  return () => { for (const w of watchers) w.close(); if (timer) clearTimeout(timer); };
}
