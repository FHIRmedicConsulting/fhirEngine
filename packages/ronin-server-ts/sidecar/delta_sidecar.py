"""
Ronin Delta sidecar — the single-engine (delta-rs / DataFusion) write+read service
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
import json
import os
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pyarrow as pa
from deltalake import DeltaTable, QueryBuilder, write_deltalake
from deltalake.exceptions import CommitFailedError
from fhir.resources import get_fhir_model_class  # R4 Core structural validation (pydantic)

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


# --- Validation (PRIOR to Bronze landing; R4 Core focus, profile-extensible) ---

# Dead-letter / failed-message queue schema (a queryable Delta table).
DEADLETTER_SCHEMA = pa.schema([
    ("id", pa.string()),
    ("resourceType", pa.string()),
    ("error", pa.string()),
    ("body_json", pa.string()),
    ("failed_at", pa.string()),
])

# Facility for MULTIPLE profile validation (Chad): code-registered validators
# (profile-URL → callable raising on violation), PLUS dynamically-derived validators
# loaded from INSTALLED profile snapshots in the conformance store (see below).
PROFILE_VALIDATORS = {}

# Base Delta root (set in main) — used to read installed profiles + terminology.
_BASE = "."
# Cache of required top-level elements per installed profile URL (first-cut profile
# validation). Invalidated on restart; re-install + restart picks up changes.
_profile_req_cache = {}


def _profile_required(url):
    """Required top-level elements (min>=1) for an INSTALLED profile, from its snapshot
    in the conformance store. [] if the profile isn't installed (not enforced)."""
    if url in _profile_req_cache:
        return _profile_req_cache[url]
    req = []
    try:
        path = os.path.join(_BASE, "conformance", "structuredefinition")
        if _is_object_store(path) or os.path.exists(path):
            qb = QueryBuilder().register("sd", DeltaTable(path))
            esc = url.replace("'", "''")
            rows = pa.table(qb.execute(f"SELECT json FROM sd WHERE url = '{esc}' LIMIT 1").read_all()).to_pylist()
            if rows:
                sd = json.loads(rows[0]["json"])
                rtype = sd.get("type")
                for e in sd.get("snapshot", {}).get("element", []):
                    segs = (e.get("path") or "").split(".")
                    if len(segs) == 2 and segs[0] == rtype and (e.get("min") or 0) >= 1:
                        req.append(segs[1])
    except Exception:
        req = []
    _profile_req_cache[url] = req
    return req


def _validate_resource(body):
    """Raise on invalid. (1) R4 Core base structural validation (always);
    (2) for each claimed meta.profile: required-element enforcement from the installed
    profile snapshot + any code-registered validator."""
    get_fhir_model_class(body.get("resourceType")).model_validate(body)
    for prof in ((body.get("meta") or {}).get("profile") or []):
        for el in _profile_required(prof):
            v = body.get(el)
            if v is None or v == [] or v == "":
                raise ValueError(f"profile {prof} requires element '{el}'")
        fn = PROFILE_VALIDATORS.get(prof)
        if fn:
            fn(body)


