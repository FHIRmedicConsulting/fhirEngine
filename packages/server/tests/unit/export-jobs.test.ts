import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createExportJob, readManifest, appendNdjson, recordOutput, recordError, finishJob,
  openTypeFile, deleteExportJob, typeFilePath,
} from "../../src/lib/export-jobs.js";

let dir: string;
let savedEnv: string | undefined;

beforeAll(() => {
  savedEnv = process.env.FHIRENGINE_EXPORT_DIR;
  dir = mkdtempSync(join(tmpdir(), "fhirengine-export-jobs-"));
  process.env.FHIRENGINE_EXPORT_DIR = dir;
});
afterAll(() => {
  if (savedEnv === undefined) delete process.env.FHIRENGINE_EXPORT_DIR;
  else process.env.FHIRENGINE_EXPORT_DIR = savedEnv;
  rmSync(dir, { recursive: true, force: true });
});

describe("export job store", () => {
  it("createExportJob mints a UUID job that starts in-progress with an empty manifest", async () => {
    const id = await createExportJob("/$export?_type=Patient", "2024-06-01T00:00:00Z", false);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const m = await readManifest(id);
    expect(m).toEqual({
      id, status: "in-progress", transactionTime: "2024-06-01T00:00:00Z",
      request: "/$export?_type=Patient", requiresAccessToken: false, output: [], error: [],
    });
  });

  it("walks the state machine: append → record output → complete, and survives a re-read", async () => {
    const id = await createExportJob("/$export", "2024-06-01T00:00:00Z", true);
    await appendNdjson(id, "Patient", '{"resourceType":"Patient","id":"p1"}\n');
    await appendNdjson(id, "Patient", '{"resourceType":"Patient","id":"p2"}\n');
    await recordOutput(id, "Patient", "https://fhir.example/_export-file/x/Patient", 2);
    await finishJob(id, "complete");

    const m = (await readManifest(id))!; // disk-backed: a fresh read IS the restart path
    expect(m.status).toBe("complete");
    expect(m.requiresAccessToken).toBe(true);
    expect(m.output).toEqual([{ type: "Patient", url: "https://fhir.example/_export-file/x/Patient", count: 2 }]);

    const stream = openTypeFile(id, "Patient")!;
    const lines = (await new Response(stream).text()).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((r) => r.id)).toEqual(["p1", "p2"]);
  });

  it("a failed job carries its message and records per-type errors", async () => {
    const id = await createExportJob("/$export", "2024-06-01T00:00:00Z", false);
    await recordError(id, "Observation", "https://fhir.example/_export-file/x/Observation");
    await finishJob(id, "failed", "disk full");
    const m = (await readManifest(id))!;
    expect(m.status).toBe("failed");
    expect(m.message).toBe("disk full");
    expect(m.error).toEqual([{ type: "Observation", url: "https://fhir.example/_export-file/x/Observation" }]);
  });

  it("manifest writes are atomic: no .tmp file is ever left behind", async () => {
    const id = await createExportJob("/$export", "2024-06-01T00:00:00Z", false);
    await recordOutput(id, "Patient", "u", 1);
    await finishJob(id, "complete");
    expect(readdirSync(join(dir, id)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("reads of unknown jobs return null / no-op instead of throwing (stuck-job safety)", async () => {
    expect(await readManifest("00000000-0000-7000-8000-000000000000")).toBeNull();
    await recordOutput("00000000-0000-7000-8000-000000000000", "Patient", "u", 1); // silently ignored
    await finishJob("00000000-0000-7000-8000-000000000000", "complete"); // silently ignored
    expect(openTypeFile("00000000-0000-7000-8000-000000000000", "Patient")).toBeNull();
  });

  it("openTypeFile returns null for a type that was never exported on a real job", async () => {
    const id = await createExportJob("/$export", "2024-06-01T00:00:00Z", false);
    expect(openTypeFile(id, "Observation")).toBeNull();
  });

  it("deleteExportJob removes the job dir (files + manifest); false when already gone", async () => {
    const id = await createExportJob("/$export", "2024-06-01T00:00:00Z", false);
    await appendNdjson(id, "Patient", "{}\n");
    expect(existsSync(typeFilePath(id, "Patient"))).toBe(true);

    expect(await deleteExportJob(id)).toBe(true);
    expect(existsSync(join(dir, id))).toBe(false);
    expect(await readManifest(id)).toBeNull();
    expect(await deleteExportJob(id)).toBe(false);
  });
});
