# Guarded six-month dataset command

Status: command implementation and scoped source reviews are complete. Final
integration, whole-increment closure and exact-source native/compiled-positive
CI acceptance remain pending. The shared local US database is not a permitted
acceptance fixture. US-11 remains in progress, with viewer/browser journeys,
screenshots/video and hosting still separate gates. This command creates no
release or deployment authorization.

The standalone `apps/api/dist/main.us-dataset.js` initializes or verifies the
fixed `us-processor-six-month-v1` recipe: all 260 regular units, correction and
orphan, 964 roots, 963 finalized events, 785 lots, 15,700 boxes, an owned Plan and
three actual Request packages in the prescribed order. It has no subset, reset,
repair, migration or general-worker mode.

## Explicit prerequisites

Use Node 24+ and the repository's Corepack/pnpm version in a clean reviewed US
checkout. The checked build inventories API, DB, domain and contract output,
bundled fonts and the lockfile. A dirty, missing, malformed or stale descriptor
is refused before database acquisition. Do not edit its Git identity or hide
untracked files to make it clean.

Build dependencies and the existing checked descriptor from the worktree root:

```sh
corepack pnpm turbo build --filter '@markiro/api^...'
corepack pnpm --filter @markiro/api build:us-request-worker
```

The existing descriptor builder inventories the whole API output, including the
dataset entry. The historical script name does not start a worker.

An independently owned disposable PostgreSQL installation must already have the
current schema, the reserved synthetic original owner and the
`US_FSMA204_PROCESSOR` profile in `America/Los_Angeles`. The actual connected
database must be `markiro_us_dev`, the actual user `markiro_us`, on
`127.0.0.1:55432` (or the allowed loopback spelling). An ordinary child database
with another name cannot stand in for that installation. Do not populate or
migrate the shared local base for acceptance, stop the existing port owner or
change identity checks.

Prepare an explicit isolated environment outside the executable, based on
`deploy/us-development/local.env.example`; preserve any existing personal env
file. Supply both private storage configurations using separate private Plan
and Request buckets/credentials, distinct from general S3 storage:

| Configuration   | Required fields                                                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plan            | `US_PLAN_ARTIFACT_S3_ENDPOINT`, `REGION`, `BUCKET`, `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY`, `FORCE_PATH_STYLE` (each suffix uses the same prefix)   |
| Request package | `US_REQUEST_PACKAGE_S3_ENDPOINT`, `REGION`, `BUCKET`, `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY`, `FORCE_PATH_STYLE` (each suffix uses the same prefix) |

The validators require the isolated loopback provider endpoint; private buckets,
policies and credentials must already exist. The two private configurations are
validated independently and each must differ from general S3 storage. The CLI
does not compare Plan and Request configurations against one another or inspect
effective bucket/IAM policies. Separate Plan/Request buckets and restricted
accounts are operator prerequisites; the positive CI scenario requires actual
checks of that separation, and its execution remains pending. Configuration
validity alone does not prove least privilege or provider availability. The
runtime constructs real S3 clients with the existing single-attempt/time-bounded
transport and verifies actual private bytes. It never creates buckets or changes
provider policies.

## Exact invocation

Run from the worktree root using a clean child environment. The operator-owned
isolated env file supplies no source-root/descriptor override. Replace only the
two UUID placeholders below with the existing reserved tenant/owner IDs:

```sh
env -i "$(command -v node)" --env-file=/absolute/path/to/operator-owned-us.env \
  apps/api/dist/main.us-dataset.js initialize \
  --confirm-local-synthetic-dataset \
  --database-name markiro_us_dev --database-user markiro_us \
  --tenant-id <lowercase-tenant-UUID> --owner-id <lowercase-owner-UUID> \
  --version us-processor-six-month-v1 \
  --definition-digest f6bd2bceaeb921ee0237157dfe6f2ea9f72ed31ada816f6817f40e8e06efda5a

env -i "$(command -v node)" --env-file=/absolute/path/to/operator-owned-us.env \
  apps/api/dist/main.us-dataset.js verify \
  --database-name markiro_us_dev --database-user markiro_us \
  --tenant-id <lowercase-tenant-UUID> --owner-id <lowercase-owner-UUID> \
  --version us-processor-six-month-v1 \
  --definition-digest f6bd2bceaeb921ee0237157dfe6f2ea9f72ed31ada816f6817f40e8e06efda5a
```

Named pairs may be reordered; duplicates, unknown flags, extra tokens, missing
values, different recipes/digests, noncanonical IDs and whitespace are refused.
Initialize requires confirmation exactly once. Verify refuses confirmation and
never creates missing prerequisites.

