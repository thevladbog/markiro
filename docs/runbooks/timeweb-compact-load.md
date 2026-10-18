# Local compact-profile verification

This is a synthetic, local-only capacity check for the Markiro platform-only
control plane. It is not deployment approval. The protected release-image build,
actual Timeweb hardware, restored production data, storage IOPS and recovery
acceptance remain separate gates.

## Reproduce

Use Node 24+, the repository's Corepack pnpm and a local Docker Unix socket. The
harness removes `DOCKER_HOST` and `DOCKER_CONTEXT` overrides and rejects any selected
non-Unix endpoint before creating resources. It accepts no target URL, database
URL or credentials. It generates fresh synthetic secrets and identities, publishes
only edge ports on loopback, and deletes its own containers, networks, volumes and
private files in `finally`. No existing `.env` is read by the harness or changed.

First run the cheap safety contracts (included by the existing platform test glob):

```bash
node --test deploy/platform/test/compact-load*.test.mjs
```

The local 3.53 GiB Podman VM previously OOMed during exact API/edge builds. The
following explicitly **derived** runtime recipes reuse Linux dependencies but copy
host-compiled API/static assets. They do not satisfy the exact release-image gate.
Run builds outside the target production VM. Keep the temporary build context
private and remove only the images created by these commands when done.

```bash
corepack pnpm turbo run build --filter='@markiro/api^...'
corepack pnpm --filter @markiro/api build
VITE_SERVER_PROFILE=platform-only corepack pnpm --filter @markiro/saas-admin build
corepack pnpm --filter @markiro/landing build
compact_context=$(mktemp -d)
cp -R apps/api/dist "$compact_context/api-dist"
cp -R apps/saas-admin/dist "$compact_context/saas-dist"
cp -R apps/landing/dist "$compact_context/landing-dist"
unset DOCKER_HOST DOCKER_CONTEXT
docker buildx build --load --build-context "compactprecompiled=$compact_context" \
  -f deploy/platform/load/api-derived.Dockerfile -t markiro-compact-load-api:derived .
docker buildx build --load --build-context "compactprecompiled=$compact_context" \
  -f deploy/platform/load/edge-derived.Dockerfile -t markiro-compact-load-edge:derived .
rm -rf "$compact_context"
```

Verify the compiled SaaS entry actually selects `platform-only`; an image
runtime environment variable cannot repair assets compiled with the legacy
profile. The measured run rebuilt these assets explicitly. Docker image IDs and
selected source fingerprints are recorded in the result.

```bash
COMPACT_LOAD_EVIDENCE_DIR=/absolute/path/to/injected \
  node deploy/platform/load/compact-load.mjs --local-load --fail-after-start
# Expected nonzero exit; results.json must have cleanup=true and injected failure.
COMPACT_LOAD_EVIDENCE_DIR=/absolute/path/to/smoke \
  node deploy/platform/load/compact-load.mjs --local-load --smoke
COMPACT_LOAD_EVIDENCE_DIR=/absolute/path/to/full \
  node deploy/platform/load/compact-load.mjs --local-load
# Only after no run is using these task-created images:
docker image rm markiro-compact-load-api:derived markiro-compact-load-edge:derived
```

The smoke has 2/3/3/2 second phases and proves integration only. The full test has
60 seconds warmup (5 users), 180 steady (5), 60 burst (10), and 60 recovery (5).
Each user has one request in flight and 100 ms think time between iterations;
write iterations execute a sequential preview/issue/download/diagnostics chain.
There is no request retry that masks workload errors. Setup enrolls real users
via password and TOTP HTTP endpoints, with 11 seconds of inactivity after each
three users because Better Auth's production limiter resets after inactivity.
The guard and limiter remain unchanged. Setup is outside timed load phases.

## Dataset and business assertions

The isolated database contains 100 synthetic tenants without cabinet access,
100 active direct plan assignments, one published plan, 3,000 dated synthetic
signed-agreement facts (30 dates per tenant), 10 platform administrators and
10 registered standalone sites. No production records are copied. The plan has
2 lines, 3 stations, 0 kiosks and 5 cabinet users. Diagnostics contain one month
with 7,020 accepted scans, 64 duplicates and 9 rejected scans per host; later
snapshots update that month's projection rather than add its totals repeatedly.

