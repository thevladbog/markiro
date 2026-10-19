# Platform backup preparation verification — 2026-10-19

This durable record covers the four-task [plan](../superpowers/plans/2026-10-19-platform-backup-preparation.md).
It records local preparation evidence, not deployment or Timeweb acceptance.
Base `30d3e0338d66f2737e086c9e6038ca1d5c9b6bfc`, plan `6ebf38d0a`.
PR #734 was externally merged into PR #733's `codex/timeweb-host-delivery` branch;
#733 remained open when refreshed. This work performed no merge, rebase, server,
DNS or production-data mutation. Source and existing immutable backups remain intact.

## Implemented evidence

| Slice                            | Committed code                                                                       | Verification                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Bounded process groups           | `f5431cc85`                                                                          | 13 focused tests; 162 platform tests at that revision. Exact committed Linux ARM64 Node 24.18.0 run: 13/13. CLI process death is explicitly not daemon workload death.                                                                                                                                                                                                                                             |
| Separate credentials and roles   | `c8caed550`, correction `3ae70d98e`                                                  | 171 platform, 591 production contracts, 62 CI-policy, 30 focused API; API typecheck/lint/build and formatting passed. Hardened actual PG17.11 ARM64 probe passed: full migrations twice, pg-boss12.27.0 lifecycle, exact privileges/default grants, both-role TLS positive/negative checks, private stdin provisioning. Correction-focused 9/9.                                                                    |
| Archive and real restore         | `eca1cd9bc`, correction `e54fe3665f683aee9f494f2ff935d0024df1f137`                   | 210 platform, 36 focused backup, scoped lint/full formatting passed. Exact committed run28 passed at PG17.11 Linux ARM64, image `sha256:036e8de959a93c20c4fcc5cf37526e40fa2bb0e83844f7b32fe6cddd0abc3a95`. Actual migrations, pg-boss, custom snapshot dump, exact mapped restore, executable integrity negatives, reverse-order delegated ACL chain, corrupt/partial restore failures and owned cleanup verified. |
| Prepared target and journal gate | `3cf3e356b919eb14472ef93eb9c3ba49f228dd73` (review complete; final correction below) | RED: two expected missing-module failures. GREEN: 54 focused tests; 264 platform, 591 production contracts, 63 CI-policy. Final results are recorded below.                                                                                                                                                                                                                                                        |

Before the final review correction, the canonical inventory envelope was
1,015,851 bytes before its newline. The corrected format, actual file size and
headroom under the unchanged 1,048,576-byte limit appear below. Schema growth beyond the cap fails closed. Run28
archive was 1,286,207 bytes; archive lengths can vary with generated fixture values.
Archives stream in 64 KiB chunks; the metadata limit is not raised for dumps.
Completed producer reports require actual owned-resource absence, while the action
boundary requires inspection of the exact exited migration container.

Task 4 local integrated run1 passed with PG17.11 Linux ARM64 and worker image
`sha256:31ae3bd60da4900574cabd54f687f1c1f7a90a98a5ea8285a91f2b83124d5caf`.
This was a dirty-tree development run; its recorded HEAD is not an exact source
attestation. It proved CLI timeout with the workload still active, independent
owned stop/inspection, released-fence rejection and terminal recovery preservation.
Scoped ESLint, full repository formatting and git diff --check passed.
Exact committed run2 passed at `3cf3e356b919eb14472ef93eb9c3ba49f228dd73`,
PG17.11 (Debian 17.11-1.pgdg12+2), Linux ARM64, worker image
`sha256:bbba17e9c5c9b14f858aef3657119e94ee2e12ff8f4c25af3e39b8448ea01493`.
It repeated actual custom dump/isolated restore, mapped ACL/executable fidelity,
corrupt archive rejection, actual partial restore failure/cleanup, and the complete
CLI/workload/fence/journal timeout sequence. Archive 1,286,208 bytes, inventory
1,015,851 bytes, two intentional NOT VALID constraints preserved. Current-run
owned resource cleanup passed. No target AMD64 or live acceptance follows.

Reproduction uses Node24 and repository Corepack pnpm, without installing:

```sh
node --test deploy/platform/test/backup-gate.test.mjs deploy/platform/test/prepared-target.test.mjs
node --test deploy/platform/test/*.test.mjs
corepack pnpm test:production-bundle:contract
corepack pnpm test:ci-policy
corepack pnpm format:check
node deploy/platform/backup/backup-ci.mjs --local-ci
```

Implementation-commit outputs: focused54/54, platform264/264, production591/591,
CI-policy63/63, all without skips; scoped ESLint, full formatting and diff checks
passed. Exact Docker evidence above belongs to `3cf3e356b`; the later time-predicate
correction below has its own automated coverage. Final independent review completion is recorded below. Publication remains
controller-owned and is separate from merge/deployment acceptance.

