# Validator follow-up: 18 October 2026

**Passed as a short integration/content check.** UTC 12:25:23.119–12:27:11.855,
including synthetic setup, authentication and cleanup. This is separate from the
[original full capacity measurement](../2026-10-18/README.md).

The strengthened checker downloaded 19 newly generated private S3 ZIPs through
the real report lifecycle. Each contained exactly the requested ten tenants ×
thirty inclusive dates: 300 unique tenant/day rows, no foreign or out-of-range
rows, no duplicate or missing grains, agreements_signed=1, matching metadata
row count and CSV SHA-256. Each saved report entry records validatedRows=300 and
contentValidation=exact-tenant-day-grain-v2. ZIP sizes were 4,127–4,128 bytes;
maximum ready latency was 30.293 seconds. The final queue had zero non-ready jobs.

All 745 HTTP responses passed status/correctness checks, including 563 in timed
2/3/3/2-second phases. Durable counts matched 44 licenses, 44 diagnostics and
19 reports, with zero issuance audit mismatches. Every declared business
operation had successful samples in every phase. Real password/TOTP authentication,
license signatures, encrypted diagnostics, cross-tenant resource denial and
report creator isolation were retained. Edge CA verification passed; PostgreSQL
accepted verify-full and rejected wrong-hostname, untrusted-CA and plaintext.

Service quotas remained 1.25/0.50/0.25 CPU and 1,536/1,024/192 MiB for API/PG/edge.
Final allocation OOM, OOM-kill, OOM-group-kill and restart counters were zero.
This short run is not a new capacity measurement. The six-CPU local Podman host,
helpers outside service quotas, synthetic modest database, derived arm64 images
and local-only tmpfs/TLS-volume adapter retain the original limitations.

## Reproduction and evidence

After rebuilding the two task-owned derived images from the tracked recipes and
unchanged retained API/platform-only SaaS/landing dist:

```bash
COMPACT_LOAD_EVIDENCE_DIR=docs/evidence/timeweb-compact/2026-10-18-validator-smoke \
  node deploy/platform/load/compact-load.mjs --local-load --smoke
```

- [Summary, per-report validation markers and source/image fingerprints](results.json)
- [All 745 sanitized request observations](requests.json.gz)
- [Build and workload runbook](../../../runbooks/timeweb-compact-load.md)

Validator revision: `oom-and-exact-report-grain-v2`. Raw observations contain only
phase/operation/ms/status/ok; source fingerprints were independently recomputed
and matched. The original full-run JSON/gzip bytes and hashes remain unchanged.
Its ZIPs were not retained, so this new check cannot establish their exact row
grain retroactively. Saved zero OOM counters from that run were reevaluated with
the corrected predicate and still pass.

The harness verified removal of its task containers/volumes and private files.
The rebuilt API image `be41df3503bd81804f58d49201d4f6ed72bdee7c6eaf27d46902fcfc232105ca`
and edge image `da6c2cdd03d6e586ed6e0e5dd01041e52919bed61f969b319b04193ea531b36f`
were deleted afterward, as was the task build context. Task-name container and
volume listings were empty. No unrelated workload, shared base image or build
cache was removed. No runtime source, `.env`, remote or production resource changed.

Exact release images/CI, actual Timeweb capacity and disk, production TLS file
permissions and least-privilege PostgreSQL role, provider SMTP/S3, backup/restore,
browser and physical-device acceptance remain separate outstanding gates.
