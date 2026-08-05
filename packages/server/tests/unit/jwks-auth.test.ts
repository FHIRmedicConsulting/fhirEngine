import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { generateKeyPair, exportSPKI, SignJWT } from "jose";
import { JwksAuthStrategy } from "../../src/auth/idp/jwks-auth.js";

const ENV_KEYS = [
  "FHIRENGINE_JWKS_URI", "FHIRENGINE_JWT_PUBLIC_KEY", "FHIRENGINE_JWT_ALG",
  "FHIRENGINE_JWT_ISSUER", "FHIRENGINE_JWT_AUDIENCE",
] as const;

let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let otherKeys: Awaited<ReturnType<typeof generateKeyPair>>;
let publicPem: string;
let otherPublicPem: string;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  keys = await generateKeyPair("ES256", { extractable: true });
  otherKeys = await generateKeyPair("ES256", { extractable: true });
  publicPem = await exportSPKI(keys.publicKey);
  otherPublicPem = await exportSPKI(otherKeys.publicKey);
});

beforeEach(() => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.FHIRENGINE_JWT_PUBLIC_KEY = publicPem;
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const TOKEN_LIFETIME = "5m";
async function sign(claims: Record<string, unknown>, opts: { key?: CryptoKey; exp?: string | number; iss?: string; aud?: string } = {}): Promise<string> {
  let jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: "ES256" })
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? TOKEN_LIFETIME);
  if (opts.iss) jwt = jwt.setIssuer(opts.iss);
  if (opts.aud) jwt = jwt.setAudience(opts.aud);
  return jwt.sign((opts.key ?? keys.privateKey) as CryptoKey);
}

describe("JwksAuthStrategy", () => {
  it("verifies a validly-signed token and maps SMART claims from the payload", async () => {
    const token = await sign({
      sub: "user-1", client_id: "app-1", scope: "patient/Observation.rs launch/patient",
      patient: "pat-42", encounter: "enc-7", fhirUser: "Practitioner/dr-1", purpose_of_use: "TREAT",
    }, { iss: "https://idp.example" });
    const r = await new JwksAuthStrategy().introspect(token);
    expect(r.active).toBe(true);
    expect(r.sub).toBe("user-1");
    expect(r.client_id).toBe("app-1");
    expect(r.scope).toBe("patient/Observation.rs launch/patient");
    expect(r.patient).toBe("pat-42");
    expect(r.encounter).toBe("enc-7");
    expect(r.fhirUser).toBe("Practitioner/dr-1");
    expect(r.purposeOfUse).toBe("TREAT");
    expect(r.iss).toBe("https://idp.example");
    expect(typeof r.exp).toBe("number");
    expect(typeof r.iat).toBe("number");
  });

  it("joins an array scp claim and falls back to azp / pou", async () => {
    const token = await sign({ sub: "u", azp: "azp-client", scp: ["system/*.read", "openid"], pou: "HOPERAT" });
    const r = await new JwksAuthStrategy().introspect(token);
    expect(r.active).toBe(true);
    expect(r.scope).toBe("system/*.read openid");
    expect(r.client_id).toBe("azp-client");
    expect(r.purposeOfUse).toBe("HOPERAT");
  });

  it("missing scope claim yields an empty scope string, not undefined", async () => {
    const r = await new JwksAuthStrategy().introspect(await sign({ sub: "u" }));
    expect(r.active).toBe(true);
    expect(r.scope).toBe("");
  });

  it("rejects an expired token without echoing it", async () => {
    const token = await sign({ sub: "u" }, { exp: Math.floor(Date.now() / 1000) - 3600 });
    const r = await new JwksAuthStrategy().introspect(token);
    expect(r.active).toBe(false);
    expect(r.reason).toMatch(/JWT verification failed/);
    expect(r.reason).not.toContain(token);
  });

  it("rejects a token signed by a different key (forged JWT)", async () => {
    const forged = await sign({ sub: "attacker", scope: "system/*.cruds" }, { key: otherKeys.privateKey as CryptoKey });
    const r = await new JwksAuthStrategy().introspect(forged);
    expect(r.active).toBe(false);
  });

  it("rejects an unsigned alg=none token outright", async () => {
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const none = `${b64({ alg: "none", typ: "JWT" })}.${b64({ sub: "attacker", exp: Math.floor(Date.now() / 1000) + 300 })}.`;
    const r = await new JwksAuthStrategy().introspect(none);
    expect(r.active).toBe(false);
  });

  it("rejects garbage that is not a JWT at all", async () => {
    const r = await new JwksAuthStrategy().introspect("not-a-jwt");
    expect(r.active).toBe(false);
    expect(r.reason).toBeDefined();
  });

  it("pins the issuer when FHIRENGINE_JWT_ISSUER is set", async () => {
    process.env.FHIRENGINE_JWT_ISSUER = "https://good-idp.example";
    const strategy = new JwksAuthStrategy();
    expect((await strategy.introspect(await sign({ sub: "u" }, { iss: "https://evil-idp.example" }))).active).toBe(false);
    expect((await strategy.introspect(await sign({ sub: "u" }, { iss: "https://good-idp.example" }))).active).toBe(true);
  });

  it("pins the audience when FHIRENGINE_JWT_AUDIENCE is set", async () => {
    process.env.FHIRENGINE_JWT_AUDIENCE = "https://fhir.example/r4";
    const strategy = new JwksAuthStrategy();
    expect((await strategy.introspect(await sign({ sub: "u" }, { aud: "https://other.example" }))).active).toBe(false);
    expect((await strategy.introspect(await sign({ sub: "u" }, { aud: "https://fhir.example/r4" }))).active).toBe(true);
  });

  it("fails closed (inactive, helpful reason) when no verification key is configured", async () => {
    delete process.env.FHIRENGINE_JWT_PUBLIC_KEY;
    const r = await new JwksAuthStrategy().introspect(await sign({ sub: "u" }));
    expect(r.active).toBe(false);
    expect(r.reason).toMatch(/no JWT verification key/);
  });

  it("caches the key until resetKey() — rotation requires an explicit reset", async () => {
    const strategy = new JwksAuthStrategy();
    expect((await strategy.introspect(await sign({ sub: "u" }))).active).toBe(true);

    // Rotate the env to the other public key: cached key still verifies old, rejects new…
    process.env.FHIRENGINE_JWT_PUBLIC_KEY = otherPublicPem;
    const newKeyToken = await sign({ sub: "u" }, { key: otherKeys.privateKey as CryptoKey });
    expect((await strategy.introspect(newKeyToken)).active).toBe(false);

    // …until resetKey() re-imports from the env.
    strategy.resetKey();
    expect((await strategy.introspect(newKeyToken)).active).toBe(true);
    expect((await strategy.introspect(await sign({ sub: "u" }))).active).toBe(false); // old key now rejected
  });
});
