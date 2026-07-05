/**
 * SSRF guard for cert-supplied CRL/OCSP URLs (audit backlog). Blocks the metadata/internal-host
 * vectors an attacker's UDAP cert could point CDP/AIA extensions at.
 */
import { describe, it, expect } from "vitest";
import { assertPublicHttpUrl } from "../../src/auth/udap/ssrf-guard.js";

describe("assertPublicHttpUrl", () => {
  it("rejects non-http(s) schemes", async () => {
    await expect(assertPublicHttpUrl("file:///etc/passwd")).rejects.toThrow(/scheme/);
    await expect(assertPublicHttpUrl("gopher://x/1")).rejects.toThrow(/scheme/);
  });

  it("rejects cloud-metadata + private/loopback IP literals", async () => {
    await expect(assertPublicHttpUrl("http://169.254.169.254/latest/meta-data")).rejects.toThrow(/private|loopback/);
    await expect(assertPublicHttpUrl("http://127.0.0.1:8077/query")).rejects.toThrow(/private|loopback/);
    await expect(assertPublicHttpUrl("http://10.0.0.5/crl")).rejects.toThrow(/private|loopback/);
    await expect(assertPublicHttpUrl("http://192.168.1.1/crl")).rejects.toThrow(/private|loopback/);
    await expect(assertPublicHttpUrl("http://172.16.5.5/crl")).rejects.toThrow(/private|loopback/);
    await expect(assertPublicHttpUrl("http://[::1]/crl")).rejects.toThrow(/private|loopback/);
  });

  it("allows a public IP literal", async () => {
    await expect(assertPublicHttpUrl("http://8.8.8.8/crl")).resolves.toBeUndefined();
  });

  it("rejects a malformed URL", async () => {
    await expect(assertPublicHttpUrl("not a url")).rejects.toThrow();
  });
});
