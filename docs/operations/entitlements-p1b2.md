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
earlier receipt. Complete migration 0139 before deploying any code that reads
`workingDeviceRetentionSelections`, including the existing replacement paths;
merely keeping retention routes disabled does not satisfy this prerequisite.

The retention release changes replacement fingerprints incompatibly, even when
there are no retention selections. Existing prepared replacement items become
`needsReview`; existing unconfirmed previews and their retries receive stale
conflicts and require a fresh review. Historical successful confirmation receipts
remain available unchanged.

Migration 0140 adds the tenant/device membership index used by ordered selection
reads. Apply it through the same deployment migration flow.

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
Execution uses the drain/emergency protocol below; a saved preparation alone does
not restrict current source admission.
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

## Executing a replacement

Execution extends preparation; it does not migrate a local database onto a new
machine. The source keeps its durable identity and historical evidence. The target
gets a new device ID and reserved assignment. For an occupied source the transfer
uses the same one working-device slot. A source already released for security needs
available capacity; the saved preparation is not a reservation of future capacity.

| State                | Operational consequence                                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prepared`           | No source admission change, credential revoke or extra slot.                                                                                            |
| `draining` / `ready` | New source work and grants are denied; existing evidence, closure and recovery continue. `ready` is a current projection, not a permanent certificate.  |
| `executing`          | Cutover is committed and cannot be cancelled. Retry/repair resumes credential revocation and transfer. No target authority before confirmed revocation. |
| `completed`          | The source assignment is terminal `replacement_transferred`; the target is stable across retries. Inspect `newWorkAllowedAt` and recovery separately.   |
| `cancelled`          | History remains. A source which persisted drain resumes only after its exact cancellation acknowledgement is committed locally.                         |

### Rollout and minimum compatible builds

1. Record the database restore point, approved source SHA, API/edge image digests,
   and intended Station/Handheld artifacts. Keep all journals and pending evidence.
2. Apply the full runtime migration chain through the replacement repair scheduling
   migration `0167_device_replacement_repair_schedule` **before starting API readers**, including the repair worker.
   `0162_device_replacement_execution` adds intents/reports/executions;
   `0163_validate_device_replacement_execution` validates additive constraints after
   0162 commits; `0164_device_replacement_closure_ack` preserves cancellation ACKs;
   `0165_device_replacement_execution_preview` stores actor-bound execution previews;
   `0166_device_replacement_capabilities` retains epoch-bound capability observations;
   `0167_device_replacement_repair_schedule` adds durable retry timing and the due-row
   index while preserving execution transition and completion guards.
   Use the runtime migrator, which retains its migration lock across validation
   transaction boundaries. Never rewrite applied migrations or run manual down SQL.
3. Deploy the compatible API while old native clients remain accepted. The
   protected `release-images.yml` produces API and edge from the same source SHA;
   `deploy-production.yml` uses that exact release run/SHA and immutable digests.
   `compose.production.yml` makes API startup depend on successful migration;
   the staged deploy runner also runs migration before switching API and edge.
4. Upgrade Station and Handheld before enabling ordinary replacement for a source.
   Minimum capability is durable `replacement-readiness-v1` polling/ACK support,
   `replacement-boundary-v1` target pairing and
   `replacement-evidence-recovery-v1` same-owner recovery. Station requires this
   branch's complete SQLite migration list; Handheld requires Room v17 plus the
   recovery/authority changes. Deploy the complete artifact, not individual JS,
   Kotlin or SQLite files.
5. Deploy Cabinet and SaaS with the matching strict replacement contracts. Both
   are in the **edge** image; neither is a separate production image. Station
   artifacts use `station-beta-release.yml` and promotion through
   `station-stable-release.yml`; Handheld APKs use `handheld-release.yml`.
   No Station or Handheld binary is installed by an API/edge deployment.
6. Verify the native source's current capability evidence, a fresh readiness report
   and the exact accepted artifact SHA before ordinary cutover. On a designated
   test tenant exercise pairing, drain/cancellation, normal cutover, emergency wait
   and source recovery. Record production and physical results independently.

There is **no published numerical minimum version established by this branch**.
The checked-in native manifests still default to `0.1.0`; those labels alone cannot
prove support. Release acceptance must bind the tested source SHA to signed
Station/Handheld artifact manifests and installed client capability evidence.
Old web clients must be refreshed before using new execution states; the extended
strict contract is not a promise that an old web decoder accepts every new state.
Legacy prepared/cancelled rows remain parseable and their original bytes survive
forward migration.

Drain uses a dedicated authenticated polling route; the server does not add a
command to legacy native response payloads. Ordinary drain requires recent
capability evidence from the same source credential epoch with a **5-minute server
TTL**. An authenticated intent-v1 poll lacking `replacement-readiness-v1` immediately
records unsupported, so an online downgrade invalidates the earlier claim. Missing, stale or
old-epoch evidence produces `client_upgrade_required` before creating an intent
or changing source admission. A disconnected/downgraded client cannot reuse
indefinite historical capability evidence. Emergency preview remains separate.
Tenants without a requested replacement keep their existing admission and
subscription rules; inactive/unmanaged access expands only for explicitly
allowlisted evidence recovery.

### Ordinary replacement playbook

1. Confirm tenant, source device ID/kind and target name/kind in the equipment
   workspace. Refresh access and the current preparation; saved server-work
   observations are historical and local values are unknown until measured.
2. Upgrade/reconnect an unsupported source, then request drain. The source persists
   drain before acknowledging and keeps it across restart. Stop creating new work;
   use existing close/sync/reconciliation screens to finish accepted work.
3. Inspect every measured pending channel (scans, inventories, shift closures,
   product labels, boxes, exceptions), conflicts, unknown printing, active tasks
   and retained grants. `unsupported` is not zero. Server work and quarantined
   native receipts can block even when all local counters are zero. Resolve facts;
   never delete a queue or history to manufacture readiness.
4. Readiness report freshness is **60 seconds** and a drain intent lasts **5 minutes**.
   Renew a stale intent and retain pending exact request bodies. Heartbeats alone
   are not an empty-store attestation. Admission remains blocked until an explicit
   authenticated cancellation/closure acknowledgement, never a null poll result.
5. Obtain a fresh execution preview (60-second lifetime), then confirm the same
   request ID, preview ID and expected preparation revision. Changed facts require
   a new preview; a lost response requires an unchanged retry.
6. After the completed receipt, issue the target's ordinary pairing code. Pair the
   target using its new local store. Confirm target ID, assignment and authoritative
   wait boundary; do not assume even a normal downstream replacement can shorten
   an earlier emergency wait.

Before cutover, cancellation retains all local/server evidence. After `executing`
starts, cancellation is forbidden even if the HTTP response was lost. Repair uses
that committed intent and the original actor; it never creates a second target.

### Emergency replacement and waiting target

Use emergency only with explicit acknowledgement and a trimmed reason (1–1000
characters). Cabinet requires `credentials.manage`; platform requires current
`tenants.write` and `billing.write`. Both revalidate the current principal.

The source cloud credential is revoked before target publication. The server
retains the maximum authoritative offline deadline, including unexpired grants
from earlier source credential epochs and any inherited upstream target fence.
Unknown issuance uses the approved policy's conservative maximum; absent safe
policy facts fail closed with `device_replacement_offline_boundary_unknown`.
A client clock or claim that local grants were removed cannot shorten this time.

A capable target can pair immediately and persist `newWorkAllowedAt` before
publishing its credential/configuration. Until that boundary it can inspect and
recover, but cannot create shifts, inventory, write-offs or new grants, including
observe mode. Waiting-target evidence is retained/quarantined with its original
classification, so a later retry cannot turn an earlier prohibited operation into
new work after the clock passes the boundary. Pairing success alone is not work
admission or proof of installation on the physical target.

Emergency receipt starts recovery as `required`. Keep the warning until recovered
or explicitly closed as evidence unavailable. Never copy the old store onto the
target, rebind old evidence to the new ID, or reconstruct missing facts as zeros.

### Source evidence recovery

Issue a recovery code for the **old source**, not the target. Codes use the common
short-lived one-time pairing policy; plaintext is displayed once with `no-store`
and is absent from saved receipts/audit. A lost response needs a fresh issuance
request and current execution revision; the previous live code is retired.

Redemption requires `replacement-evidence-recovery-v1` and the sealed source's exact
server origin, tenant, device ID and kind. Recovery does not reacquire a slot or
unrevoke ordinary source authority. Its credential has purpose
`replacement_evidence_recovery`, current epoch/execution binding and bounded
24-hour expiry. Every request reloads that binding and is deny-by-default.

Allowed handlers read identity/verifier keys, upload retained evidence, return
acknowledgements, close/leave existing work and publish recovery readiness.
New task selection/start/join, allocation, productive grants, catalog mutation and
credential issuance are denied. Expired/unmanaged tenants can use only those
explicit recovery handlers. First-delivered facts without pre-cutover proof remain
quarantined (`unproven_pre_replacement_evidence` or the route-specific
`unproven_pre_drain_scope`); exact already-committed receipts replay their original
outcome. Evidence retention is not automatic acceptance of new business effects.

Native recovery retains sealed operator verifiers for permitted login, journals,
outboxes and saved print bytes. Station's saved-label recovery opens only the exact
retained job, never a productive shift; transport uncertainty requires physical
verification/reconciliation, not automatic resend. Wrong-owner recovery seals the
store and refuses reattachment. A fresh eligible zero report closes recovery and
revokes the limited key atomically. Loss of that response may leave a sealed client
with a pending exact request; it does not reopen source work.

If the source medium is lost, close as `evidence_unavailable` with a separate reason
and expected **execution** revision. This creates an audited incompleteness fact,
not a synthetic zero report or a claim that all evidence was recovered.

### Repair and observability

The API's registered `DeviceReplacementExecutionRepairService` scans committed
due `executing` rows on startup and every **30 seconds**, at most **100** per pass.
Due time is `COALESCE(next_repair_at, started_at)`; ordering by that time, original
start and execution ID lets failed work and new executions advance fairly.
A failure records `repair_attempts`, `last_repair_at` and `next_repair_at` in the
execution aggregate and advances its revision. Backoff starts at **30 seconds**,
doubles and is capped at **one hour**; it survives restart. A failed old batch
therefore cannot monopolize every scan. An atomic comparison on the prior attempt
count/time lets only one replica advance the schedule for the same failed pass.

A process never overlaps its own scans; shutdown stops new passes and waits for
the running pass. Replicas and manual repair reuse existing quota/fact locks,
confirmed revocation and unique execution/target constraints. Empty passes are
quiet. Completion retains any retry history and its immutable receipt.

Structured log events are `device_replacement_repair_completed`,
`device_replacement_repair_pending` (with execution ID), and
`device_replacement_repair_scan_failed` (whole scan failed). No raw errors,
credentials, pairing codes or journal bodies are logged. Alert on repeated scan
failure or growing age/count of due executions. Compare due time and attempt
history before intervening. Persistent failures still need their underlying
capacity/evidence/infrastructure issue resolved; unrelated executions continue
through later due passes.

On a trusted maintenance host/container running the **approved API image**, use
the supported compiled CLI with its normal secure environment already loaded:

```bash
node dist/cli/repair-device-replacement.js "$REPLACEMENT_TENANT_ID" "$REPLACEMENT_PREPARATION_ID"
```

In a built source checkout the equivalent is
`corepack pnpm --filter @markiro/api repair:device-replacement "$REPLACEMENT_TENANT_ID" "$REPLACEMENT_PREPARATION_ID"`
The compiled
command accepts exactly two arguments and exits 0 with execution/target IDs only
on completion; exit 1 leaves the case for investigation/retry. It resumes only an
existing committed execution, never prepares or starts one. This targeted command
bypasses `next_repair_at`, so a corrected case can be resumed immediately without
editing retry metadata. Run it under the
existing production-maintenance approval procedure; no public repair route or
new production-access mechanism is introduced. Do not place database secrets in
arguments or paste raw query results containing payloads.

Use read-only SQL with a bound tenant parameter for diagnosis:

```sql
SELECT id, preparation_id, device_id, state, step, mode, revision,
       target_device_id, started_at, credential_revoked_at,
       new_work_allowed_at, recovery_state, recovery_closed_at,
       repair_attempts, last_repair_at, next_repair_at,
       COALESCE(next_repair_at, started_at) AS repair_due_at
