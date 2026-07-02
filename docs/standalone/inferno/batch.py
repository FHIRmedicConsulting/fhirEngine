#!/usr/bin/env python3
"""Run several US Core clinical groups and print a compact tally + fails/errors per group."""
import json, sys, time, urllib.request as u, urllib.error

BASE, SUITE = "http://localhost/api", "us_core_v610"
URL = "http://host.docker.internal:3000"
PID = sys.argv[1]                       # synthea patient id
GROUPS = sys.argv[2:]

def post(path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = u.Request(BASE + path, data=data, method="POST", headers={"Content-Type": "application/json"})
    try: return json.load(u.urlopen(req))
    except urllib.error.HTTPError as e: return {"_err": f"{e.code}:{e.read().decode()[:120]}"}

def get(path): return json.load(u.urlopen(BASE + path))

for g in GROUPS:
    gid = f"{SUITE}-{SUITE}_fhir_api-{g}"
    sess = post(f"/test_sessions?test_suite_id={SUITE}")["id"]
    run = post("/test_runs", {"test_session_id": sess, "test_group_id": gid,
               "inputs": [{"name": "url", "value": URL}, {"name": "patient_ids", "value": PID},
                          {"name": "smart_auth_info", "value": '{"auth_type":"public"}', "type": "auth_info"}]})
    if run.get("_err"): print(f"{g:42} START-ERR {run['_err']}"); continue
    rid = run["id"]
    # wait for run to finish, then let late (validator) tests settle
    for _ in range(90):
        if get(f"/test_runs/{rid}").get("status") in ("done", "waiting"): break
        time.sleep(2)
    time.sleep(3)
    res = get(f"/test_sessions/{sess}/results")
    mine = [r for r in res if (r.get("test_id") or "").startswith(gid) and r.get("test_id")]
    from collections import Counter
    tally = Counter((r.get("result") or "?") for r in mine)
    print(f"{g:42} {dict(tally)}")
    for r in mine:
        if (r.get("result") or "") in ("fail", "error"):
            print(f"    {r['result'].upper()} {r['test_id'].split('-')[-1]}: {(r.get('result_message') or '')[:150]}")
