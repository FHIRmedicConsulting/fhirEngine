/**
 * Bulk Data ($export) job store — disk-backed + async (replaces the in-memory dev stub).
 *
 * Each job is a directory under `RONIN_EXPORT_DIR` (default ./.ronin-export): `manifest.json`
 * (the FHIR Bulk Data completion manifest, incrementally updated) + one `<Type>.ndjson` per
 * exported resource type (streamed to disk, not held in memory). Completed jobs survive a
 * restart (served from disk); an in-flight job interrupted by a restart reads back as failed.
 * Object-store output is a follow-up (local FS only).
 */
import { mkdir, writeFile, readFile, appendFile, rm } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { Readable } from "node:stream";
import { join } from "node:path";
import { uuidv7 } from "./uuid-v7.js";

const root = (): string => process.env.RONIN_EXPORT_DIR ?? "./.ronin-export";
const jobDir = (id: string): string => join(root(), id);
const manifestPath = (id: string): string => join(jobDir(id), "manifest.json");
export const typeFilePath = (id: string, type: string): string => join(jobDir(id), `${type}.ndjson`);

export interface ExportManifest {
  id: string;
  status: "in-progress" | "complete" | "failed";
  transactionTime: string;
  request: string;
  requiresAccessToken: boolean;
  output: Array<{ type: string; url: string; count: number }>;
  error: Array<{ type: string; url: string }>;
  message?: string;
}

export async function createExportJob(request: string, transactionTime: string, requiresAccessToken: boolean): Promise<string> {
  const id = uuidv7();
  await mkdir(jobDir(id), { recursive: true });
  const m: ExportManifest = { id, status: "in-progress", transactionTime, request, requiresAccessToken, output: [], error: [] };
  await writeFile(manifestPath(id), JSON.stringify(m));
  return id;
}

export async function readManifest(id: string): Promise<ExportManifest | null> {
  try { return JSON.parse(await readFile(manifestPath(id), "utf8")) as ExportManifest; } catch { return null; }
}
async function writeManifest(m: ExportManifest): Promise<void> { await writeFile(manifestPath(m.id), JSON.stringify(m)); }

/** Append NDJSON lines for a type (streamed — the runner pages through results). */
export async function appendNdjson(id: string, type: string, lines: string): Promise<void> {
  await appendFile(typeFilePath(id, type), lines);
}

export async function recordOutput(id: string, type: string, url: string, count: number): Promise<void> {
  const m = await readManifest(id); if (!m) return;
  m.output.push({ type, url, count }); await writeManifest(m);
}
export async function recordError(id: string, type: string, url: string): Promise<void> {
  const m = await readManifest(id); if (!m) return;
  m.error.push({ type, url }); await writeManifest(m);
}
export async function finishJob(id: string, status: "complete" | "failed", message?: string): Promise<void> {
  const m = await readManifest(id); if (!m) return;
  m.status = status; if (message) m.message = message; await writeManifest(m);
}

/** Stream a completed type file for download (application/fhir+ndjson). null → not found. */
export function openTypeFile(id: string, type: string): ReadableStream | null {
  const p = typeFilePath(id, type);
  return existsSync(p) ? (Readable.toWeb(createReadStream(p)) as unknown as ReadableStream) : null;
}

export async function deleteExportJob(id: string): Promise<boolean> {
  if (!existsSync(jobDir(id))) return false;
  await rm(jobDir(id), { recursive: true, force: true });
  return true;
}