FROM working_device_replacement_executions
WHERE tenant_id = $1
ORDER BY started_at;

SELECT device_id, credential_epoch, supported, observed_at, expires_at
FROM working_device_replacement_capabilities
WHERE tenant_id = $1
ORDER BY device_id, credential_epoch;

SELECT preparation_id, id AS intent_id, credential_epoch, state,
       requested_at, expires_at, closed_at
FROM working_device_replacement_readiness_intents
WHERE tenant_id = $1
ORDER BY requested_at DESC;

SELECT preparation_id, intent_id, credential_epoch, report_sequence,
       storage_revision, received_at, eligibility
FROM working_device_replacement_readiness_reports
WHERE tenant_id = $1
ORDER BY received_at DESC;

SELECT device_id, state, release_reason, revision
FROM working_device_assignments
WHERE tenant_id = $1
ORDER BY device_id;
```

Correlate IDs with the equipment workspace, immutable working-device events and
cabinet/platform audit. `revoke_pending` means retry revocation; `credential_revoked`
means revocation is confirmed but transfer has not committed. Investigate current
capacity/handheld entitlement and server evidence blockers before retrying. Do not
edit execution rows, release assignments or issue a new source credential as repair.

### Rollback limits

Before any drain/cutover, a compatible API/web rollback can preserve prepared rows.
After drain starts, the API/client set must still understand durable intent,
cancellation ACKs and admission fences. After execution begins, finish it with the
compatible repair implementation; never restore the source's full credential or
undo `replacement_transferred`. Retain every migration, intent/report, execution,
code hash, event, grant and native journal. An older API that lacks target waiting
or restricted recovery is not a safe rollback candidate merely because it passes
the older working-device-assignment image probe.

A database restore after cutover cannot revoke already-issued credentials or undo
physical factory actions. Treat it as an incident requiring authority and evidence
reconciliation across all devices. Never install an older writer against a newer
SQLite/Room store, or delete native data to force startup. Signed artifacts,
Windows/TSD/scanner/printer checks and CHZ/1C acceptance remain separate release
criteria; see [the acceptance record](../acceptance/device-replacement-execution.md).

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
