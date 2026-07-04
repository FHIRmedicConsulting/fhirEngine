/**
 * Live CRL revocation (ADR-0036): CrlRevocationChecker downloads + signature-verifies a CRL and
 * rejects a revoked cert; verifySoftwareStatement enforces it. Uses a real openssl CA that issues,
 * revokes, and publishes a CRL. Skips where openssl is unavailable.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, readFileSync as read } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { X509Certificate } from "node:crypto";
import { SignJWT, importPKCS8 } from "jose";
import { CrlRevocationChecker } from "../../src/auth/udap/crl.js";
import { verifySoftwareStatement, UdapError } from "../../src/auth/udap/software-statement.js";

const REG = "http://ronin.test/udap/register";
const CID = "https://client.example/fhir";
const CRL_URL = "http://crl.test/ca.crl";

let ok = true;
let dir: string;
let caCert: X509Certificate, leaf1: X509Certificate, leaf2: X509Certificate;
let leaf1Key: string, leaf1Der: string, crlDer: Uint8Array;

beforeAll(() => {
  try {
    dir = mkdtempSync(join(tmpdir(), "ronin-crl-"));
    const p = (f: string) => join(dir, f);
    const ossl = (...a: string[]) => execFileSync("openssl", a, { cwd: dir });
    ossl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.crt", "-days", "5", "-subj", "/CN=Ronin CRL Test CA");
    writeFileSync(p("index.txt"), ""); writeFileSync(p("serial"), "1000\n"); writeFileSync(p("crlnumber"), "1000\n");
    writeFileSync(p("openssl.cnf"),
      "[ca]\ndefault_ca=CA_default\n[CA_default]\ndatabase=./index.txt\nnew_certs_dir=.\ncertificate=./ca.crt\n" +
      "private_key=./ca.key\nserial=./serial\ncrlnumber=./crlnumber\ndefault_md=sha256\ndefault_days=3\n" +
      "default_crl_days=5\npolicy=policy_any\n[policy_any]\ncommonName=supplied\n");
    for (const n of ["1", "2"]) {
      ossl("req", "-newkey", "rsa:2048", "-nodes", "-keyout", `leaf${n}.key`, "-out", `leaf${n}.csr`, "-subj", `/CN=leaf${n}`);
      ossl("ca", "-batch", "-config", "openssl.cnf", "-in", `leaf${n}.csr`, "-out", `leaf${n}.crt`);
    }
    ossl("ca", "-batch", "-config", "openssl.cnf", "-revoke", "leaf1.crt"); // revoke leaf1 only
    ossl("ca", "-batch", "-config", "openssl.cnf", "-gencrl", "-out", "crl.pem");
    crlDer = new Uint8Array(execFileSync("openssl", ["crl", "-in", "crl.pem", "-outform", "DER"], { cwd: dir }));
    caCert = new X509Certificate(read(p("ca.crt"), "utf8"));
    leaf1 = new X509Certificate(read(p("leaf1.crt"), "utf8"));
    leaf2 = new X509Certificate(read(p("leaf2.crt"), "utf8"));
    leaf1Key = read(p("leaf1.key"), "utf8");
    leaf1Der = Buffer.from(execFileSync("openssl", ["x509", "-in", "leaf1.crt", "-outform", "DER"], { cwd: dir })).toString("base64");
  } catch { ok = false; }
});
afterAll(() => { delete process.env.RONIN_UDAP_CRL_URLS; delete process.env.RONIN_UDAP_CRL_HARD_FAIL; delete process.env.RONIN_UDAP_CRL_CHECK; });

const checker = (fetch: () => Promise<Uint8Array>, env: Record<string, string> = {}) =>
  new CrlRevocationChecker(fetch, () => Date.now(), { RONIN_UDAP_CRL_URLS: CRL_URL, ...env } as NodeJS.ProcessEnv);

describe.skipIf(!ok)("live CRL revocation", () => {
  it("flags a revoked cert and clears a non-revoked one (CRL signature-verified vs the CA)", async () => {
    const c = checker(async () => crlDer);
    expect((await c.isRevoked(leaf1, [caCert])).revoked).toBe(true);  // leaf1 was revoked
    expect((await c.isRevoked(leaf2, [caCert])).revoked).toBe(false); // leaf2 was not
  });

  it("does NOT trust a CRL that isn't signed by a known issuer (soft-fail → not revoked)", async () => {
    const strangerCa = new X509Certificate(
      execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "s.key"), "-subj", "/CN=Stranger", "-days", "2"], { cwd: dir }),
    );
    const c = checker(async () => crlDer);
    expect((await c.isRevoked(leaf1, [strangerCa])).revoked).toBe(false); // CRL sig not trusted → unknown
  });

  it("hard-fail rejects when the CRL can't be fetched", async () => {
    const c = checker(async () => { throw new Error("down"); }, { RONIN_UDAP_CRL_HARD_FAIL: "true" });
    expect((await c.isRevoked(leaf1, [caCert])).revoked).toBe(true);
  });

  it("verifySoftwareStatement rejects a software statement from a revoked cert", async () => {
    process.env.RONIN_UDAP_CRL_URLS = CRL_URL;
    const key = await importPKCS8(leaf1Key, "RS256");
    const jwt = await new SignJWT({ client_name: "x", grant_types: ["client_credentials"] })
      .setProtectedHeader({ alg: "RS256", x5c: [leaf1Der] })
      .setIssuer(CID).setSubject(CID).setAudience(REG).setIssuedAt().setJti("j1").setExpirationTime("5m").sign(key);
    await expect(
      verifySoftwareStatement(jwt, { audience: REG, anchors: [caCert], crlChecker: checker(async () => crlDer) }),
    ).rejects.toThrow(/revoked/i);
  });
});