## Results, errors and recovery

Success is one bounded JSON line after the real complete owner and normal
resource disposal settle. It includes `synthetic: true`,
`state: "six_month_seed_stages_verified"`, `datasetComplete: false`, recipe and
dataset identity, canonical Plan/Request/run/artifact IDs and content hashes.
The false flag is deliberate: sequential native/Trace and artifact verification
is not viewer/browser acceptance or a globally atomic snapshot of later writes.

Failure emits no success and exits nonzero. Its single JSON diagnostic contains
only a fixed category and, when available, an exact recipe unit and that unit's
allowed stage. It never prints SQL, raw errors, stack traces, URLs, credentials
or private bytes. Categories are `us_dataset_command_arguments_invalid`,
`us_dataset_command_environment_invalid`, `us_dataset_command_storage_unavailable`,
`us_dataset_command_build_invalid`, `us_dataset_command_connection_failed`,
`us_dataset_command_target_invalid`, `us_dataset_command_schema_invalid`,
`us_dataset_command_prerequisite_invalid`, `us_dataset_command_disposal_failed`
and `us_dataset_command_failed`. Retain private internal failure evidence in the
trusted diagnostic environment, not in public command output.

The runtime checks actual database identity and current schema, then original
owner provenance/current processor profile before seed work. These reads use
the existing share-lock authorization contract; they do not run inside an
incompatible PostgreSQL `READ ONLY` transaction. Each constituent owner reloads
its own authority. Pools and both private clients are owned and disposed after
awaited work settles, including partial acquisition and refusal.

OS interruption is non-success and may leave valid partial state. After fixing
the prerequisite/provider problem, explicitly invoke initialize again with the
same recipe/IDs. Existing journals resume saved intents, Request/run identities
and clocks; do not reset, repair or run an unrelated queue. Verify of incomplete
or corrupt state fails. Completed initialize and verify use the existing
verification-only paths; they do not rewrite missing/corrupt private artifacts.

## Evidence boundaries

Focused runtime tests and the compiled refusal smoke prove refusal/redaction,
resource ordering and the absence of listeners/connections on early failures.
They are not a successful CLI run. Task 2's native owner evidence is separate
from execution of this compiled entry with real private transport.

Positive compiled acceptance requires one real initialize and verify against
the same independently owned exact-named installation, real private provider
bytes, measured process peak RSS/elapsed time/database and artifact bytes,
no-write completed replay, normal exact disposal and current-source CI.
Those measurements are pending; no cost, free-tier, two-minute, hosting,
physical, viewer or overall US-11 completion claim follows from source checks.

The check-only no-service `dataset_command_refusals` job owns the explicit policy
and runtime tests, checked compilation and refusal smoke. It does not execute
the positive workload or require private-provider services. Task 3B uses a
separate independently owned exact-named PG17 installation and the existing
pinned MinIO/mc versions, exactly one initialize and one verify (each within the
existing900000 ms whole-volume envelope), with no retry or subset. The approved
new job envelope is45 minutes; existing assertion/setup/disposal limits and old
jobs remain unchanged. Its detailed provider mutation observation and normal
cleanup matrix was reviewed before implementation. Viewer work awaits actual
CLI acceptance.

The additive `dataset_command_positive` job now owns that compiled smoke. It
refuses before external I/O outside its exact GitHub-hosted CI job. The fixture
attests an initially empty actual `markiro_us_dev` database and provisions only
the original owner/profile through actual services before the sole compiled
initialize. Its own pinned MinIO process uses ephemeral data and two private
buckets with distinct restricted generated accounts. A transparent streaming
observer forwards real SDK traffic from19000 to19002, retaining counters only.
Both compiled commands use the actual clean checked build descriptor.

Compiled verify compares every public table through the existing full MVCC
snapshot helper and requires provider reads with zero mutations, failures or
active requests. These hashes establish persisted-state equality; the current15
native cases separately own literal SQL mutation observation. Neither evidence
category substitutes for the other. The fixture verifies saved Plan/Request
publications and private PDF/manifest/ZIP bytes independently without a third
owner traversal, and records elapsed time, GNU time's actual child maximum RSS,
database bytes and separate private bucket totals. Awaited normal disposal must
drop only the attested runner database and remove only recorded/attested
container IDs, verifying absence; cleanup failure fails the gate.

Local observer/tooling/refusal checks do not execute this positive workload.
Actual current15 native and compiled-positive CI remain pending; viewer work,
hosting, production and release acceptance have not been performed.
