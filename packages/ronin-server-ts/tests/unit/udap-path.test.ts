/**
 * RFC 5280 path hardening (ADR-0036): validateCertPath enforces basic constraints, key usage, and
 * name constraints. Uses a real openssl CA with a DNS name constraint (permitted: example.com).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync as read } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { X509Certificate } from "node:crypto";
import { validateCertPath } from "../../src/auth/udap/path-validation.js";

let ok = true;
let caCert: X509Certificate;
let inDer: string, outDer: string;

beforeAll(() => {
  try {
    const dir = mkdtempSync(join(tmpdir(), "ronin-path-"));
    const p = (f: string) => join(dir, f);
    const ossl = (...a: string[]) => execFileSync("openssl", a, { cwd: dir });
    // CA constrained to the example.com DNS subtree, with keyCertSign.
    ossl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.crt", "-days", "3",
      "-subj", "/CN=NC CA",
      "-addext", "basicConstraints=critical,CA:TRUE",
      "-addext", "keyUsage=critical,keyCertSign",
      "-addext", "nameConstraints=critical,permitted;DNS:example.com");
    const leaf = (name: string, san: string): string => {
      ossl("req", "-newkey", "rsa:2048", "-nodes", "-keyout", `${name}.key`, "-out", `${name}.csr`, "-subj", `/CN=${san}`);
      writeFileSync(p(`${name}.ext`), `subjectAltName=DNS:${san}\n`);
      ossl("x509", "-req", "-in", `${name}.csr`, "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", `${name}.crt`, "-days", "2", "-extfile", `${name}.ext`);
      return Buffer.from(execFileSync("openssl", ["x509", "-in", `${name}.crt`, "-outform", "DER"], { cwd: dir })).toString("base64");
    };
    inDer = leaf("in", "app.example.com");   // within the permitted subtree
    outDer = leaf("out", "evil.com");        // outside it
    caCert = new X509Certificate(read(p("ca.crt"), "utf8"));
  } catch { ok = false; }
});

describe.skipIf(!ok)("RFC 5280 path validation (name constraints)", () => {
  it("accepts a leaf whose SAN is within the CA's permitted name subtree", async () => {
    const r = await validateCertPath([inDer], [caCert]);
    expect(r.ok).toBe(true);
  });

  it("REJECTS a leaf whose SAN is outside the permitted name subtree", async () => {
    const r = await validateCertPath([outDer], [caCert]);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/permitted subtree|excluded/i);
  });

  it("rejects when there are no trust anchors", async () => {
    expect((await validateCertPath([inDer], [])).ok).toBe(false);
  });
});
