/**
 * UDAP trust foundation (ADR-0036): software-statement verification against a certificate trust
 * chain, and Trusted Dynamic Client Registration. Uses openssl to mint a CA + leaf cert, then signs
 * a real software statement with the leaf key — exercising the actual X.509 + JWT crypto path.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, readFileSync as read } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { X509Certificate } from "node:crypto";
import { Hono } from "hono";
import { SignJWT, importPKCS8 } from "jose";
import { verifySoftwareStatement, UdapError } from "../../src/auth/udap/software-statement.js";
import { udapRoutes } from "../../src/auth/udap/udap-routes.js";
import { getRegisteredClient, resetRegisteredClients } from "../../src/auth/udap/registered-clients.js";
import { resolveClient } from "../../src/auth/oauth/clients.js";

const BASE = "http://ronin.test";
const REG = `${BASE}/udap/register`;
const CLIENT_URI = "https://client.example/fhir";

/** Mint a CA and a leaf cert (leaf signed by CA, SAN URI = clientUri) via openssl. */
function mintCa(dir: string, cn: string, clientUri: string) {
  const p = (f: string) => join(dir, f);
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", p(`${cn}-ca.key`), "-out", p(`${cn}-ca.crt`), "-days", "2", "-subj", `/CN=${cn} CA`]);
  execFileSync("openssl", ["req", "-newkey", "rsa:2048", "-nodes", "-keyout", p(`${cn}-leaf.key`), "-out", p(`${cn}-leaf.csr`), "-subj", `/CN=${cn}-client`]);
  writeFileSync(p(`${cn}-ext.cnf`), `subjectAltName=URI:${clientUri}\n`);
  execFileSync("openssl", ["x509", "-req", "-in", p(`${cn}-leaf.csr`), "-CA", p(`${cn}-ca.crt`), "-CAkey", p(`${cn}-ca.key`), "-CAcreateserial", "-out", p(`${cn}-leaf.crt`), "-days", "1", "-extfile", p(`${cn}-ext.cnf`)]);
  const leafDer = execFileSync("openssl", ["x509", "-in", p(`${cn}-leaf.crt`), "-outform", "DER"]);
  return {
    caPath: p(`${cn}-ca.crt`),
    caCert: new X509Certificate(read(p(`${cn}-ca.crt`), "utf8")),
    leafKeyPem: read(p(`${cn}-leaf.key`), "utf8"),
    leafDerB64: Buffer.from(leafDer).toString("base64"),
  };
}

async function softwareStatement(leafKeyPem: string, x5c: string[], over: Record<string, unknown> = {}) {
  const key = await importPKCS8(leafKeyPem, "RS256");
  return new SignJWT({
    client_name: "Example Client", grant_types: ["client_credentials"], response_types: [],
    scope: "system/*.rs", token_endpoint_auth_method: "private_key_jwt", ...over,
  })
    .setProtectedHeader({ alg: "RS256", x5c })
    .setIssuer(CLIENT_URI).setSubject(CLIENT_URI).setAudience(REG)
    .setIssuedAt().setJti(`jti-${x5c[0]!.slice(0, 8)}`).setExpirationTime("5m")
    .sign(key);
}

let trusted: ReturnType<typeof mintCa>;
let untrusted: ReturnType<typeof mintCa>;
let dir: string;
let opensslOk = true;

beforeAll(() => {
  try {
    dir = mkdtempSync(join(tmpdir(), "ronin-udap-"));
    trusted = mintCa(dir, "trusted", CLIENT_URI);
    untrusted = mintCa(dir, "untrusted", CLIENT_URI);
    process.env.RONIN_UDAP_TRUST_ANCHORS = trusted.caPath; // only the trusted CA is an anchor
  } catch { opensslOk = false; } // environments without openssl skip the crypto-path tests
});
afterAll(() => { delete process.env.RONIN_UDAP_TRUST_ANCHORS; resetRegisteredClients(); });

describe.skipIf(!opensslOk)("UDAP software statement + DCR", () => {
  it("verifies a software statement signed by a trusted-chained cert", async () => {
    const jwt = await softwareStatement(trusted.leafKeyPem, [trusted.leafDerB64]);
    const ss = await verifySoftwareStatement(jwt, { audience: REG, anchors: [trusted.caCert] });
    expect(ss.iss).toBe(CLIENT_URI);
    expect(ss.grantTypes).toContain("client_credentials");
    expect(ss.jwks.keys).toHaveLength(1); // client key derived from the leaf cert
  });

  it("rejects a software statement from an UNTRUSTED CA", async () => {
    const jwt = await softwareStatement(untrusted.leafKeyPem, [untrusted.leafDerB64]);
    await expect(verifySoftwareStatement(jwt, { audience: REG, anchors: [trusted.caCert] }))
      .rejects.toBeInstanceOf(UdapError);
  });

  it("rejects a wrong-audience software statement", async () => {
    const jwt = await softwareStatement(trusted.leafKeyPem, [trusted.leafDerB64]);
    await expect(verifySoftwareStatement(jwt, { audience: "https://evil/register", anchors: [trusted.caCert] }))
      .rejects.toBeInstanceOf(UdapError);
  });

  it("DCR registers a trusted client; it then resolves for the token endpoint", async () => {
    resetRegisteredClients();
    const app = new Hono();
    app.route("/", udapRoutes(BASE));
    const jwt = await softwareStatement(trusted.leafKeyPem, [trusted.leafDerB64]);
    const res = await app.request("/udap/register", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ software_statement: jwt, udap: "1" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.client_id).toBe(CLIENT_URI);
    expect(getRegisteredClient(CLIENT_URI)).toBeTruthy();
    expect(resolveClient(CLIENT_URI)?.jwks?.keys).toHaveLength(1); // usable by private_key_jwt
  });

  it("DCR rejects an untrusted software statement with 400", async () => {
    const app = new Hono();
    app.route("/", udapRoutes(BASE));
    const jwt = await softwareStatement(untrusted.leafKeyPem, [untrusted.leafDerB64]);
    const res = await app.request("/udap/register", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ software_statement: jwt, udap: "1" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_software_statement");
  });
});

describe("UDAP metadata", () => {
  it("serves .well-known/udap", async () => {
    const app = new Hono();
    app.route("/", udapRoutes(BASE));
    const meta = await (await app.request("/.well-known/udap")).json();
    expect(meta.udap_versions_supported).toContain("1");
    expect(meta.registration_endpoint).toBe(REG);
    expect(meta.token_endpoint_auth_methods_supported).toContain("private_key_jwt");
  });
});