Every phase requires successful samples of tenant list/detail, site list, license
history, license preview/issue/download, diagnostics ingestion/detail/statistics
and report creation. Requests use the current commercial contract and the edge's
`/api/platform` prefix. License validation includes the real domain signature
verifier, exact tenant/host/quotas, sequence and SHA-256. Report jobs run through
pg-boss and private S3, then download a real ZIP: metadata, CSV checksum, all 300
rows, exact per-row agreement count and the complete requested tenant/day set
are checked. Foreign tenants, dates outside the requested inclusive range,
duplicate grains and missing grains fail even with self-consistent checksums.
Direct cross-tenant license/diagnostic reads and another creator's report download
must return 404. Final durable write counts and issuance audit actor, tenant,
action, target and outcome must match.

The acceptance function rejects correctness/status errors, an empty workload,
missing required operations, steady p95 above 1,000 ms, burst p95 above 2,000 ms,
OOM, restarts and incomplete reports. Allocation `oom` events without a kill,
`oom_kill`, `oom_group_kill` and the Docker OOM flag all fail acceptance. It measures
writes as well as reads.
Reports must finish inside the existing ten-minute worker lease; observed ready
latencies are recorded separately. Source query statement timeout remains 60 s.
The recovery phase must leave no non-ready reports. This is queue drain evidence,
not a process-crash recovery or restored-backup test.

## Resource and transport boundaries

Running cgroup `cpu.max` and `memory.max` must equal:

| Service    | CPU cores |  Memory limit |
| ---------- | --------: | ------------: |
| API        |      1.25 |     1,536 MiB |
| PostgreSQL |      0.50 |     1,024 MiB |
| Edge       |      0.25 |       192 MiB |
| **Total**  |  **2.00** | **2,752 MiB** |

Migration runs with API and edge stopped. Synthetic mail/S3 helpers (128/256 MiB
caps), macOS load driver, local VM OS and unrelated workloads are outside these
service quotas. The actual local VM has six CPUs and 3,791,695,872 bytes of RAM;
three service quotas totaling two cores are not a physically two-vCPU VM.
The harness records cgroup CPU usage/throttling, current/peak memory, Docker
stats, DB connection counts, report queue states and restart/OOM counters.
Sampling every approximately five seconds includes command overhead and cannot
capture every instantaneous CPU peak; cgroup memory.peak retains memory peaks.

PostgreSQL uses the production compact settings and private database network.
A synthetic CA and `db.private` server certificate test verify-full. Actual
wrong-hostname, untrusted-CA and plaintext connections must fail. Edge HTTPS is
verified against the task's Caddy CA, not by disabling certificate validation.
The synthetic PostgreSQL bootstrap role is used for this isolated fixture;
production least-privilege role provisioning remains a separate prerequisite.

The local Podman adapter rejects the production Compose tmpfs `uid=70,gid=70`
option. Only the generated test overlay changes the PostgreSQL socket tmpfs to
`mode=1777` with the same noexec/nosuid/16 MiB limit. It also mounts a task-owned
TLS volume initialized to uid 70 and mode 0600 for key/password, instead of
production protected file bind mounts. Production configuration is unchanged.
These differences, host-compiled images and synthetic fixtures prevent labeling
the test as an exact production composition. No unrelated container is stopped,
no VM is resized, and no Docker prune is performed.

## Evidence and remaining release gates

`results.json` contains summaries, resource samples, provenance, checks and
cleanup status. `requests.json.gz` contains all sanitized observations with only
phase, operation, elapsed milliseconds, HTTP status and correctness boolean.
Neither contains cookies, passwords, signing keys, diagnostic tokens, signed URLs
or raw application logs. Failed subprocess diagnostics are scrubbed in memory
before inclusion; raw stderr is not retained.

The checked-in [full result](../evidence/timeweb-compact/2026-10-18/results.json)
and [raw observations](../evidence/timeweb-compact/2026-10-18/requests.json.gz)
are local evidence. The parent CI integration retains cheap harness contracts;
the six-minute performance run is not appended to the near-budget protected
image job. Exact API/edge builds and exact-image compact business verification
remain outstanding before target capacity acceptance. Browser rendering,
Timeweb CPU/storage, SMTP/S3 providers, restored historical-data scale,
backup/restore and physical factory devices were not exercised here.

The [original full measurement](../evidence/timeweb-compact/2026-10-18/README.md)
predates the exact report-grain and allocation-OOM validator fixes. Its immutable
results retain the original source fingerprints. The old ZIPs were not retained;
only the [separate short smoke](../evidence/timeweb-compact/2026-10-18-validator-smoke/README.md)
provides real ZIP evidence for the strengthened content checker. Saved zero OOM
counters from the full measurement were rechecked by the new predicate.
