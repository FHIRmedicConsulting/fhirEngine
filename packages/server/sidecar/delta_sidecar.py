"""
fhirEngine Delta sidecar — the single-engine (delta-rs / DataFusion) write+read service
the TypeScript FHIR server calls (ADR-0022 Amendment 1). No Spark, no Databricks.

Long-lived HTTP service (stdlib only — no FastAPI dependency):
  GET  /health                                   -> {"ok": true}
  POST /write  {table_path, rows, mode}          -> delta-rs append   (Bronze landing)
  POST /merge  {table_path, rows, key}           -> delta-rs MERGE upsert (current-version)
  POST /query  {sql, tables:{name:path}}         -> DataFusion (delta-rs QueryBuilder)

Single-writer per table is the invariant (ADR-0026): run one sidecar.

Run: python delta_sidecar.py [--port 8077] [--base <delta-root>]
Deps: see requirements.txt (deltalake, pyarrow).
"""
import argparse
import hmac
import json
import os
import re
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Request-body ceiling (the sidecar is unauthenticated on the private network; don't let a
# caller-supplied Content-Length OOM the process). Generous — Bronze writes can be large batches.
_MAX_BODY_BYTES = int(os.environ.get("FHIRENGINE_SIDECAR_MAX_BODY_BYTES", 512 * 1024 * 1024))

# Optional shared-secret gate. When FHIRENGINE_SIDECAR_TOKEN is set (recommended in any
# multi-container/networked deploy — the sidecar exposes a full-PHI, destructive API with no
# other auth), every non-/health request must present it in X-Sidecar-Token. Unset (dev/tests)
# → no check, preserving the loopback trust model.
_SIDECAR_TOKEN = os.environ.get("FHIRENGINE_SIDECAR_TOKEN", "")

import pyarrow as pa
from deltalake import DeltaTable, QueryBuilder, write_deltalake
from deltalake.exceptions import CommitFailedError

_COMMIT_ATTEMPTS = 5


def _with_retry(fn, attempts=_COMMIT_ATTEMPTS):
    """Retry a Delta commit on transient concurrent-writer conflicts (Priority #3). delta-rs is
    single-writer per table; in-process writes are already serialized by the TS warehouse, but
    cross-process commits can still collide. Backs off exponentially. Non-conflict errors (schema
    mismatch, cast, etc.) propagate immediately — they would never succeed on retry."""
    delay = 0.05
    for i in range(attempts):
        try:
            return fn()
        except CommitFailedError:
            if i == attempts - 1:
                raise
        except Exception as e:  # noqa: BLE001 — only RETRY on conflict-shaped messages
            msg = str(e).lower()
            if i == attempts - 1 or not any(k in msg for k in ("conflict", "concurrent", "version already exists")):
                raise
        time.sleep(delay)
        delay = min(delay * 2, 1.0)

# Raw Bronze row schema (Layering B: Bronze = raw JSON landing, NOT flattened).
# Fixed shape per ADR-0010 / ADR-0022; flattening happens Bronze->Silver later.
IDENT = pa.struct([("system", pa.string()), ("value", pa.string()), ("typeCode", pa.string())])
# Search index: one entry per (search param code, value) extracted at write time via the
# param's FHIRPath expression. `system` is set for token codings/identifiers, else "".
SPARAM = pa.struct([("code", pa.string()), ("system", pa.string()), ("value", pa.string())])
BRONZE_SCHEMA = pa.schema([
    ("id", pa.string()),
    ("version_id", pa.int64()),
    ("last_updated", pa.string()),
    ("body_json", pa.string()),
    ("identifier_index", pa.list_(IDENT)),
    ("search_param_index", pa.list_(SPARAM)),
    ("ext_json", pa.string()),
    ("deleted", pa.bool_()),
    ("is_current", pa.bool_()),  # current-version flag: search filters WHERE is_current
    ("_ingested_at", pa.string()),
    ("_ingest_source", pa.string()),
])


def _table(rows):
    return pa.Table.from_pylist(rows, schema=BRONZE_SCHEMA)


def _blank_bronze_row():
    """A schema-complete Bronze row of defaults — used as the match-only demotion row in
    /write-version (only its id/version_id/is_current are consumed by the MERGE)."""
    return {"id": "", "version_id": 0, "last_updated": "", "body_json": "",
            "identifier_index": [], "search_param_index": [], "ext_json": "",
            "deleted": False, "is_current": False, "_ingested_at": "", "_ingest_source": ""}


def _to_table(rows, schema):
    """schema="bronze" → fixed BRONZE_SCHEMA (Bronze/Gold). "infer" → derive from the
    rows (Silver flattened columns vary per resource type)."""
    if schema == "infer":
        return pa.Table.from_pylist(rows)
    return _table(rows)


def _is_object_store(path):
    """s3:// gs:// az:// abfs:// etc. — delta-rs handles these natively (no mkdir)."""
    return "://" in path and not path.startswith("file://")


def _confine(path):
    """Reject the concrete path-abuse vectors on a caller-supplied `table_path`.

    `table_path` comes from the (trusted) server, but the sidecar has no transport auth by
    default, so a direct caller on the network could try to exfil or traverse. This blocks:
      - object-store exfil: writing to an object store when the base is local (would use the
        server's cloud creds against an attacker bucket), or crossing to a different
        object-store base;
      - `..` path traversal out of the store tree.
    (The strongest confinement — every path under one base — needs the server and sidecar to
    share a base; that holds in the compose deploy but not the multi-base test harness, so the
    authoritative gate for a hostile caller is the shared-secret token below, not this.)"""
    if _is_object_store(_BASE):
        if path != _BASE and not path.startswith(_BASE.rstrip("/") + "/"):
            raise ValueError("table_path outside the configured object-store base")
        return path
    if _is_object_store(path):
        raise ValueError("object-store table_path not allowed with a local base")
    if ".." in path.replace("\\", "/").split("/"):
        raise ValueError("table_path must not contain '..'")
    return path


# Base Delta root (set in main) — used by path confinement + table listing.
_BASE = "."


def _creation_config(path):
    """Table properties applied at CREATION only. Bronze + Silver get Change Data Feed
    (ADR-0026) so EXTERNAL promoters (Dagster / Databricks / the promote CLI) can read
    incremental changes via load_cdf — the flag can't usefully be retrofitted (CDF only
    covers versions after enablement). None for existing tables / other tiers."""
    if "/bronze/" not in path and "/silver/" not in path:
        return None
    try:
        DeltaTable(path)
        return None  # exists — configuration is creation-time only
    except Exception:
        return {"delta.enableChangeDataFeed": "true"}


def do_write(req):
    path = _confine(req["table_path"])
    rows = req["rows"]
    mode = req.get("mode", "append")
    schema = req.get("schema", "bronze")
    # Validation lives in the TS ValidationSupportChain now (ADR-0028); the sidecar is a
    # pure writer — no structural/profile validation here (was dead: no caller sent validate).
    written = 0
    if rows:
        if not _is_object_store(path):
            os.makedirs(os.path.dirname(path), exist_ok=True)
        cfg = _creation_config(path)
        kwargs = {"configuration": cfg} if cfg else {}
        if mode == "overwrite":
            # Full-rebuild semantics (ADR-0026 backstop): replace the SCHEMA too. Inferred
            # schemas drift between batches (e.g. an all-empty list column infers Null, a
            # populated one infers List(Struct)) — without this, re-promotion fails to cast.
            kwargs["schema_mode"] = "overwrite"
        _with_retry(lambda: write_deltalake(path, _to_table(rows, schema), mode=mode, **kwargs))
        written = len(rows)

    return {
        "written": written,
        "version": DeltaTable(path).version() if written else None,
    }


def do_merge(req):
    path = _confine(req["table_path"])
    rows = req["rows"]
    key = req.get("key", "id")
    if not re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", key):  # key is a raw SQL identifier in the predicate
        raise ValueError("invalid merge key")
    schema = req.get("schema", "bronze")
    if not _is_object_store(path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
    if not os.path.exists(path):
        _with_retry(lambda: write_deltalake(path, _to_table(rows, schema)))
        return {"version": DeltaTable(path).version(), "created": True}

    def _commit():
        DeltaTable(path).merge(  # re-read latest snapshot each attempt
            source=_to_table(rows, schema),
            predicate=f"target.{key} = source.{key}",
            source_alias="source",
            target_alias="target",
        ).when_matched_update_all().when_not_matched_insert_all().execute()
    _with_retry(_commit)
    return {"version": DeltaTable(path).version()}


def do_write_version(req):
    """Atomic current-version write: insert the new version (is_current=true) AND demote the
    prior version (is_current=false) in ONE Delta commit, so readers (snapshot-isolated) never
    see two current rows or zero current rows for an id. `prev_version_id` is the version being
    demoted (null on first create). Bronze schema only."""
    path = _confine(req["table_path"])
    row = req["row"]
    prev = req.get("prev_version_id")
    if not _is_object_store(path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
    if not os.path.exists(path):
        cfg = _creation_config(path)
        kwargs = {"configuration": cfg} if cfg else {}
        _with_retry(lambda: write_deltalake(path, _table([row]), **kwargs))  # first version of the first id
        return {"version": DeltaTable(path).version(), "created": True}
    src = [row]
    if prev is not None:
        src.append({**_blank_bronze_row(), "id": row["id"], "version_id": prev, "is_current": False})

    def _commit():
        res = DeltaTable(path).merge(  # re-read table state each attempt (latest snapshot for the merge)
            source=_table(src),
            predicate="target.id = source.id AND target.version_id = source.version_id",
            source_alias="source", target_alias="target",
        ).when_matched_update(
            # Demote ONLY the currently-current prior version (source.is_current=false rows).
            # Scoping this to the demote row means a NEW-version row that collides with an
            # existing one (cross-process race, ADR-0026) has no matching clause and is not
            # inserted → detectable below, instead of silently overwriting is_current.
            predicate="source.is_current = false AND target.is_current = true",
            updates={"is_current": "source.is_current"},
        ).when_not_matched_insert_all(predicate="source.is_current = true"  # insert only the new version
        ).execute()
        # The new version MUST have landed. If another writer already committed this version_id
        # (two server instances both computed N+1 off a stale read), it won't insert — raise
        # rather than return success on a dropped write, so the caller re-reads and re-versions.
        inserted = res.get("num_target_rows_inserted") if isinstance(res, dict) else None
        if inserted is not None and int(inserted) < 1:
            raise CommitFailedError(f"version conflict: {row['id']}@{row['version_id']} already exists")
    _with_retry(_commit)
    return {"version": DeltaTable(path).version()}


def do_query(req):
    sql = req["sql"]
    tables = req.get("tables", {})
    qb = QueryBuilder()
    for name, path in tables.items():
        # Skip registered-but-not-yet-provisioned tables (e.g. a terminology/conformance
        # store referenced before it's loaded). Otherwise one missing Delta path would
        # break every unrelated query. A query that ACTUALLY references a skipped table
        # still gets a normal "table not found" from DataFusion.
        try:
            dt = DeltaTable(_confine(path))
        except Exception:
            continue
        qb = qb.register(name, dt)
    result = qb.execute(sql).read_all()
    # delta-rs returns arro3 Tables; bridge to pyarrow via the Arrow C-stream interface.
    return {"rows": pa.table(result).to_pylist()}


def do_migrate_is_current(req):
    """Backfill the `is_current` column on a pre-is_current Bronze table (schema migration).
    Sets is_current = (version_id is the max for that id). One-time full rewrite (overwrite).
    Idempotent: no-op if the column already exists or the table is missing."""
    path = req["table_path"]
    if _is_object_store(path) or not os.path.exists(path):
        return {"migrated": False, "missing": not _is_object_store(path)}
    dt = DeltaTable(path)
    if "is_current" in {f.name for f in dt.schema().fields}:
        return {"migrated": False, "already": True}
    result = QueryBuilder().register("t", dt).execute(
        "SELECT *, (version_id = max(version_id) OVER (PARTITION BY id)) AS is_current FROM t"
    ).read_all()
    tbl = pa.table(result)
    _with_retry(lambda: write_deltalake(path, tbl, mode="overwrite", schema_mode="overwrite"))
    return {"migrated": True, "rows": tbl.num_rows}


def _zorder_columns(dt, zorder):
    """Resolve Z-order columns: explicit list, False = none (plain compact), or auto
    (cluster by `id` when the table has one — point reads / _id / current-version-by-id
    then skip files via min/max stats). Tables without `id` (terminology) just compact."""
    if zorder is False:
        return None
    if isinstance(zorder, (list, tuple)) and len(zorder) > 0:
        return list(zorder)
    cols = {f.name for f in dt.schema().fields}
    return ["id"] if "id" in cols else None


def _optimize_table(path, vacuum=False, retention_hours=168, force=False, zorder=None):
    """Compact (+ optional Z-order cluster) one Delta table; optionally vacuum unreferenced
    files. Append-per-write makes many small files; compaction keeps scans fast and Z-order
    by `id` co-locates a resource's versions so id-keyed access skips files. Vacuum defaults
    to a SAFE 168h (7-day) retention, enforcement ON (preserves time-travel); `force` drops it."""
    dt = DeltaTable(path)
    before = len(dt.file_uris())
    zcols = _zorder_columns(dt, zorder)
    metrics = dt.optimize.z_order(zcols) if zcols else dt.optimize.compact()
    out = {"files_before": before, "zorder": zcols, "metrics": metrics}
    if vacuum:
        removed = dt.vacuum(retention_hours=retention_hours, dry_run=False,
                            enforce_retention_duration=not force)
        out["vacuumed_files"] = len(removed)
    out["files_after"] = len(DeltaTable(path).file_uris())
    return out


def do_optimize(req):
    """Compact (+ optional Z-order + vacuum) a single Delta table by path."""
    return _optimize_table(req["table_path"], vacuum=req.get("vacuum", False),
                           retention_hours=req.get("retention_hours", 168), force=req.get("force", False),
                           zorder=req.get("zorder"))


def _find_delta_tables(base):
    """Walk a local base for Delta tables (dirs containing a `_delta_log/`)."""
    tables = []
    for root, dirs, _files in os.walk(base):
        if "_delta_log" in dirs:
            tables.append(root)
            dirs[:] = [d for d in dirs if d != "_delta_log"]  # don't descend into the log
    return sorted(tables)


def _object_store_fs(base):
    """pyarrow filesystem + root path for an object-store base. Builds an explicit
    S3FileSystem when AWS_ENDPOINT_URL is set (MinIO/R2) — from_uri ignores the env override."""
    from pyarrow import fs as pafs
    endpoint = os.environ.get("AWS_ENDPOINT_URL") or os.environ.get("AWS_ENDPOINT")
    if base.startswith("s3://") and endpoint:
        f = pafs.S3FileSystem(
            access_key=os.environ.get("AWS_ACCESS_KEY_ID"),
            secret_key=os.environ.get("AWS_SECRET_ACCESS_KEY"),
            region=os.environ.get("AWS_REGION") or "us-east-1",
            endpoint_override=endpoint,
            scheme="http" if endpoint.startswith("http://") else "https",
        )
        return f, base[len("s3://"):]
    f, path = pafs.FileSystem.from_uri(base)
    return f, path


def _find_delta_tables_object(base):
    """Enumerate Delta tables under an object-store base (any key path holding `_delta_log`)."""
    from pyarrow import fs as pafs
    f, root = _object_store_fs(base)
    scheme = base.split("://", 1)[0]
    try:
        infos = f.get_file_info(pafs.FileSelector(root.rstrip("/"), recursive=True))
    except FileNotFoundError:
        return []
    tables = {fi.path.split("/_delta_log", 1)[0] for fi in infos if "/_delta_log" in fi.path}
    return sorted(f"{scheme}://{t}" for t in tables)


def _find_tables_any(base):
    return _find_delta_tables_object(base) if _is_object_store(base) else _find_delta_tables(base)


def _rel(base, path):
    if _is_object_store(base):
        return path[len(base):].lstrip("/") if path.startswith(base) else path
    return os.path.relpath(path, base)


def do_list_tables(req):
    """Enumerate Delta tables under the base (local walk OR object-store listing) —
    restart-registration/startup discovery on any storage backend."""
    base = req.get("base") or _BASE
    paths = _find_tables_any(base)
    return {"base": base, "tables": [{"path": p, "rel": _rel(base, p)} for p in paths]}


def do_optimize_all(req):
    """Compact (+ Z-order cluster by `id` where present + optional vacuum) EVERY Delta table
    under the store base — covers Bronze resource tables, audit, terminology, conformance,
    dead-letter, pending. Local FS and object stores (enumerated via pyarrow.fs)."""
    base = req.get("base") or _BASE
    vacuum, retention_hours, force = req.get("vacuum", False), req.get("retention_hours", 168), req.get("force", False)
    zorder = req.get("zorder")
    results = {}
    for path in _find_tables_any(base):
        rel = _rel(base, path)
        try:
            results[rel] = _optimize_table(path, vacuum=vacuum, retention_hours=retention_hours, force=force, zorder=zorder)
        except Exception as e:
            results[rel] = {"error": f"{type(e).__name__}: {str(e)[:200]}"}
    return {"base": base, "tables_optimized": len(results), "results": results}


def do_delete(req):
    """Delete rows matching a SQL predicate (idempotent replace, e.g. one value-set's
    expansion before re-loading). No predicate → delete all rows. Skips a missing table."""
    path = _confine(req["table_path"])
    try:
        dt = DeltaTable(path)
    except Exception:
        return {"deleted": 0, "missing": True}
    predicate = req.get("predicate")
    res = _with_retry(lambda: DeltaTable(path).delete(predicate) if predicate else DeltaTable(path).delete())
    return {"deleted": getattr(res, "num_deleted_rows", None) if hasattr(res, "num_deleted_rows") else str(res)}


def do_cdf(req):
    """Change Data Feed since a version: distinct changed `id`s + the table's current version
    (ADR-0026 incremental promotion). Bronze/Silver tables are created with
    delta.enableChangeDataFeed=true; a table predating that (or a starting_version older than
    the retained feed) raises — callers treat any error as "fall back to full rebuild".
    Omitting starting_version returns just the current version (watermark bootstrap)."""
    path = _confine(req["table_path"])
    dt = DeltaTable(path)
    version = dt.version()
    sv = req.get("starting_version")
    if sv is None or int(sv) > version:
        return {"version": version, "ids": []}
    ids = set()
    reader = dt.load_cdf(starting_version=int(sv))
    for batch in reader:
        if "id" in batch.schema.names:
            ids.update(v for v in batch.column("id").to_pylist() if v is not None)
    return {"version": version, "ids": sorted(ids)}


ROUTES = {"/write": do_write, "/write-version": do_write_version, "/merge": do_merge, "/query": do_query,
 "/migrate-is-current": do_migrate_is_current,
          "/optimize": do_optimize, "/optimize-all": do_optimize_all, "/delete": do_delete,
          "/list-tables": do_list_tables, "/cdf": do_cdf}


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._send(200, {"ok": True})
        else:
            self._send(404, {"error": "not found"})

    def _authed(self):
        if not _SIDECAR_TOKEN:
            return True  # no token configured → trust the network (dev / loopback)
        return hmac.compare_digest(self.headers.get("X-Sidecar-Token", ""), _SIDECAR_TOKEN)

    def do_POST(self):
        handler = ROUTES.get(self.path)
        if not handler:
            self._send(404, {"error": "not found"})
            return
        if not self._authed():
            self._send(401, {"error": "Unauthorized"})
            return
        try:
            n = int(self.headers.get("Content-Length", 0))
            if n > _MAX_BODY_BYTES:  # reject before reading — no auth here, don't let a caller OOM us
                self._send(413, {"error": "PayloadTooLarge", "detail": f"body exceeds {_MAX_BODY_BYTES} bytes"})
                return
            req = json.loads(self.rfile.read(n) or b"{}")
            self._send(200, handler(req))
        except Exception as e:  # surface the error to the TS caller
            self._send(500, {"error": type(e).__name__, "detail": str(e)[:500]})

    def log_message(self, *_):  # quiet
        pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=int(os.environ.get("FHIRENGINE_DELTA_SIDECAR_PORT", 8077)))
    ap.add_argument("--base", default=os.environ.get("FHIRENGINE_DELTA_BASE", "./delta"))
    # Default loopback for local-dev safety; containers set FHIRENGINE_DELTA_SIDECAR_HOST=0.0.0.0.
    ap.add_argument("--host", default=os.environ.get("FHIRENGINE_DELTA_SIDECAR_HOST", "127.0.0.1"))
    args = ap.parse_args()
    global _BASE
    _BASE = args.base
    if not _is_object_store(args.base):
        os.makedirs(args.base, exist_ok=True)
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"fhirengine delta sidecar on http://{args.host}:{args.port} (base={args.base})", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
