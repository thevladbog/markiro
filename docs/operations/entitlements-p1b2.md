# Working device reservations: rollout and recovery

Station and handheld share the `stations` quota. The server maintains one current
assignment per tenant/device and an immutable transition journal. Cancellation
releases a never-paired reservation without security revocation or credential
removal. Kiosk quotas and catalog sales retain their existing behavior.

## Data preparation

Migration `0133_futuristic_venom` observes every existing station/handheld device.
A revoked device is observed as released for security; otherwise pairedAt or an
existing key means assigned; otherwise the device is reserved. Observation time
is migration time, not a reconstructed purchase or enrollment time. Existing
station device rows, including contradictory historical values, are preserved.

Migration `0134_working_device_actor_identity` requires an actor ID for cabinet,
platform and device events. Migration observations and system events retain their
nullable actor identity. This forward constraint change does not rewrite journal
records or the already-applied migration 0133.

Before rollout, save a database backup through the existing production procedure.
Apply the migration through the existing immutable-image deployment workflow.
Compare each tenant's pre-migration `station_devices WHERE revoked_at IS NULL`
count with its initial non-released assignments, and verify one migration event
per observed device. Runtime migration reruns must not create observations again.
This legacy comparison is valid for the migration boundary only: after the first
commercial cancellation the old counter is intentionally different and must not
be used for quota enforcement or acceptance.

## Assignment integrity

The API must switch every current writer and count reader together: device
creation reserves a slot, successful pairing assigns it, security revocation
releases it, and authorized re-pairing reacquires quota. The quota reader,
entitlement projections and platform usage must all use the shared assignment
reader. No separate Station/handheld API fleet may keep the legacy counter.

Missing or contradictory assignment records do not create free capacity. The API
must report an inconsistent pool and disable cancellation for that tenant until
facts are diagnosed. Completeness of database rows alone does not prove that the
running server fleet supports every writer and the assignment-based counter.
The deployment compatibility check described below is a separate gate.

Do not repair a pool by deleting history, setting revoked_at, silently releasing
assignments or treating missing heartbeats as proof of a free reservation.
Inspect the device, its current assignment and journal, pairing/key facts and
production references; retain the original evidence and use a separately reviewed
repair when needed. Existing offline journals and device identities remain intact.

## Cancellation acceptance

Inspect through the authenticated cabinet/platform routes. A reservation must be
reserved, never paired, keyless, without production references, and in a complete
consistent tenant pool. The caller needs the existing credentials/platform
capabilities. The server derives the tenant and actor; requestId and expectedRevision
are the only cancellation body fields.

Confirm that the saved receipt is replayed for the same actor/request/payload,
that usage decreases by one, the live pairing code is retired, device/credential
fields are unchanged, and journal/audit entries identify the exact actor and result.
After cancellation, old code claim, code issuance and legacy recovery must fail.
A stale revision or changed retry intent conflicts and requires fresh inspection.
Security revocation and authorized re-pairing remain distinct operations.

## Recovery boundary

Once a commercial cancellation exists, binaries that count only revoked_at are
incompatible with retained data. Do not roll back to those API images, undo the
migration, delete the cancelled assignment or restore old device data over the
journal. Recover with a compatible reviewed image while preserving the database.
Ordinary rollback success, a healthy HTTP endpoint, or a green historical image
build does not prove working-device compatibility.

Production deployment, installed server image inspection, browser checks and
physical scanner/Windows recovery are separate acceptance results. Local contract
and PostgreSQL tests are not evidence that production was updated.

## Enforced image compatibility floor

The updated `Deploy production` workflow accepts dispatch on `main` and checks
out its exact `github.sha` for trusted deployment tooling. The selected product
release remains independently bound to the successful main publication run,
manifest commit and API/edge digests. Record both the workflow/tooling SHA and
product release SHA; they may differ. An old target release cannot select its old
deployment scripts through this workflow.

Every candidate and rollback API image must satisfy `working-device-assignments-v1`.
This technical floor applies before the first cancellation too: an old writer
would stop maintaining the assignment projection even before any reservation is
released. It adds no subscription, catalog sale or lifecycle-policy requirement.
The floor avoids a race between checking the first cancellation and switching to
an incompatible API. No declarative environment flag enables cancellation.

The final API Docker image contains `/opt/markiro/working-device-compatibility.mjs`;
its image build executes that probe against the final packaged runtime. Deployment
runs the probe again from the exact immutable API digest with network disabled,
a read-only filesystem, dropped capabilities, and no database or secret environment
injected. The probe imports the compiled assignment implementation, requires its
reader/writer exports and checks missing/reserved/cancelled/security-released
occupancy and terminal cancellation behavior. An absent probe, failed behavior,
nonzero exit or a response other than the exact v1 receipt rejects the image.
It is a bounded executable compatibility contract, not proof of every application
path; API writer/reader regression tests remain a separate release gate.

`prepareRelease` and direct `deployRelease` run the check before migration and API
replacement. `rollbackPreparedRelease` checks the previous image before restarting
services. A rejected rollback leaves the current services in place and reports
failure; recover with a compatible image. The first v1 rollout therefore cannot
automatically recover to a pre-v1 image if its later smoke fails. Prepare a reviewed
compatible recovery image and preserve database backups before that rollout.

Before enabling operational use of cancellation, verify these independent facts:

1. The approved main deployment tooling contains the v1 floor, the selected digest
   passes the executable probe, and all server API instances run that same supported
   release through the owning Compose deployment. A healthy legacy instance is
   incompatible. Multiple independently managed API writers need their own verified
   coordinated rollout; tenant row completeness cannot establish fleet readiness.
2. Runtime migration 0133 completed and the initial migration-boundary comparisons
   above passed. Later runtime retries add no observation rows.
3. The server's authenticated inspection reports a complete consistent tenant pool;
   cancellation remains disabled for missing/contradictory assignments. Verify
   authorized cancellation and terminal pairing rejection on the accepted release.
4. Use the updated main workflow for every future deploy/rollback. Historical
   workflow re-runs, historical scripts and manual Docker starts do not contain
   this gate and are prohibited operational recovery paths. Production environment
   protections must continue to restrict deploy authorization to the approved main
   workflow; this change does not alter GitHub environment settings or host privileges.

The branch includes local tests of the concrete candidate and rollback commands,
rejection before switching, exact capability receipts and workflow source binding.
Running those tests does not inspect the currently installed production fleet.