### Task 4 review correction: final freshness boundary

Independent review found that backup start and restore completion could age past
`maxAgeMs` while asynchronous workload/fence inspectors ran. The final boundary
already rechecked prepared observations and TLS, but omitted these two older
timestamps. Both freshness predicates now run again at final `checkedAt`, committed in
`4cf504a10cee72dfb821bd96797fddb280903086`.

Two deterministic clock regressions first pass full validation, then advance time
inside the fence adapter: backup-only expiry keeps the restore report fresh; the
restore-expiry case keeps all prepared observations fresh (the backup must be at
least as old by producer chronology). Both reject without completing
`backup-verified`. RED: 39 passed, two expected failures. GREEN:
`node --test deploy/platform/test/prepared-target.test.mjs` 41/41 and complete
`node --test deploy/platform/test/*.test.mjs` 266/266, no skips. Scoped ESLint,
Prettier and diff checks passed. Docker, production/CI contracts and full API were
not rerun for this two-predicate correction; their earlier evidence and limits
remain tied to the revisions stated above.

### Final review correction: independent schema semantics

The final review found that PG17 table-column NOT NULL, defaults, types and
identity/generated definitions did not participate in independent equality. The
corrected inventory stores one canonical semantic SHA256 per relation, including
ordered live columns, resolved types/typmods/collations, nullability,
default/generation expressions, identity/generated flags, relation kind/options,
partition key/bound/parents and view query. Physical dropped-column gaps are
excluded; logical order remains. Enum label order, domain base/default/nullability
and domain-bound named constraints, and sequence generation parameters/ownership
are fingerprinted. Other custom type kinds fail closed except the trusted
version-matched btree_gist base types, whose catalog semantics and resolved
function identities are captured. Native extension binaries remain trusted.

The original verbose key pushed the actual worker inventory result to 1,049,133
bytes and was rejected by the unchanged 1 MiB ceiling. The approved private format
correction consistently shortens only definition fingerprint keys from
`definitionSha256` to `sha256` on objects/indexes/constraints/triggers. Hashes
remain lowercase 64-hex SHA256. Archive/configuration API names and row digests
are unchanged. Exact validators reject previous local artifacts; regenerate them.
No older artifact is silently reinterpreted and no limit was raised.

RED: all 17 initial catalog regressions failed on the previous implementation.
The new catalog suite now has 19 passing cases, including explicit old-key
rejection and domain-local CHECK binding. A restore regression rejects a changed
column fingerprint, verifies cleanup and forbids completed evidence.
The guarded source-only PG17 probe separately rejects 25 transactional mutations:
NOT NULL and removed/changed defaults on station/kiosk credential_epoch and station
security_revocation_revision; view query, enum labels, domain null/default,
column type/typmod, generated/identity state, partition bound and all seven
sequence generation parameters. Rows, journal, owners and ACLs remain unchanged;
all changes roll back before backup. Domain NOT NULL also removes its exact named
pg_constraint row on PG17; that expected delta is asserted, then original
constraints are substituted to independently prove definition-hash rejection.

Development run4 passed the complete synthetic dump/restore, mapped ownership and
ACL chains, current security executable integrity, corrupt/partial archives and
owned cleanup, plus CLI-death/active-workload/owned-stop/released-fence/terminal-
recovery gates. It used PG17.11 Linux ARM64, worker
`sha256:d01abc97e5295ba839dfb9bba788a8671bd911fe70e2526f095f0eccba5b0fbf`.
Raw inventory 1,018,161 bytes; logged canonical envelope 1,019,905 bytes
(excluding its final newline). Actual file size and cap headroom are recorded below. Archive 1,288,089 bytes; two intentional NOT VALID
constraints retained. This is development evidence: its recorded base HEAD is not
an exact-code attestation; the final domain-local constraint refinement was not yet present
in that development run. The following exact committed run supersedes development evidence.

Final code commit `3b72654d63c0cea5793e83c0d8135a32d00f6e9f` passed
`node deploy/platform/backup/backup-ci.mjs --local-ci` with exit 0. Worker image
`sha256:7273c91447413fc23c64ead9bddbcb260690f2fb5a38a4749c2f1e8e37a80836`,
PG17.11 (Debian 17.11-1.pgdg12+2), Linux ARM64. It includes the final domain-local
constraint refinement, all 25 source-only semantic negatives, current security
function/trigger negatives, exact mapped restore equality, delegated ACL chains,
corrupt/partial failure cleanup and all five CLI/workload/fence/journal gates.
Archive 1,288,089 bytes; raw inventory 1,018,161; canonical envelope 1,019,905.
Independent stat of the operation-bound private inventory.json confirmed
**1,019,906 file bytes including its newline**, leaving **28,670 bytes** below the
unchanged cap. Two intentional NOT VALID constraints remain preserved.
Operation `072edc4f-416a-4e3f-a41d-2abfde128a53`; source/container/volume/network and
producer resource absence was verified. This is exact-code local evidence only.

