#!/usr/bin/env python3
"""Drive an Inferno test group via the JSON API and print results.
Usage: run.py <suite_id> <group_or_test_id> [name=value ...]
"""
import json, sys, time, urllib.request as u

BASE = "http://localhost/api"

def post(path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = u.Request(BASE + path, data=data, method="POST",
                    headers={"Content-Type": "application/json"})
    try:
        return json.load(u.urlopen(req))
    except u.urllib.error.HTTPError as e:
        print(f"HTTP {e.code} on {path}: {e.read().decode()[:300]}", file=sys.stderr)
        raise

def get(path):
    return json.load(u.urlopen(BASE + path))

suite, target = sys.argv[1], sys.argv[2]
inputs = []
for a in sys.argv[3:]:
    k, v = a.split("=", 1)
    item = {"name": k, "value": v}
    if k.endswith("auth_info"):
        item["type"] = "auth_info"  # Inferno needs the type to accept structured auth inputs
    inputs.append(item)

sess = post(f"/test_sessions?test_suite_id={suite}")["id"]
# A target containing the suite id with extra segments is a group; else a single test.
body = {"test_session_id": sess, "inputs": inputs}
body["test_group_id"] = target
run = post("/test_runs", body)
rid = run["id"]

for _ in range(120):
    st = get(f"/test_runs/{rid}")["status"]
    if st in ("done", "waiting"): break
    time.sleep(1)

full = get(f"/test_runs/{rid}?include_results=true")
print(f"# suite={suite} status={full.get('status')} session={sess}\n")
counts = {}
for res in full.get("results", []):
    r = (res.get("result") or "?")
    counts[r] = counts.get(r, 0) + 1
    tid = (res.get("test_id") or "").split("-")[-1]
    if tid:  # skip group-level roll-up rows
        print(f"{r.upper():6} {tid}")
        msgs = res.get("messages") or []
        for m in msgs[:2]:
            print(f"       ↳ [{m.get('type')}] {m.get('message','')[:200]}")
        if res.get("result_message"):
            print(f"       ↳ {res['result_message'][:200]}")
print("\n# tally:", counts)
