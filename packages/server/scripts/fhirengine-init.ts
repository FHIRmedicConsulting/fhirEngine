#!/usr/bin/env node
/**
 * fhirengine-init — interactive first-run setup wizard (the "install walkthrough").
 *
 * Walks an operator through the configuration the server otherwise only documents
 * (deploy/.env.example): storage, server basics, security profile, auth, TLS, audit,
 * HTTP hardening — then writes `deploy/.env` and prints the exact run + provisioning
 * commands. Re-run safe: an existing .env seeds the defaults and is backed up on write.
 *
 * The posture preview at the end calls the SAME `evaluateSecurityPosture()` the server
 * runs at boot (ADR-0032), so "production would refuse to boot" is known before you boot.
 *
 * Usage:
 *   npm run init                 interactive
 *   npm run init -- --defaults   accept every default (non-interactive; dev profile)
 *   npm run init -- --out <path> write somewhere other than deploy/.env
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync, chmodSync, readdirSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { evaluateSecurityPosture } from "../src/security/profile.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const examplePath = path.join(repoRoot, "deploy/.env.example");

const argv = process.argv.slice(2);
const useDefaults = argv.includes("--defaults");
const outFlag = argv.indexOf("--out");
const envPath = outFlag >= 0 ? path.resolve(argv[outFlag + 1] ?? "") : path.join(repoRoot, "deploy/.env");

// ─── prompt helpers ───────────────────────────────────────────────────────────
// Own line queue instead of rl.question(): with piped stdin, readline emits buffered
// 'line' events while no question is pending and the answers are silently dropped.

const rl = readline.createInterface({ input: stdin, output: stdout, terminal: stdin.isTTY });
const lineQueue: string[] = [];
let waiter: ((s: string) => void) | null = null;
let stdinClosed = false;
rl.on("line", (l) => { if (waiter) { const w = waiter; waiter = null; w(l); } else lineQueue.push(l); });
rl.on("close", () => { stdinClosed = true; if (waiter) { const w = waiter; waiter = null; w(""); } });

function question(prompt: string): Promise<string> {
  stdout.write(prompt);
  if (lineQueue.length) { const l = lineQueue.shift()!; if (!stdin.isTTY) stdout.write(`${l}\n`); return Promise.resolve(l); }
  if (stdinClosed) { stdout.write("\n"); return Promise.resolve(""); }
  return new Promise((res) => { waiter = res; });
}

async function ask(q: string, def = "", hint = ""): Promise<string> {
  if (useDefaults) return def;
  const suffix = def ? ` [${def}]` : "";
  if (hint) console.log(`    ${dim(hint)}`);
  const a = (await question(`  ${q}${suffix}: `)).trim();
  return a || def;
}

async function yesno(q: string, def: boolean): Promise<boolean> {
  const a = (await ask(q, def ? "y" : "n")).toLowerCase();
  return a.startsWith("y");
}

/** Numbered pick list; returns the chosen key. */
async function pick(q: string, choices: Array<{ key: string; label: string }>, defKey: string): Promise<string> {
  if (useDefaults) return defKey;
  console.log(`  ${q}`);
  choices.forEach((c, i) => console.log(`    ${i + 1}) ${c.label}${c.key === defKey ? dim("  (default)") : ""}`));
  const defIdx = choices.findIndex((c) => c.key === defKey) + 1;
  for (;;) {
    const a = (await question(`  choose 1-${choices.length} [${defIdx}]: `)).trim();
    const idx = a ? Number(a) : defIdx;
    if (Number.isInteger(idx) && idx >= 1 && idx <= choices.length) return choices[idx - 1].key;
    console.log(`    please enter 1-${choices.length}`);
  }
}

async function askInt(q: string, def: number): Promise<number> {
  for (;;) {
    const a = await ask(q, String(def));
    const n = Number(a);
    if (Number.isInteger(n) && n > 0) return n;
    console.log("    please enter a positive integer");
  }
}

async function askUrl(q: string, def = "", hint = ""): Promise<string> {
  for (;;) {
    const a = await ask(q, def, hint);
    if (!a) return a;
    try { new URL(a); return a; } catch { console.log("    not a valid URL"); }
  }
}

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const section = (s: string) => console.log(`\n${bold(`── ${s} `.padEnd(64, "─"))}`);