Final automated checks: catalog 19/19 and full platform 286/286, zero skips;
scoped ESLint, full repository formatting and diff/staged checks passed. Earlier
backup/prepared-target focused 111/111 preceded the last domain-binding test; the
complete platform result includes that final test. The initial sandbox-wide run
failed because local process/listener operations were restricted; the authorized
local run passed without changing assertions. Full API was not rerun for this
backup-only correction because the isolated DB/auth environment remains absent.
Production contracts and CI-policy workflows were unchanged; their earlier
591/591 and 63/63 evidence remains tied to its stated revision, not a fresh run.

The original final review's P2 is closed. The independent scoped rereview approved
this correction with no new Critical/Important findings; it awaited the exact
integration run when written, and that run is now complete as recorded above.
Applicable remote/current-source CI and all operational acceptance gates remain
outstanding; this does not authorize merge or deployment.

Local evidence logs: `/private/tmp/final-fix-harness-committed.log`,
`/private/tmp/final-fix-metadata-size.json`,
`/private/tmp/final-fix-final-platform.log`,
`/private/tmp/final-fix-final-lint.log`,
`/private/tmp/final-fix-final-format.log`, and
`/private/tmp/markiro-backup-final-rereview.md`.

## Decisions and consequences

1. Grant CREATE on the specific `markiro` database only to migrator because real
   PG17 returned 42501 for Drizzle's CREATE SCHEMA IF NOT EXISTS even with a
   precreated schema. The user explicitly approved code/local-test scope. This is
   not CREATEDB; API database CREATE and role membership remain denied. If the
   assumption changes, migration bootstrap/CLI must be revisited before deployment.
2. Add strict default-false `PLATFORM_PGBOSS_PREPROVISIONED_SCHEMA`; only compact/CI
   uses `createSchema:false`. Real pinned pg-boss otherwise failed 42501. Queue-local
   DDL remains enabled; existing default behavior stays unchanged. Deployment needs
   a newly built, published and admitted API image; prior images cannot be assumed
   compatible. Cost of revision: explicit API/config compatibility work.
3. Use one focused private-SQL stdin adapter under PostgreSQL identity. Root chown
   under cap-drop ALL failed the hardening contract. Cost: adapter consolidation if
   a future executor differs, without relaxing capability restrictions.
4. Retain full API infrastructure failures as an incomplete gate, without shared
   credentials or unrelated test changes. Cost: dedicated CI/integration evidence
   and any resulting fixes before merge, not a claim of a green package suite.
5. Restore with no-owner/no-acl, exhaustive role mapping and structured ownership,
   grants/default ACLs. Only explicit privilege-reducing attributes/memberships may
   change. Unsupported catalog surfaces fail closed. Cost: reviewed catalog support
   before real-source rehearsal, not implicit privilege replay.
6. Separate snapshot, file, schema, worker and local resource responsibilities;
   use installed dependencies and PG17/Node24 local image with unique ownership.
   Cost: small module consolidation and local image disk space; no production
   acceptance or new dependency is implied.
7. Preserve intentional NOT VALID constraints exactly and report their count;
   invalid/not-ready indexes reject. Cost: explicit operator handling before live
   rehearsal; no claim that every source constraint was validated.
8. Hash canonical index/constraint definition bytes instead of storing full DDL,
   preserving typed identities, validity and structured actionable ACLs. Original
   current-schema metadata exceeded 1 MiB. Cost: future explicit format work if
   growth again exhausts the cap; no implicit sharding or cap increase.
9. Temporarily grant only exact-schema USAGE to mapped grantors within isolated
   restore, revoke it explicitly, and restore exact schema ACLs last. Source
   superuser implicit access disappeared after approved role lowering (42501).
   Final inventory must prove no residual grants. Cost: restore ordering rework.
10. Hash `pg_get_constraintdef(oid,true)`, matching pg_dump canonical deparse.
    Real PG17 showed nested AND/BETWEEN formatting differed with false and matched
    with true. Changed-definition tests remain; no regex/literal normalization.
    Cost: another explicit canonical representation review if PostgreSQL changes.
11. Bind exact function/procedure and trigger definitions/enabled states; replay
    delegated grants in prerequisite order; validate every nested inventory shape
    and exact mounts/networks. These reviewed corrections close executable and
    ACL fidelity gaps; unsupported definitions remain errors.
12. Prepared target v1 is async and rehashes actual archive and both config files.
    Canonical configuration domain includes version, kind, candidate ID and both
    hashes. Separate target PG digest from restore worker image ID. Bind every
    observation to operation/target/executor/fence/config/snapshot and expected
    producer; retain measured versus operator-attestation provenance. Freshness is
    explicit positive at most 24 hours; live fence/workload at most 30 seconds,
    never future-dated. Cost: future adapters must implement this exact reviewed
    contract or a versioned replacement; there is no caller-shape shortcut.
