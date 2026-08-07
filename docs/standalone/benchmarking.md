# fhirEngine — Scale Benchmarking

`fhirengine-bench` measures **ingest throughput** and **search latency percentiles** (plus
optional **promote** and **optimize** timings) against a real delta-rs store, driving the
in-process app so numbers reflect server processing, not network. The synthetic population is
deterministic per index, so a run is reproducible from its config.

> **Numbers are hardware- and store-specific.** Always publish them WITH the machine, store
> backend (local FS vs object store), and config — never as absolutes.

## Run

```sh
# sidecar up first (its own store base):
python sidecar/delta_sidecar.py --port 8077 --base ./.delta-bench &

FHIRENGINE_DELTA_SIDECAR_URL=http://127.0.0.1:8077 FHIRENGINE_DELTA_BASE=./.delta-bench \
  npm run bench -- --patients 10000 --resources-per-patient 5 --search-iterations 500 \
    [--batch 200] [--promote] [--optimize] [--out report.json]
```

| Flag | Default | Meaning |
|---|---|---|
| `--patients` | 1000 | synthetic patients to generate + ingest |
| `--resources-per-patient` | 5 | 1 Patient + N−1 alternating Observation/Condition, all referencing it |
| `--search-iterations` | 300 | iterations per search workload |
| `--batch` | 200 | resources per transaction bundle (ingest) |
| `--promote` | off | time full promote (Patient/Observation/Condition) + an incremental no-op pass |
| `--optimize` | off | time OPTIMIZE + Z-order, then re-measure search |
| `--out` | — | also write the JSON report to a file |

## Search workloads

Each is timed individually across `--search-iterations`: `read-by-id`, `search-_id`,
`token-identifier`, `string-family`, `date-birthdate` (range), `reference-subject`
(Observation?patient=…), `token-obs-code`.

## Illustrative result (dev laptop, local FS, 500 patients)

Small dev-laptop run — for shape, not as a headline number:

```
INGEST  2495 resources in 11.06s  →  ~226/s   (transaction bundles of 200, validation per resource)
SEARCH latency (ms)   p50 / p95 / p99
  read-by-id             2.1 /  2.3 /  2.8
  search-_id             4.5 /  4.9 /  6.5
  token-identifier       7.6 /  7.9 /  9.2
  reference-subject      8.5 / 10.0 / 10.5
PROMOTE (ms)  full:Patient 20 · full:Observation 15 · full:Condition 16 · incremental-noop 43
OPTIMIZE      24ms
```

Read-by-id in low single-digit ms and every indexed search under ~10ms p95 at this size; ingest
is validation-bound (each resource runs the full TS validation chain pre-Bronze). For a headline
run, use `--patients 100000+` on representative hardware and object storage, and report the config
alongside.