// ─── .env parse / render (dotenv subset: KEY=value, double-quoted multiline) ──

function parseEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = readFileSync(file, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(lines[i]);
    if (!m) continue;
    let v = m[2];
    if (v.startsWith('"')) {
      // quoted (possibly multiline — PEM keys) value: consume until the closing quote
      let buf = v.slice(1);
      while (!buf.endsWith('"') && i + 1 < lines.length) buf += "\n" + lines[++i];
      out[m[1]] = buf.replace(/"$/, "");
    } else {
      out[m[1]] = v.replace(/\s+#.*$/, "").trim(); // strip trailing comment
    }
  }
  return out;
}

/** Render by substituting values into .env.example (so grouping/comments stay the
 * single source of truth), then append wizard-only vars the example doesn't carry. */
function renderEnv(values: Record<string, string>, mode: string): string {
  const quoted = (v: string) => (v.includes("\n") || v.includes("#") ? `"${v}"` : v);
  const seen = new Set<string>();
  const body = readFileSync(examplePath, "utf8").split("\n").map((line) => {
    const m = /^([A-Z][A-Z0-9_]*)=([^#]*?)(\s+#.*)?$/.exec(line);
    if (!m) return line;
    seen.add(m[1]);
    const v = values[m[1]] ?? m[2].trim();
    return `${m[1]}=${quoted(v)}${v.includes("\n") ? "" : (m[3] ?? "")}`;
  }).join("\n");
  const extra = Object.entries(values)
    .filter(([k]) => !seen.has(k))
    .map(([k, v]) => `${k}=${quoted(v)}`);
  return [
    `# Generated by fhirengine-init on ${new Date().toISOString()} — re-run \`npm run init\` to revise.`,
    `# fhirengine-init: mode=${mode}`,
    body,
    "# ─── Added by fhirengine-init (not in .env.example) ───────────────────────────",
    ...extra,
    "",
  ].join("\n");
}

// ─── wizard ───────────────────────────────────────────────────────────────────

async function main() {
  console.log(bold("\nfhirEngine setup wizard"));
  const shown = path.relative(process.cwd(), envPath);
  console.log(dim(`writes ${shown.startsWith("../..") ? envPath : shown} — nothing is applied until you confirm at the end`));

  const prior: Record<string, string> = existsSync(envPath) ? parseEnvFile(envPath) : {};
  const priorMode = existsSync(envPath)
    ? (/# fhirengine-init: mode=(\w+)/.exec(readFileSync(envPath, "utf8"))?.[1] ?? "docker")
    : "docker";
  if (Object.keys(prior).length) console.log(dim(`existing ${envPath} found — its values are the defaults below; it will be backed up`));

  const env: Record<string, string> = {};
  const def = (k: string, fallback: string) => prior[k] || fallback;

  // 1 ── deployment mode
  section("Deployment");
  const mode = await pick("How will you run the server?", [
    { key: "docker", label: "Docker Compose (server + storage sidecar containers)" },
    { key: "local", label: "Local dev (npm run dev + a Python sidecar you start yourself)" },
  ], priorMode);

  // 2 ── storage
  section("Storage (Delta Lake)");
  const priorBase = prior.FHIRENGINE_DELTA_BASE ?? "";
  const storage = await pick("Where should Delta tables live?", [
    { key: "local", label: "Local volume (default; good for dev and single-node)" },
    { key: "s3", label: "S3-compatible object store (AWS S3 / MinIO / R2)" },
    { key: "gcs", label: "Google Cloud Storage" },
    { key: "azure", label: "Azure Blob Storage" },
  ], priorBase.startsWith("s3://") ? "s3" : priorBase.startsWith("gs://") ? "gcs" : priorBase.startsWith("az://") ? "azure" : "local");
  const credHint = "leave blank to inject at runtime (op run / your orchestrator) — recommended for secrets";
  if (storage === "local") {
    env.FHIRENGINE_DELTA_BASE = await ask("Delta root path", def("FHIRENGINE_DELTA_BASE", mode === "docker" ? "/data/delta" : "./delta"),
      mode === "docker" ? "path inside the containers — the compose file maps a named volume here" : "relative to where you start the sidecar");
  } else if (storage === "s3") {
    env.FHIRENGINE_DELTA_BASE = await ask("S3 URI (s3://bucket/prefix)", def("FHIRENGINE_DELTA_BASE", ""));
    env.AWS_ACCESS_KEY_ID = await ask("AWS_ACCESS_KEY_ID", def("AWS_ACCESS_KEY_ID", ""), credHint);
    env.AWS_SECRET_ACCESS_KEY = await ask("AWS_SECRET_ACCESS_KEY", def("AWS_SECRET_ACCESS_KEY", ""), credHint);
    env.AWS_REGION = await ask("AWS_REGION", def("AWS_REGION", ""));
    const nativeS3 = await yesno("Is this native AWS S3 (not MinIO/R2/GCS-interop)?", def("AWS_S3_ALLOW_UNSAFE_RENAME", "true") === "true");
    if (nativeS3) env.AWS_S3_ALLOW_UNSAFE_RENAME = "true"; // single-writer (ADR-0026) → safe without a lock service
    else {
      const ep = await askUrl("S3 endpoint URL", def("AWS_ENDPOINT_URL", ""), "e.g. http://localhost:9000 (MinIO) or https://<account>.r2.cloudflarestorage.com");
      env.AWS_ENDPOINT_URL = ep;
      env.AWS_ENDPOINT = ep; // object_store reads AWS_ENDPOINT; newer stacks read AWS_ENDPOINT_URL — set both
      if (ep.startsWith("http://")) env.AWS_ALLOW_HTTP = "true";
    }
  } else if (storage === "gcs") {
    env.FHIRENGINE_DELTA_BASE = await ask("GCS URI (gs://bucket/prefix)", def("FHIRENGINE_DELTA_BASE", ""));
    env.GOOGLE_SERVICE_ACCOUNT = await ask("GOOGLE_SERVICE_ACCOUNT (path or JSON)", def("GOOGLE_SERVICE_ACCOUNT", ""), credHint);
  } else {
    env.FHIRENGINE_DELTA_BASE = await ask("Azure URI (az://container/prefix)", def("FHIRENGINE_DELTA_BASE", ""));
    env.AZURE_STORAGE_ACCOUNT_NAME = await ask("AZURE_STORAGE_ACCOUNT_NAME", def("AZURE_STORAGE_ACCOUNT_NAME", ""));
    env.AZURE_STORAGE_ACCOUNT_KEY = await ask("AZURE_STORAGE_ACCOUNT_KEY", def("AZURE_STORAGE_ACCOUNT_KEY", ""), credHint);
  }
  env.FHIRENGINE_STORAGE_MODE = await pick("Storage topology", [
    { key: "single", label: "single — one Delta store (the supported serving path)" },
    { key: "medallion", label: "medallion — Bronze→Silver→Gold (Gold read-path still WIP)" },
  ], def("FHIRENGINE_STORAGE_MODE", "single"));

  // 3 ── server basics
  section("Server");
  const port = await askInt("HTTP port", Number(def("FHIRENGINE_PORT", "3000")));
  env.FHIRENGINE_PORT = String(port);
  env.PORT = String(port); // the server process reads PORT; FHIRENGINE_PORT is the compose host-port mapping
  env.FHIRENGINE_PUBLIC_URL = await askUrl("Public base URL (used in FHIR links)", def("FHIRENGINE_PUBLIC_URL", `http://localhost:${port}`));
  env.FHIRENGINE_LOG_LEVEL = await pick("Log level", [
    { key: "debug", label: "debug" }, { key: "info", label: "info" }, { key: "warn", label: "warn" },
  ], def("FHIRENGINE_LOG_LEVEL", "info"));
  if (mode === "local") env.FHIRENGINE_DELTA_SIDECAR_URL = def("FHIRENGINE_DELTA_SIDECAR_URL", "http://127.0.0.1:8077");

  // 4 ── validation
  section("Validation");
  const priorVal = def("FHIRENGINE_VALIDATION_PROFILES", "");
  const valMode = await pick("Conformance validation for incoming resources", [
    { key: "", label: "Base FHIR R4 only — structure, invariants, base bindings (default)" },
    { key: "hl7.fhir.us.core", label: "Require US Core — enforce the installed US Core profile per resource type" },
    { key: "declared", label: "Enforce whatever profiles resources claim in meta.profile" },
    { key: "custom", label: "Custom — name IG package ids / profile URLs yourself" },
  ], ["", "hl7.fhir.us.core", "declared"].includes(priorVal) ? priorVal : priorVal ? "custom" : "");
  env.FHIRENGINE_VALIDATION_PROFILES = valMode === "custom"
    ? await ask("Comma-separated package ids / canonical URLs / 'declared'", priorVal)
    : valMode;
  if (env.FHIRENGINE_VALIDATION_PROFILES && env.FHIRENGINE_VALIDATION_PROFILES !== "declared") {
    console.log(dim("  note: the referenced IG must be installed (fhirengine-terminology install-ig) or the requirement is inert"));
  }

  // 5 ── security profile
  section("Security profile (ADR-0032)");
  console.log(dim("  dev:        controls opt-in/off, SYNTHETIC data only — warns, never blocks"));
  console.log(dim("  production: PHI-capable, FAILS CLOSED at boot unless auth + audit + TLS are configured"));
  const prod = (await pick("Profile", [
    { key: "dev", label: "dev (synthetic data)" },
    { key: "production", label: "production (PHI-capable, fail-closed)" },
  ], def("FHIRENGINE_SECURITY_PROFILE", "dev"))) === "production";
  env.FHIRENGINE_SECURITY_PROFILE = prod ? "production" : "dev";

  // 6 ── authentication
  section("Authentication (ADR-0030)");
  const authOn = await yesno("Enable the SMART/JWT auth gate?" + (prod ? " (required in production)" : ""), prod || def("FHIRENGINE_AUTH_ENABLED", "") === "true");
  env.FHIRENGINE_AUTH_ENABLED = authOn ? "true" : "";
  if (authOn) {
    const strategy = await pick("Who issues/verifies tokens?", [
      { key: "jwks", label: "jwks — external IdP; verify against its JWKS URL" },
      { key: "oidc", label: "oidc — external IdP via OpenID Connect discovery" },
      { key: "local", label: "local — run the built-in SMART authorization server" },
    ], def("FHIRENGINE_AUTH_STRATEGY", "jwks"));
    env.FHIRENGINE_AUTH_STRATEGY = strategy;
    if (strategy === "jwks") {
      env.FHIRENGINE_JWKS_URI = await askUrl("IdP JWKS URL", def("FHIRENGINE_JWKS_URI", ""), "e.g. https://idp.example.com/.well-known/jwks.json");
      env.FHIRENGINE_JWT_ISSUER = await ask("Expected token issuer (iss)", def("FHIRENGINE_JWT_ISSUER", ""));
      env.FHIRENGINE_JWT_AUDIENCE = await ask("Expected audience (aud)", def("FHIRENGINE_JWT_AUDIENCE", ""));
    } else if (strategy === "oidc") {
      env.FHIRENGINE_OIDC_DISCOVERY = await askUrl("OIDC discovery URL", def("FHIRENGINE_OIDC_DISCOVERY", ""), "the issuer's .well-known/openid-configuration");
    } else {
      env.FHIRENGINE_OAUTH_ENABLED = "true";
      const havePrior = !!(prior.FHIRENGINE_OAUTH_PRIVATE_KEY && prior.FHIRENGINE_OAUTH_PUBLIC_KEY);
      if (havePrior && !(await yesno("Keep the existing OAuth signing keypair?", true))) {
        delete prior.FHIRENGINE_OAUTH_PRIVATE_KEY; delete prior.FHIRENGINE_OAUTH_PUBLIC_KEY;
      }
      if (prior.FHIRENGINE_OAUTH_PRIVATE_KEY) {
        env.FHIRENGINE_OAUTH_PRIVATE_KEY = prior.FHIRENGINE_OAUTH_PRIVATE_KEY;
        env.FHIRENGINE_OAUTH_PUBLIC_KEY = prior.FHIRENGINE_OAUTH_PUBLIC_KEY!;
      } else if (await yesno("Generate a persistent RS256 signing keypair now?" + (prod ? " (production requires static keys)" : ""), true)) {
        const kp = generateKeyPairSync("rsa", { modulusLength: 2048 });
        env.FHIRENGINE_OAUTH_PRIVATE_KEY = kp.privateKey.export({ type: "pkcs8", format: "pem" }).toString().trim();
        env.FHIRENGINE_OAUTH_PUBLIC_KEY = kp.publicKey.export({ type: "spki", format: "pem" }).toString().trim();
        console.log(dim("  keypair written into the .env (private key = secret: keep the file out of git; mode 600 is set)"));
      } else {
        console.log(dim("  no keys → EPHEMERAL keypair per boot (dev only; tokens die on restart)"));
      }
      if (!prod) {
        env.FHIRENGINE_OAUTH_DEFAULT_PATIENT = await ask("Dev auto-approve patient id (launch context)", def("FHIRENGINE_OAUTH_DEFAULT_PATIENT", ""));
        env.FHIRENGINE_OAUTH_DEFAULT_USER = await ask("Dev auto-approve user id", def("FHIRENGINE_OAUTH_DEFAULT_USER", ""));
      } else {
        console.log(dim("  production: register clients via FHIRENGINE_OAUTH_CLIENTS (JSON) in the .env — see .env.example"));
      }
    }
  }

  // 7 ── transport security
  section("Transport security / TLS (ADR-0031)");
  const priorTls = prior.FHIRENGINE_TLS_TERMINATED_AT_PROXY === "true" ? "proxy" : prior.FHIRENGINE_TLS_CERT ? "inprocess" : prod ? "proxy" : "none";
  const tls = await pick("How is TLS handled?", [
    { key: "proxy", label: "Terminated at a reverse proxy / load balancer in front (recommended)" },
    { key: "inprocess", label: "In-process HTTPS (hardened SP 800-52r2; PEM cert + key on disk)" },
    { key: "none", label: "None (dev only — plain HTTP)" },
  ], priorTls);
  if (tls === "proxy") env.FHIRENGINE_TLS_TERMINATED_AT_PROXY = "true";
  if (tls === "inprocess") {
    env.FHIRENGINE_TLS_CERT = await ask("TLS cert PEM path", def("FHIRENGINE_TLS_CERT", ""));
    env.FHIRENGINE_TLS_KEY = await ask("TLS key PEM path", def("FHIRENGINE_TLS_KEY", ""));
    for (const p of [env.FHIRENGINE_TLS_CERT, env.FHIRENGINE_TLS_KEY]) {
      if (p && !existsSync(p)) console.log(dim(`  note: ${p} does not exist yet`));
    }
    if (mode === "docker") console.log(dim("  docker: mount these paths into the server container (see deploy/README.md)"));
  }

  // 8 ── audit + consent
  section("Audit + consent");
  env.FHIRENGINE_AUDIT_ENABLED = (await yesno("Capture hash-chained AuditEvents per access?" + (prod ? " (required in production)" : ""), prod || def("FHIRENGINE_AUDIT_ENABLED", "") === "true")) ? "true" : "";
  env.FHIRENGINE_CONSENT_ENFORCEMENT = (await yesno("Enforce consent + DS4P security labels at read time?", def("FHIRENGINE_CONSENT_ENFORCEMENT", "") === "true")) ? "true" : "";

  // 9 ── HTTP hardening
  section("HTTP hardening (ADR-0033)");
  env.FHIRENGINE_CORS_ORIGINS = await ask("CORS allowed origins (comma-separated)", def("FHIRENGINE_CORS_ORIGINS", ""), "blank = same-origin only in production, permissive in dev");
  const rate = await yesno("Enable rate limiting?", prod || def("FHIRENGINE_RATE_LIMIT_ENABLED", "") === "true");
  env.FHIRENGINE_RATE_LIMIT_ENABLED = rate ? "true" : "";
  if (rate) env.FHIRENGINE_RATE_LIMIT_RPM = String(await askInt("Requests per client per minute", Number(def("FHIRENGINE_RATE_LIMIT_RPM", "600"))));

  // 10 ── provisioning (printed as next steps — needs the sidecar running)
  section("Provisioning");
  const wantUsCore = await yesno("Plan to serve US Core (install the IG + terminology after first boot)?", true);
  const igDirs = wantUsCore ? findUsCorePackages() : [];

  // 11 ── posture preview using the server's own boot check
  section("Posture check (what the server will decide at boot)");
  for (const k of Object.keys(process.env)) if (k.startsWith("FHIRENGINE_")) delete process.env[k];
  Object.assign(process.env, env);
  const posture = evaluateSecurityPosture({ tlsInProcess: !!(env.FHIRENGINE_TLS_CERT && env.FHIRENGINE_TLS_KEY) });
  for (const e of posture.errors) console.log(`  ✗ ${e}`);
  for (const w of posture.warnings) console.log(`  ⚠ ${w}`);
  if (posture.ok) console.log(`  ✓ ${posture.profile} profile: server will boot`);
  else {
    console.log(bold(`  ✗ production profile: the server will REFUSE TO BOOT with this configuration`));
    if (!useDefaults && !(await yesno("Write it anyway (fix by re-running the wizard)?", false))) {
      console.log("  aborted — nothing written");
      rl.close();
      return;
    }
  }

  // 12 ── write
  if (existsSync(envPath)) {
    const bak = `${envPath}.bak`;
    copyFileSync(envPath, bak);
    console.log(dim(`\n  backed up existing file to ${bak}`));
  }
  writeFileSync(envPath, renderEnv(env, mode));
  chmodSync(envPath, 0o600);
  console.log(`\n${bold("✓ wrote")} ${envPath} ${dim("(mode 600)")}`);

  // 13 ── next steps
  section("Next steps");
  const steps: string[] = [];
  if (mode === "docker") {
    steps.push(`cd ${path.join(repoRoot, "deploy")}`);
    steps.push(prod
      ? "docker compose -f docker-compose.yml -f docker-compose.prod.yml up --build"
      : "docker compose up --build");
  } else {
    steps.push(`# terminal 1 — storage sidecar`);
    steps.push(`cd ${path.join(repoRoot, "packages/server/sidecar")} && python3 -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt`);
    steps.push(`set -a; source ${envPath}; set +a   # sidecar needs the storage creds too`);
    steps.push(`python delta_sidecar.py --port 8077 --base "${env.FHIRENGINE_DELTA_BASE}"`);
    steps.push(`# terminal 2 — server`);
    steps.push(`cd ${path.join(repoRoot, "packages/server")} && npm install`);
    steps.push(`set -a; source ${envPath}; set +a; npm run dev`);
  }
  if (wantUsCore) {
    steps.push(`# once the sidecar is up — install US Core profiles + terminology`);
    const igArg = igDirs[0] ?? "<path-to-hl7.fhir.us.core-package>";
    steps.push(`cd ${path.join(repoRoot, "packages/server")} && npx tsx scripts/fhirengine-terminology.ts install-ig "${igArg}" hl7.fhir.us.core --pull-vsac`);
    if (igDirs.length > 1) steps.push(`# (also found: ${igDirs.slice(1).join(", ")})`);
  }
  steps.push(`# smoke test`);
  steps.push(`curl -s ${env.FHIRENGINE_PUBLIC_URL}/metadata | head -c 200`);
  console.log(steps.map((s) => `  ${s}`).join("\n") + "\n");

  rl.close();
}

/** Suggest US Core package dirs from the standard FHIR package cache (~/.fhir/packages). */
function findUsCorePackages(): string[] {
  try {
    const cache = path.join(homedir(), ".fhir", "packages");
    return readdirSync(cache)
      .filter((d) => d.startsWith("hl7.fhir.us.core#"))
      .sort()
      .reverse()
      .map((d) => path.join(cache, d, "package"));
  } catch {
    return [];
  }
}

main().catch((e) => { console.error(String(e?.stack ?? e)); process.exitCode = 1; });
