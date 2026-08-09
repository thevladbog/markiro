# Rehearse Yandex SaaS recovery

Run each drill in an isolated recovery scope. Preserve production evidence and
never replace a live database, state object, or media object during a drill.
Record observed RTO/RPO and cleanup confirmation in the protected operational
system; never store resource IDs, output, or evidence in Git or chat.

## Prepare an isolated recovery drill

<!-- runbook-contract:recovery-prerequisites -->

1. Open an approved incident or drill record. Name a recovery lead, data owner,
   and independent verifier.
2. Identify the target timestamp, expected recovery point, authorized recovery
   scope, and stop condition. Confirm production writes remain isolated.
3. Use a distinct temporary PostgreSQL cluster, media prefix or bucket, state
   copy location, and VM name. Do not reuse live identifiers.
4. Use protected console or broker access. Disable tracing and do not print
   Lockbox payloads, Terraform state, plans, Compose renders, or database dumps.

## Restore PostgreSQL to a temporary point in time

<!-- runbook-contract:recovery-postgres-pitr -->

1. In the approved Yandex PostgreSQL administration surface, create a temporary
   PITR restore at the selected timestamp. Do not target the production cluster.
2. Create the application owner through the approved database surface and load
   only the temporary connection data into a temporary protected Lockbox payload.
3. Apply the normal forward migration command to the temporary database, then
   run the authenticated smoke check against the isolated deployment.
4. Verify tenant isolation, expected data point, and application readiness.
   Record the restore start/end, selected point, observed RPO, observed RTO, and
   protected evidence IDs.

## Restore a prior media version in isolation

<!-- runbook-contract:recovery-media-version -->

1. Select the required object version from the private versioned media bucket.
   Do not change the live object.
2. Restore that version into an isolated recovery prefix or bucket through the
   approved object-storage surface. Keep the media bucket private.
3. Verify object metadata, application-controlled access, and expected content
   with an authorized test user. Record version and evidence IDs only in the
   protected operational system.

## Validate an earlier Terraform state version without applying it

<!-- runbook-contract:recovery-state-version -->

1. Select a prior version in the private state bucket using the protected
   object-storage console. Do not download or display the state object.
2. Copy it only into an isolated recovery location under an approved procedure.
   Validate its object metadata and the expected root/key relationship there.
3. Do not initialize a production backend against the recovery copy and do not
   apply it. Escalate any state recovery decision to the infrastructure change
   authority.

## Recreate the replaceable application VM

<!-- runbook-contract:recovery-vm -->

1. Generate a new reviewed infrastructure plan that recreates only the app VM
   from Terraform. Preserve PostgreSQL, state, media, audit, and Lockbox.
2. Confirm the VM retains the Terraform-managed reserved public IP, uses the
   dedicated key-only `markiro-deploy` account, emits only the expected serial
   host-key records, and materializes runtime secrets at protected modes. There
   is no OS Login fallback.
3. Compare the encrypted offline recovery copy's public fingerprint with the
   protected `YC_APP_DEPLOY_SSH_PUBLIC_KEY`, resolve the authenticated serial host-key
   context, and deploy the last known healthy digest pair through the
   same strict-host-key-checked SSH interface. Never use an unauthenticated host
   key scan. Verify local readiness, ALB target health, and an authorized smoke
   request.
4. Keep the single-VM limitation explicit: VM replacement creates a visible
   interruption until the deferred multi-target HA design is implemented.

## Record results and clean up the drill

<!-- runbook-contract:recovery-evidence -->

1. Record observed RTO/RPO, selected restore point, migration result, smoke
   result, operator approvals, and evidence IDs in the protected system.
2. Compare results with the recovery objectives. Open a remediation change for
   any missed objective or unverified prerequisite.
3. Obtain a separate cleanup approval. Remove only named temporary recovery
   resources after confirming they are not production resources.
4. Record cleanup evidence separately. A successful restore does not prove
   cleanup, alert delivery, or a live production recovery.