def _validate_split(rows):
    """Partition Bronze rows into (valid, dead-lettered) by validating body_json."""
    good, bad = [], []
    for r in rows:
        rt, body = None, None
        try:
            body = json.loads(r.get("body_json") or "{}")
            rt = body.get("resourceType")
            _validate_resource(body)
            good.append(r)
        except Exception as e:
            bad.append({
                "id": r.get("id"),
                "resourceType": rt,
                "error": str(e)[:1500],
                "body_json": r.get("body_json"),
                "failed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            })
    return good, bad


def _deadletter(path, bad):
    if not path or not bad:
        return 0
    if not _is_object_store(path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
    write_deltalake(path, pa.Table.from_pylist(bad, schema=DEADLETTER_SCHEMA), mode="append")
    return len(bad)


def do_write(req):
    path = req["table_path"]
    rows = req["rows"]
    mode = req.get("mode", "append")
    schema = req.get("schema", "bronze")
    # Validation gates Bronze ingestion ONLY (validate=true); promotion writes
    # (Silver/Gold) pass validate=false — they're already-governed data.
    good, bad = (_validate_split(rows) if req.get("validate") else (rows, []))

    written = 0
    if good:
        if not _is_object_store(path):
            os.makedirs(os.path.dirname(path), exist_ok=True)
        _with_retry(lambda: write_deltalake(path, _to_table(good, schema), mode=mode))
        written = len(good)

    deadlettered = _deadletter(req.get("deadletter_path"), bad)
    return {
        "written": written,
        "deadlettered": deadlettered,
        "errors": [{"id": b["id"], "resourceType": b["resourceType"], "error": b["error"]} for b in bad][:20],
        "version": DeltaTable(path).version() if written else None,
    }


def do_merge(req):
    path = req["table_path"]
    rows = req["rows"]
    key = req.get("key", "id")
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
    path = req["table_path"]
    row = req["row"]
    prev = req.get("prev_version_id")
    if not _is_object_store(path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
    if not os.path.exists(path):
        _with_retry(lambda: write_deltalake(path, _table([row])))  # first version of the first id
        return {"version": DeltaTable(path).version(), "created": True}
    src = [row]
    if prev is not None:
        src.append({**_blank_bronze_row(), "id": row["id"], "version_id": prev, "is_current": False})

    def _commit():
        DeltaTable(path).merge(  # re-read table state each attempt (latest snapshot for the merge)
            source=_table(src),
            predicate="target.id = source.id AND target.version_id = source.version_id",
            source_alias="source", target_alias="target",
        ).when_matched_update(updates={"is_current": "source.is_current"}  # demote the prior version
        ).when_not_matched_insert_all(predicate="source.is_current = true"  # insert only the new version
        ).execute()
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
            dt = DeltaTable(path)
        except Exception:
            continue
        qb = qb.register(name, dt)
    result = qb.execute(sql).read_all()
    # delta-rs returns arro3 Tables; bridge to pyarrow via the Arrow C-stream interface.
    return {"rows": pa.table(result).to_pylist()}


def do_validate(req):
    """Validate-only (no write) — for benchmarking the Python validation path."""
    results = []
    for r in req.get("resources", []):
        body = r if isinstance(r, dict) and "resourceType" in r else json.loads((r or {}).get("body_json", "{}"))
        try:
            _validate_resource(body)
            results.append({"valid": True})
        except Exception as e:
            results.append({"valid": False, "error": str(e)[:300]})
    return {"results": results}


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


def do_optimize_all(req):
    """Compact (+ Z-order cluster by `id` where present + optional vacuum) EVERY Delta table
    under the store base — covers Bronze resource tables, audit, terminology, conformance,
    dead-letter, pending. Local-FS bases only (object-store enumeration is a follow-up)."""
    base = req.get("base") or _BASE
    if _is_object_store(base):
        raise RuntimeError(f"optimize-all requires a local base; got object store '{base}' (per-table /optimize instead)")
    vacuum, retention_hours, force = req.get("vacuum", False), req.get("retention_hours", 168), req.get("force", False)
    zorder = req.get("zorder")
    results = {}
    for path in _find_delta_tables(base):
        rel = os.path.relpath(path, base)
        try:
            results[rel] = _optimize_table(path, vacuum=vacuum, retention_hours=retention_hours, force=force, zorder=zorder)
        except Exception as e:
            results[rel] = {"error": f"{type(e).__name__}: {str(e)[:200]}"}
    return {"base": base, "tables_optimized": len(results), "results": results}


def do_delete(req):
    """Delete rows matching a SQL predicate (idempotent replace, e.g. one value-set's
    expansion before re-loading). No predicate → delete all rows. Skips a missing table."""
    path = req["table_path"]
    try:
        dt = DeltaTable(path)
    except Exception:
        return {"deleted": 0, "missing": True}
    predicate = req.get("predicate")
    res = _with_retry(lambda: DeltaTable(path).delete(predicate) if predicate else DeltaTable(path).delete())
    return {"deleted": getattr(res, "num_deleted_rows", None) if hasattr(res, "num_deleted_rows") else str(res)}


ROUTES = {"/write": do_write, "/write-version": do_write_version, "/merge": do_merge, "/query": do_query,
          "/validate": do_validate, "/optimize": do_optimize, "/optimize-all": do_optimize_all,
          "/delete": do_delete}


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

    def do_POST(self):
        handler = ROUTES.get(self.path)
        if not handler:
            self._send(404, {"error": "not found"})
            return
        try:
            n = int(self.headers.get("Content-Length", 0))
            req = json.loads(self.rfile.read(n) or b"{}")
            self._send(200, handler(req))
        except Exception as e:  # surface the error to the TS caller
            self._send(500, {"error": type(e).__name__, "detail": str(e)[:500]})

    def log_message(self, *_):  # quiet
        pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=int(os.environ.get("RONIN_DELTA_SIDECAR_PORT", 8077)))
    ap.add_argument("--base", default=os.environ.get("RONIN_DELTA_BASE", "./delta"))
    # Default loopback for local-dev safety; containers set RONIN_DELTA_SIDECAR_HOST=0.0.0.0.
    ap.add_argument("--host", default=os.environ.get("RONIN_DELTA_SIDECAR_HOST", "127.0.0.1"))
    args = ap.parse_args()
    global _BASE
    _BASE = args.base
    if not _is_object_store(args.base):
        os.makedirs(args.base, exist_ok=True)
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"ronin delta sidecar on http://{args.host}:{args.port} (base={args.base})", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
