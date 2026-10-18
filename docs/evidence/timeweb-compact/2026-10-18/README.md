# Compact platform load: 18 October 2026

**Passed for the declared local synthetic workload.** Run UTC 11:57:01–12:04:32,
including setup and cleanup. Full timed workload: 360.28 seconds. No production
or remote resources were used. These are arm64 derived runtime images on a local
six-CPU / 3.53 GiB Podman VM, with API/PG/edge cgroups totaling two CPU cores and
2,752 MiB. This is not exact-release or target-Timeweb acceptance.

| Phase    | Users | Responses | Requests/s | p50 ms | p95 ms | p99 ms | Failures |
| -------- | ----: | --------: | ---------: | -----: | -----: | -----: | -------: |
| warmup   |     5 |      2941 |      48.97 |  12.56 |  26.22 |  61.35 |        0 |
| steady   |     5 |      8889 |      49.36 |  11.82 |  27.43 |  35.40 |        0 |
| burst    |    10 |      6184 |     102.89 |   6.05 |  25.61 |  75.19 |        0 |
| recovery |     5 |      2964 |      49.37 |   8.49 |  38.70 |  83.65 |        0 |

All 21,143 HTTP responses (including setup and final verification) met their
status and correctness assertions. The four timed phases account for 20,978.
There were 930 signed license issuances and 930 encrypted diagnostic ingestions,
with exact durable DB counts and zero issuance audit mismatches. Ten real users
completed production password sign-in/TOTP. Mismatched tenant/resource IDs and
another user's report download were denied.

All 25 durable reports completed: 300 CSV rows each, per-row agreement counts,
requested-tenant inclusion, one excluded-tenant sentinel, metadata and SHA-256
were checked. The original checker did not prove the exact tenant/day row set. ZIP sizes were 4,126–4,128 bytes.
Maximum ready latency was 21.681 s; p95 was 19.704 s, within the existing ten-minute
worker lease. Peak sampled pending reports: 10; final non-ready reports: 0.
No failed reports, OOM events, memory-limit hits or service restarts were recorded.

## Resources

| Service  | CPU quota | Memory quota MiB | Kernel-observed memory peak MiB | Peak interval CPU cores |
| -------- | --------: | ---------------: | ------------------------------: | ----------------------: |
| api      |      1.25 |             1536 |                          559.03 |                   0.416 |
| postgres |      0.50 |             1024 |                          145.29 |                   0.191 |
| edge     |      0.25 |              192 |                           19.64 |                   0.035 |

Forty-five samples had a median interval of 7.921 s (five-second sleep plus
measurement overhead). Simultaneous sampled memory peak was **655.90 MiB**;
the sum of separately observed service peaks was 723.95 MiB.
Peak interval aggregate CPU was **0.641 cores**. These interval averages do
not rule out instantaneous CPU bursts. API/PG/edge CPU-throttled periods increased
by 47/11/1; corresponding throttled counters increased by 8.576/0.187/0.060 seconds.
No latency threshold was exceeded. DB connections peaked at 11 including the
sampler connection. PostgreSQL 17.11 reported max_connections 32, shared_buffers
256 MB, fsync/full_page_writes/synchronous_commit on. Seeded DB size was about
24 MiB; this does not represent production historical-data size.

Service memory headroom was substantial for this workload (over 2 GiB versus the
sum of limits at the sampled concurrent peak). This does not measure whole-VM
headroom: helper SMTP/S3, OS, macOS driver and unrelated workloads were outside
those quotas. No target disk IOPS, historical-data restore or maximum-size report
was tested. Kernel memory peaks are the highest values observed by the sampler;
restart/OOM counters were checked again after final report validation.

## Per-operation latency

All operations below had zero status/correctness failures. Report creation was
concurrent with interactive traffic; report polling/download/content checks also
ran before the final acceptance decision.

| Operation              | Steady count | Steady p95 ms | Burst count | Burst p95 ms |
| ---------------------- | -----------: | ------------: | ----------: | -----------: |
| report-create          |            5 |         53.04 |          10 |        38.05 |
| license-preview        |          390 |         32.70 |         270 |        57.42 |
| license-issue          |          390 |         21.51 |         270 |        52.75 |
| license-download       |          390 |          8.84 |         270 |        28.27 |
| diagnostics-ingest     |          390 |         14.30 |         270 |        46.06 |
| tenant-detail          |         1286 |         26.53 |         896 |        21.91 |
| site-list              |         1155 |         27.91 |         805 |        22.33 |
| license-history        |         1285 |         32.62 |         895 |        30.29 |
| diagnostics-detail     |         1155 |         21.70 |         802 |        12.48 |
| diagnostics-statistics |         1285 |         22.54 |         890 |        12.55 |
| tenant-list            |         1158 |         22.46 |         806 |        15.93 |

## Evidence and cleanup

- [Summary and all resource samples](results.json)
- [All sanitized per-request observations, gzip JSON](requests.json.gz)
- [Injected-startup-failure cleanup proof](cleanup-injected.json)
- [Reproduction and limitations](../../../runbooks/timeweb-compact-load.md)

The harness verified removal of its containers/volumes after both injection and
successful full run. Its two derived image tags/images and temporary build files
were removed afterward. No task container/volume remained; shared base images and
build cache were preserved. Secrets, cookies, raw diagnostic tokens and signed
URLs are absent from the evidence.

The production compact overlay was not changed for this task. Local Podman-only
socket tmpfs/TLS-volume differences are documented in the runbook. Exact release
image CI, exact-image compact business validation, actual Timeweb capacity,
restore, provider SMTP/S3, browser rendering and physical-device checks remain
separate outstanding gates.

## Validator review follow-up

The original `results.json`, `requests.json.gz` and their measured provenance are
unchanged. Review found that report checks could accept foreign or duplicate
tenant/day rows and that the acceptance predicate ignored an allocation `oom`
event without a kill. The stored final cgroup counters are all zero, so reevaluation
with the strengthened OOM predicate confirms the original no-OOM observation.

The original ZIPs were deleted with the private test S3 volume; they cannot be
retroactively checked by the new validator. Their saved hashes do not prove exact
row grain. A separate [validator smoke](../2026-10-18-validator-smoke/README.md)
exercises new ZIPs with the exact requested tenant/date cartesian set, no foreign,
duplicate or missing grains, and count/checksum checks. This is subsequent content
verification, not a replacement six-minute capacity measurement. The original
source fingerprints describe the old harness; current validators intentionally differ.