13. Require exact owned container ID/name/label and independently inspected exited
    state; absent/unknown reject. A stopped workload cannot clear recovery-required.
    Integration is local only in the existing synthetic harness, with no public
    deployment CLI or generic remote orchestrator. Cost: future orchestration must
    call the gate immediately before every protected action; low-level journal
    shape validation does not enforce that integration itself.

14. Reuse the existing linked worktree and scoped installed dependencies instead
    of creating another checkout or installation, preserving disk and unrelated
    work. Cost if unsuitable: a later isolated rebuild, not a lockfile/policy bypass.
15. The generic runner accepts only explicit plain own-string environments and
    never inherits ambient variables; Docker callers retain hostChildEnvironment.
    TERM and KILL/reap bounds are 2,000 ms each; confirmation needs child close
    plus process-group ESRCH. Cost: a stricter caller-specific wrapper if needed;
    these checks say nothing about a daemon-owned container's lifetime.
16. Keep runtime snapshot's interpolation subset, but require combined validated
    migration-snapshot interpolation at hostChildEnvironment; Task4 hashes both.
    Split roles-ci local resource lifecycle from roles-probe DB assertions and
    update Compose/CI consumers together. Cost: future caller adaptation or small
    helper consolidation before the host CLI, without weakening credential isolation.

17. Extend independent definition equality to ordered semantic columns, views,
    enum/domain/sequence and supported partition definitions. Resolve catalog
    identities to names and retain the pinned-extension trust boundary. Bind
    domain constraints inside their domain hash; no generic clone expansion or
    SQL-text normalization. Cost if the representation is wrong: explicit
    canonical-format/support revision and a renewed real restore before live use.
18. Keep the 1 MiB ceiling and exact validation by shortening only private
    definition keys to `sha256` after the measured 1,049,133-byte rejection.
    Preserve the 64-hex algorithm, every semantic field and archive/config/row
    APIs. Cost if revised again: regenerate old unpublished local evidence;
    any published consumer requires an explicit versioned migration, never
    silent reinterpretation.

## Limits and outstanding acceptance

The full API suite in Task 2 was infrastructure-incomplete: 13 failed / 256 passed /
203 skipped files; 1 failed / 2,299 passed / 2,703 skipped tests. Diagnostics were
missing DATABASE_URL or platform auth fixture settings, explicit isolated-PostgreSQL
requirements and secondary cleanup failures after DB setup failed. Focused API30,
API type/lint/build and the real role probe do not replace that integration gate.
The broad API suite was deliberately not rerun with shared or production settings.

Actual local Linux ARM64 PostgreSQL evidence is not Linux AMD64 target proof,
2-vCPU/4-GiB capacity proof, live production-data recovery or Timeweb acceptance.
No live SMTP/S3, actual key continuity, independently recoverable off-host copy,
physical target mapping, independently enforced live writer fence, source-provider
ACL rehearsal, operator acceptance, public TLS/DNS or customer acceptance was run.
Measured PG/TLS record matching in the library is not a hardware probe/TLS handshake;
those observations and role-policy hashes require trusted producers. No synthetic
record can satisfy an expected live-source gate. Synthetic operator attestations
explicitly carry no live acceptance.

Protected SSH/workflow, exact host command orchestration, bootstrap and full actual
Timeweb rehearsal remain the next delivery stage. Current-source API image CI stack
and compact-load were not rerun locally; existing images predate the new opt-in.
No browser, hardware, Windows or physical printer validation applies to this slice.

Cleanup verified each current run's named/labelled resources. Earlier experimental
anonymous volumes cannot be attributed after old containers were removed; they were
not inspected or globally pruned. The latest exact-code worker image
`sha256:7273c91447413fc23c64ead9bddbcb260690f2fb5a38a4749c2f1e8e37a80836`
is retained with its exact operation label and zero container references. The
existing scoped cleanup helper matched image IDs to the private operation ledger,
checked actual labels and zero references, then removed only obsolete images:
previous accepted `bbba17e9...`, development `d01abc97...`, and failed development
`e231a78e...`, `e877a19e...`, `dd3adcb7...`. All five removals were verified.
Thirty label-scoped resource checks across those five operations and the final
operation found zero remaining fixture containers/volumes/networks or producer
containers/volumes. Evidence: `/private/tmp/final-fix-owned-cleanup.json` and
`/private/tmp/final-fix-owned-cleanup.log`. No force removal, global prune,
unknown-volume deletion, base-image deletion or old backup archive deletion occurred.
Earlier task-specific cleanup remains historical evidence in its original logs;
these checks do not establish global Docker cleanliness.
