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

Migration `0135_supreme_quasar` adds replacement previews and preparations, their
tenant/source keys, one-current-preparation constraint and immutable-history
guards. It extends the journal with preparation and cancellation receipts without
rewriting existing device, assignment or journal rows. Apply it through the same
deployment workflow before serving replacement routes; it does not add a new
working-device binary compatibility floor.

The two journal checks are added as `NOT VALID` in 0135: new writes are checked
immediately. Migration `0136_validate_working_device_events` validates existing
rows after the runtime runner commits 0135 and releases its writer-blocking table
lock. The runner retains its session migration lock across both transactions. If
validation fails, keep the committed schema and journal; diagnose the failure and
rerun the same runtime migration command. It resumes validation without replaying
0135 or losing history. Separate SQL files alone do not provide this boundary:
the ordinary Drizzle migrator groups pending files in one transaction.

Migration `0139_device_retention` adds retention previews, one current selection
per tenant and effective boundary, tenant-scoped selected membership and a
separate immutable event journal. It creates no initial choices and rewrites no
device, work or commercial records. The selected set and confirmed preview
receipt are committed together; replacing the current selection preserves every
earlier receipt. Apply the migration before serving retention routes.

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

## Replacement preparation

The cabinet and SaaS operator can prepare a replacement for a previously paired
Station or handheld. Select the source and enter the future device name/kind and
a reason. Preview reports the source observation, known server work and expected
eventual slot change. Saving the preparation itself consumes no additional slot.
An occupied source has an expected eventual net change of zero. A previously
paired source released by security revocation has an expected eventual increase
of one; preparation does not restore its revoked authority. Legacy pairing
evidence may come from the immutable assignment journal or authenticated use
recorded for migrated devices, even when the current pairing timestamp is absent.

Server shift/inventory references, retained print jobs and quarantine batches are
observations of retained server data. Local journals, outboxes and unfinished
printing remain explicitly unknown, even when the server has no work records or
the device has recently sent a heartbeat. No empty-queue attestation is inferred.

Confirmation stores a project in `prepared` state with its observation and a
durable receipt. It does not create the future device, release the old assignment,
issue a pairing code, revoke a credential or move work to another durable ID.
Execution is unavailable until the later authority-transition and recovery phase.
Preparing a project does not require a lifecycle policy or change catalog sales.

Only one current project may exist per source. Cancel the project explicitly to
prepare a different replacement; cancellation preserves the source and history.
Changed source, pool or commercial facts mark a saved project as needing review.
An ordinary new heartbeat alone does not invalidate an unchanged intention.

Before confirming, the server revalidates current access and preview facts. The
preview expires within five technical minutes or at the next entitlement boundary,
whichever comes first. An uncertain response must be retried with the same request
identity. A known stale response requires a new preview and explicit confirmation.
Historical successful receipts retain their original result after cancellation.

Use the ordinary licensing permissions: cabinet `credentials.manage`; platform
`tenants.read` for inspection and both `tenants.write` and `billing.write` for
changes. Read-only subscription status does not block preparation or cancellation.
These routes grant no enrollment or production authority.

## Retention selection at a reduction

The retention owner prepares an explicit complete set of working devices for the
nearest known future reduction. The server derives its exact boundary from dated
subscription, add-on and entitlement-source terms. A pending activation without a
date is not a scheduled reduction. Preview shows current and future rights,
occupied devices, known server work, existing ordered services and unknown local
queues. An included handheld module alone does not establish permission for
handheld work: use the server's per-device eligibility and execution reasons.
It is a calculation of proposed rights, not evidence that new enforcement has
been enabled.

Cabinet writes require both `credentials.manage` and `billing.request`. Platform
writes require `tenants.write` and `billing.write`; platform readers can inspect
without changing the choice. A read-only subscription or missing lifecycle policy
does not prevent saving intent, and does not prevent existing catalog sales.

The user supplies every retained device explicitly. Zero capacity permits an
empty set; unlimited capacity does not require a quota choice. Foreign, released,
duplicate or future-ineligible devices cannot be retained. Neither selected nor
unselected devices are deleted, revoked, re-paired or moved to another slot.

Preview and confirmation use one immutable request identity. After an ambiguous
response, retry the same intent with that identity; edits must wait for recovery.
A deterministic conflict requires fresh inspection, preview and explicit
confirmation. Cabinet and platform edit the same revision for the same boundary,
so a concurrent selection cannot silently replace another operator's choice.
If an old selected device becomes unavailable or disappears, explicitly start a
blank selection at the saved revision and review the new complete set. Inspection
never silently removes old selected IDs; original observations remain available.

Inspection uses a read-only repeatable-read snapshot. Mutation owners read current
facts after acquiring their quota, timeline and fact locks; a wait for another
operation must not pin an older snapshot. Preview freshness includes revisions,
while the saved intent's semantic comparison ignores ordinary passage of time
and scheduled-to-active lifecycle bookkeeping. It still detects changed terms,
device assignments and replacement preparations.

Inspect saved selections for stale pool or commercial facts and elapsed
boundaries. Their original observations and successful receipts remain historical
facts. Reaching the date does not automatically apply this preparation. An
awaiting-selection calculation is displayed separately from actual device access;
the server never chooses a subset automatically. If no valid choice applies, the
affected pool is explicitly shown as awaiting selection; a valid reached choice
with unselected devices is a different diagnostic state. P1C/P1D still own offline grant
durations, admission transitions and activation of commercial restrictions.

Before accepting the delivery, verify server-derived plan/add-on/source boundaries,
empty and full sets, tenant and actor isolation, concurrent revisions, unchanged
receipts after lost responses and preservation of all operational and financial
rows. Local browser fixtures verify interface behavior separately from live API,
deployment and physical-device acceptance.

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
