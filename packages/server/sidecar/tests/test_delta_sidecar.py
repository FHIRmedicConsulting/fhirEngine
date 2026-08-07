"""
Unit tests for the delta-rs sidecar (delta_sidecar.py) — the core data-integrity layer.
Covers: write+query roundtrip, atomic current-version (is_current) MERGE, upsert MERGE,
is_current backfill migration, retry semantics, and the infer-schema null-cast gotcha.

Run: pip install -r requirements.txt pytest && pytest tests/  (from the sidecar dir).
"""
import os

import pytest

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


# --- optimize actually compacts many small files (controlled append path) -----
def test_optimize_compacts_small_files(tmp_path):
    p = str(tmp_path / "obs")
    for i in range(6):  # 6 separate append commits → 6 small files
        ds.do_write({"table_path": p, "rows": [{"id": str(i), "v": i}], "schema": "infer", "mode": "append"})
    out = ds.do_optimize({"table_path": p, "zorder": False})
    assert out["files_before"] >= 6
    assert out["files_after"] < out["files_before"]  # compacted into fewer files
    assert q(p, "SELECT count(*) AS n FROM t")[0]["n"] == 6  # no data lost

    # z-order by id clusters (and still compacts) when the table has an id column
    z = ds.do_optimize({"table_path": p})
    assert z["zorder"] == ["id"]


# --- infer-schema null-cast gotcha (write "" not null for optional strings) --
def test_infer_schema_empty_string_roundtrips(tmp_path):
    p = str(tmp_path / "audit")
    # First batch uses "" (not None) for the optional string col — keeps it Utf8, not Null,
    # so the SECOND append with a real value does not hit "Cannot cast Utf8 to Null".
    ds.do_write({"table_path": p, "rows": [{"id": "1", "display": ""}], "schema": "infer"})
    ds.do_write({"table_path": p, "rows": [{"id": "2", "display": "value"}], "schema": "infer"})
    rows = q(p, "SELECT id, display FROM t ORDER BY id")
    assert [r["display"] for r in rows] == ["", "value"]


# --- table enumeration (/list-tables: restart-registration / startup discovery) ---
def test_list_tables_local_walk(tmp_path):
    base = str(tmp_path)
    ds.do_write({"table_path": f"{base}/bronze/patient", "rows": [bronze("a", 1, True)], "schema": "bronze"})
    ds.do_write({"table_path": f"{base}/terminology/codesystem_concept",
                 "rows": [{"system": "s", "code": "c", "display": None, "version": None}], "schema": "infer"})
    out = ds.do_list_tables({"base": base})
    rels = sorted(t["rel"] for t in out["tables"])
    assert rels == ["bronze/patient", "terminology/codesystem_concept"]
    assert all(t["path"].startswith(base) for t in out["tables"])


def test_list_tables_missing_base(tmp_path):
    out = ds.do_list_tables({"base": str(tmp_path / "nope")})
    assert out["tables"] == []


def test_object_store_rel_paths():
    assert ds._rel("s3://bucket/delta", "s3://bucket/delta/bronze/patient") == "bronze/patient"


# --- security controls (audit 2026-07-05) ---
def test_confine_rejects_traversal(tmp_path):
    with pytest.raises(ValueError):
        ds._confine(str(tmp_path) + "/../../etc/passwd")


def test_confine_rejects_object_store_with_local_base():
    with pytest.raises(ValueError):
        ds._confine("s3://attacker-bucket/exfil")


def test_confine_allows_normal_path(tmp_path):
    p = str(tmp_path / "bronze" / "patient")
    assert ds._confine(p) == p


def test_merge_rejects_bad_key(tmp_path):
    p = str(tmp_path / "patient")
    ds.do_write({"table_path": p, "rows": [bronze("a", 1, True)], "schema": "bronze"})
    with pytest.raises(ValueError):
        ds.do_merge({"table_path": p, "rows": [bronze("a", 2, True)], "key": "id = 1 OR '' = ''"})


def test_write_version_conflict_detected(tmp_path):
    """Cross-process race: two writers both compute version N+1 off a stale read. The second
    must NOT silently drop its body — the guarded MERGE surfaces a conflict."""
    p = str(tmp_path / "patient")
    ds.do_write_version({"table_path": p, "row": bronze("a", 1, True), "prev_version_id": None})
    # first writer lands v2 (demote v1)
    ds.do_write_version({"table_path": p, "row": bronze("a", 2, True), "prev_version_id": 1})
    # second writer ALSO tries v2 off the stale v1 read → conflict, not a lost write
    with pytest.raises(Exception):
        ds.do_write_version({"table_path": p, "row": bronze("a", 2, True, body_json='{"x":"lost"}'), "prev_version_id": 1})
    # exactly one current row, and it's the first writer's v2 (body intact)
    rows = q(p, "SELECT version_id, is_current FROM t WHERE is_current = true")
    assert len(rows) == 1 and rows[0]["version_id"] == 2


# --- Change Data Feed (/cdf — ADR-0026 incremental promotion) ----------------
def test_cdf_changed_ids(tmp_path):
    # A /bronze/ path gets delta.enableChangeDataFeed=true at creation.
    p = str(tmp_path / "bronze" / "observation")
    ds.do_write({"table_path": p, "rows": [bronze("a", 1, True), bronze("b", 1, True)], "schema": "bronze"})
    v0 = ds.do_cdf({"table_path": p})
    assert v0["version"] == 0 and v0["ids"] == []  # version-only probe (no starting_version)

    ds.do_write({"table_path": p, "rows": [bronze("a", 2, True)], "schema": "bronze"})
    ds.do_write({"table_path": p, "rows": [bronze("c", 1, True)], "schema": "bronze"})
    res = ds.do_cdf({"table_path": p, "starting_version": v0["version"] + 1})
    assert res["version"] == 2
    assert res["ids"] == ["a", "c"]  # b unchanged since version 0

    # A starting_version beyond the current version → no changes.
    beyond = ds.do_cdf({"table_path": p, "starting_version": res["version"] + 1})
    assert beyond["ids"] == []


def test_cdf_synthesized_for_append_only_tables(tmp_path):
    # delta-rs derives CDF from the commit log for APPEND-ONLY history even without the
    # delta.enableChangeDataFeed property (the property is required once MERGE/DELETE
    # commits appear — errors there surface to callers, who fall back to full rebuild).
    p = str(tmp_path / "gold" / "observation")
    ds.do_write({"table_path": p, "rows": [bronze("a", 1, True)], "schema": "bronze"})
    ds.do_write({"table_path": p, "rows": [bronze("b", 1, True)], "schema": "bronze"})
    res = ds.do_cdf({"table_path": p, "starting_version": 1})
    assert res["ids"] == ["b"]
