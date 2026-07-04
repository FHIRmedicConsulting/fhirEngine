"""
Unit tests for the delta-rs sidecar (delta_sidecar.py) — the core data-integrity layer.
Covers: write+query roundtrip, atomic current-version (is_current) MERGE, upsert MERGE,
is_current backfill migration, retry semantics, and the infer-schema null-cast gotcha.

Run: pip install -r requirements.txt pytest && pytest tests/  (from the sidecar dir).
"""
import os

import delta_sidecar as ds


def bronze(rid, vid, is_current, **over):
    """A schema-complete Bronze row (BRONZE_SCHEMA) with overridable fields."""
    row = {
        "id": rid, "version_id": vid, "last_updated": f"2026-07-04T00:00:0{vid}Z",
        "body_json": over.get("body_json", f'{{"resourceType":"Patient","id":"{rid}"}}'),
        "identifier_index": [], "search_param_index": [], "ext_json": "",
        "deleted": False, "is_current": is_current, "_ingested_at": "", "_ingest_source": "test",
    }
    row.update({k: v for k, v in over.items() if k in row})
    return row


def q(path, sql):
    return ds.do_query({"sql": sql, "tables": {"t": path}})["rows"]


# --- write + query roundtrip -------------------------------------------------
def test_write_and_query_roundtrip(tmp_path):
    p = str(tmp_path / "patient")
    res = ds.do_write({"table_path": p, "rows": [bronze("a", 1, True), bronze("b", 1, True)], "schema": "bronze"})
    assert res["written"] == 2
    assert res["version"] == 0  # first commit
    rows = q(p, "SELECT id FROM t ORDER BY id")
    assert [r["id"] for r in rows] == ["a", "b"]


# --- atomic current-version (is_current) MERGE -------------------------------
def test_write_version_atomic_current(tmp_path):
    p = str(tmp_path / "patient")
    created = ds.do_write_version({"table_path": p, "row": bronze("a", 1, True), "prev_version_id": None})
    assert created["created"] is True

    ds.do_write_version({"table_path": p, "row": bronze("a", 2, True), "prev_version_id": 1})
    # exactly one current row, and it's v2; v1 is retained but demoted.
    current = q(p, "SELECT version_id FROM t WHERE is_current")
    assert [r["version_id"] for r in current] == [2]
    assert q(p, "SELECT count(*) AS n FROM t")[0]["n"] == 2


# --- upsert MERGE ------------------------------------------------------------
def test_merge_upsert(tmp_path):
    p = str(tmp_path / "cs")
    ds.do_merge({"table_path": p, "rows": [bronze("x", 1, True)], "key": "id"})
    ds.do_merge({"table_path": p, "rows": [bronze("x", 2, True, last_updated="later")], "key": "id"})
    rows = q(p, "SELECT id, version_id FROM t")
    assert len(rows) == 1 and rows[0]["version_id"] == 2  # updated in place, not duplicated


# --- is_current backfill migration -------------------------------------------
def test_migrate_is_current_backfills(tmp_path):
    p = str(tmp_path / "old")
    # A pre-is_current table (infer schema, no is_current column): two versions of id "a".
    ds.do_write({"table_path": p, "rows": [
        {"id": "a", "version_id": 1}, {"id": "a", "version_id": 2}, {"id": "b", "version_id": 1},
    ], "schema": "infer"})
    out = ds.do_migrate_is_current({"table_path": p})
    assert out["migrated"] is True
    cur = q(p, "SELECT id, version_id FROM t WHERE is_current ORDER BY id")
    assert [(r["id"], r["version_id"]) for r in cur] == [("a", 2), ("b", 1)]  # max version per id
    # idempotent: already has the column now
    assert ds.do_migrate_is_current({"table_path": p}).get("already") is True


# --- retry semantics ---------------------------------------------------------
def test_with_retry_retries_conflict_then_succeeds():
    calls = {"n": 0}
    def flaky():
        calls["n"] += 1
        if calls["n"] < 3:
            raise Exception("Transaction failed: conflict with concurrent writer")
        return "ok"
    assert ds._with_retry(flaky, attempts=5) == "ok"
    assert calls["n"] == 3


def test_with_retry_propagates_non_conflict_immediately():
    calls = {"n": 0}
    def bad():
        calls["n"] += 1
        raise Exception("Cannot cast Utf8 to Null")  # schema/cast error — never retried
    try:
        ds._with_retry(bad, attempts=5)
        assert False, "should have raised"
    except Exception as e:
        assert "cast" in str(e).lower()
    assert calls["n"] == 1  # failed fast, no retry


# --- infer-schema null-cast gotcha (write "" not null for optional strings) --
def test_infer_schema_empty_string_roundtrips(tmp_path):
    p = str(tmp_path / "audit")
    # First batch uses "" (not None) for the optional string col — keeps it Utf8, not Null,
    # so the SECOND append with a real value does not hit "Cannot cast Utf8 to Null".
    ds.do_write({"table_path": p, "rows": [{"id": "1", "display": ""}], "schema": "infer"})
    ds.do_write({"table_path": p, "rows": [{"id": "2", "display": "value"}], "schema": "infer"})
    rows = q(p, "SELECT id, display FROM t ORDER BY id")
    assert [r["display"] for r in rows] == ["", "value"]
