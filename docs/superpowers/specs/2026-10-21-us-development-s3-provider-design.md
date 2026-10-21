# US development S3 provider replacement

Status: owner authorized replacing unavailable MinIO with alternatives on
2026-10-21, under standing implementation approval. This is an isolated US
development/CI change, not hosting, deployment, release or existing-data migration.

## Decision

Replace MinIO with an actual S3-compatible provider in the US development
dependency and compiled dataset acceptance fixture. Retain the existing AWS SDK
clients and generic S3 runtime configuration. Final provider selection requires
exact-release source evidence and the real conditional-write acceptance below.
No provider is accepted merely because ordinary upload/download works.

Pin a public, provenance-verified release and its registry digest, not `latest`.
The initial candidate Garage v2.4.1 was REJECTED before implementation: its exact
release does not enforce conditional PUT `If-None-Match`, required by current
Plan and Request stores to prevent overwrites. Its accessible image and
bucket-scoped keys cannot compensate for this missing guarantee. RustFS and
SeaweedFS were the bounded next candidates. Select SeaweedFS4.48: exact release
source530be3e37337488ecc34d58441e0bc476e121c93 translates the condition to a filer
transaction under the object lock. Use
`chrislusf/seaweedfs:4.48@sha256:4e61d15fd35994cb1e43e1e553dff106794841fd9a99ade2fc8c8bfce4d7872d`.
Its anonymous manifest and amd64/arm64 configuration reads succeeded; actual
container execution remains unverified. RustFS1.0.3 is deferred: no simpler
restricted-credential bootstrap was established within the bounded comparison.
Registry availability, image config and exact-release source were checked, and
the final finite resource matrix must be resolved before implementation. No npm
dependency or SDK checksum-policy change is part of this replacement.

## Required boundaries

- Work only in the US worktree on `codex/us-mvp`; preserve operational locks,
  unrelated files, ignored raw evidence, primary/RU code and deployment workflows.
- Keep S3 client endpoint `127.0.0.1:19000`, path-style access and region
  `us-east-1`. Any management endpoint stays loopback-only and is documented for
  its actual purpose, not described as an unavailable MinIO console. Internal
  RPC/filer/master/volume endpoints are not host-published.
- Local Compose uses its own new provider data volume; never mount, migrate,
  overwrite or delete the former MinIO data volume. No services are started as
  an implementation step; operator start instructions remain explicit.
- The CI fixture remains CI-only on a clean source checkout, with its actual
  fixed owned PostgreSQL database/user and existing membership/profile checks.
  No local positive workload, shared-base write or port takeover.
- Preserve one real compiled initialize and one verify on the same installation,
  each capped at 900000ms; job45min, setup/disposal60000ms, assertion5000ms.
  No retry, sampling, removed assertion, new timeout or changed recipe.
- Preserve all262 native units/964 roots/963 current finalized events/785 lots/
  15700 boxes, Plan PDF and three Request packages selecting1/12/12 chains.

## Provider fixture

Own the exact provider container, labelled with the invocation UUID, with no Docker
logs, no external volume, read-only owned configuration and ephemeral data.
Attest the returned full ID, configured image/digest, actual immutable image ID,
command, ports and all mounts before acquiring cleanup authority. Unknown IDs
must never be stopped or removed. Await all children/SDK clients/observer work
before exact normal disposal and absence checks. A cleanup failure fails the gate.

Generate admin and two distinct application credentials into an owned0700
directory/0600S3identity configuration; never put secrets in argv or logs. Use
SeaweedFS's real static identity loader with only bucket-scoped Read/Write/List
actions on each application identity. Only the fixture's distinct setup identity
gets global administration to create the two private buckets. Do not configure
an anonymous identity, owner/global-create/admin privileges on application keys,
or public internal filer/master endpoints. Attest the exact read-only config
mount/content and prove effective permissions with real SDK reads and denials,
including application-key global bucket-creation denial. Product CLI never
receives setup credentials or creates users/buckets/policies.

Retain real SDK proof: own-bucket reads/writes, exact403 cross-bucket list/read/
write denials and anonymous read denial. Use the same transparent19000to19002
S3 observer and all private bytes/hashes/PDF/ZIP/native-bound assertions.
Verify must have actual reads and zero provider mutations/failures/live requests.
Retain all198-table persisted equality evidence and the separate native literal
SQL mutation proof. Do not treat one as the other.

Keep public failure diagnostics bounded and secret-safe: only fixed operation/
category identifiers and public image identity, not raw Docker/admin output.
Lost historical stderr must not be reconstructed from new observations.

Require real `PutObject` with `IfNoneMatch: "*"` to succeed once, reject a second
write to that key with412 without changing original bytes, and permit exactly
one winner in a bounded two-writer race with different bytes. Preserve the
storage services' actual collision/error checks, not an emulated HEAD-then-PUT.
Run these before full dataset initialization inside the unchanged setup budget.
Native locked/CAS/atomic source semantics are part of selection, not just headers
accepted or one sequential rejection.

## Local dependency configuration

Use a checked-in development-only provider configuration with single-node mode,
the fixed isolated general bucket and explicitly synthetic development access
values matching `local.env.example`. A valid provider key format may replace the
old general development key ID; do not rewrite a user's existing `.env`.
Replace the MinIO-specific initializer with documented provider bootstrap or a
guarded initializer supplying the general development bucket. Private Plan/Request storage
still needs independently restricted credentials/buckets; the general bucket
does not become either private store. The local example is not production-safe.

## Evidence and acceptance

Before code, focused tests must fail behaviorally on the old provider contract.
Cover unknown/wrong ownership, exposed admin/RPC, external or unexpected mounts,
mutable image tags, missing permission proof, incomplete cleanup and redaction.
Preserve all unrelated workflow byte/AST guards; migrate only provider-specific
expectations to the explicit newly authorized provider contract.

Run focused and full US/CI tooling, lint, formatting, isolation and diff checks.
Validate Compose statically without starting a service. No product API code
changes are expected; retained exact653 native15/fullTrace/API evidence stays
source-specific. Exact new-SHA US/Cases CI and actual compiled positive provider
execution remain mandatory, including emitted real child peak RSS, elapsed time,
database/private bytes and exact normal disposal. Source approval alone is not
provider, CLI, viewer, browser or deployed-demo acceptance.

## Primary references

- [Garage quick start](https://garagehq.deuxfleurs.fr/documentation/quick-start/)
- [Garage administration API](https://garagehq.deuxfleurs.fr/documentation/reference-manual/admin-api/)
- [Admin API v2 specification](https://garagehq.deuxfleurs.fr/api/garage-admin-v2.json)
- [S3 compatibility](https://garagehq.deuxfleurs.fr/documentation/reference-manual/s3-compatibility/)
- [SeaweedFS4.48 release](https://github.com/seaweedfs/seaweedfs/releases/tag/4.48)
- [Exact conditional transaction source](https://github.com/seaweedfs/seaweedfs/blob/4.48/weed/s3api/s3api_object_routed_write.go)
- [SeaweedFS S3 credentials](https://github.com/seaweedfs/seaweedfs/wiki/S3-Credentials)

These sources inform the candidate; the pinned-image source and actual CI
execution decide whether it satisfies this repository's unchanged requirements.
