# Review and apply Yandex SaaS infrastructure

Use the protected GitHub workflow as the only production Terraform writer.
Review plans, apply saved plans, and handle drift without printing state,
full plan JSON, outputs, Lockbox payloads, Compose renders, or credentials.
Local production apply is prohibited.

## Prepare an infrastructure change

<!-- runbook-contract:infrastructure-prerequisites -->

1. Open a protected change record. Confirm the target is the current
   40-character `main` commit and that the applicable tests passed.
2. Confirm Terraform `1.15.8`, Yandex provider `0.215.0`, Node.js 24, pnpm
   11.10.0, runner `2.336.0`, and `yc` `1.23.0` pins are unchanged or have an
   approved provenance review. The `yc` SHA-256 is a measured repository pin,
   not vendor-attested provenance.
3. Confirm access uses the exact protected environments:
   `production-controller` for runner control, `production-deploy` for the
   self-hosted deployment job, `production-cleanup` for runner cleanup,
   `production-infrastructure` for Terraform, `production-public-dns` for
   public DNS approval, and `production-postgres-owner` for the database-owner
   boundary. Restrict each to `main`; these exact names are also OIDC subjects.
   Do not treat a boolean or a change-record reference as environment approval,
   and do not configure an obsolete shared `production` environment.
4. Set `public_dns_enabled=false` unless this is the separately approved final
   DNS operation. Never use an automatic approval flag for public DNS.

## Generate and review the protected plan

<!-- runbook-contract:infrastructure-reviewed-plan -->

1. For an ordinary full-root plan, dispatch **Yandex infrastructure** from the
   current `main` commit with these exact inputs.

```text
target_sha=current_main_sha
enable_public_dns=false
postgres_provisioning_phase=none
postgres_owner_change_reference=none
observability_phase=protected
```

2. Approve only the `production-infrastructure` environment after checking the
   sanitized plan summary, resource addresses, durable-resource protections,
   private ingress, and expected change scope.
3. Confirm the workflow uses the reviewed Yandex provider mirror and saved-plan
   artifact. The artifact is protected operational evidence with one-day
   retention; do not download, attach, or inspect it as JSON.
4. Stop on an unexpected create, replacement, delete, state migration, or any
   change to state, media, audit, PostgreSQL, Lockbox, or DNS. Obtain a new
   review rather than editing the state or rerunning an old plan.

## Approve the saved-plan apply

<!-- runbook-contract:infrastructure-approved-apply -->

1. Confirm the protected plan was generated for the current `main` SHA and the
   plan artifact hash matches its protected evidence.
2. Approve the workflow's `production-infrastructure` apply job. It rechecks
   the checked-out SHA, current main ref, artifact hash, and backend credentials
   before applying the saved plan.
3. For first PostgreSQL provisioning, dispatch the protected workflow with the
   following inputs. This creates only the cluster saved plan.

```text
target_sha=current_main_sha
enable_public_dns=false
postgres_provisioning_phase=cluster
postgres_owner_change_reference=none
observability_phase=first
```

4. Approve and apply that exact cluster plan. Create the owner named exactly as
   `database_name` through the approved database administration surface. Write
   its credential directly to runtime Lockbox. Record the cluster apply, exact
   owner creation, and runtime Lockbox write under one protected, non-secret
   snake_case change record reference. Terraform must never receive the owner
   password.
5. Dispatch a new protected workflow for the same current main SHA with these
   exact inputs. Replace `protected_change_record_id` with the recorded
   snake_case change reference. The database-only
   `production-postgres-owner` approval job attests the completed boundary and
   binds its current GitHub run ID, run attempt, approval outcome, and change
   reference to the saved-plan evidence.

```text
target_sha=current_main_sha
enable_public_dns=false
postgres_provisioning_phase=database
postgres_owner_change_reference=protected_change_record_id
observability_phase=first
```

6. Approve the `production-postgres-owner` job only after independently
   confirming the cluster apply, exact owner creation, and runtime Lockbox
   write in the protected record. Then approve and apply that exact database
   plan. The apply job rechecks the saved run identity, attempt, approval
   outcome, and change reference; it does not query or validate external record
   contents.
7. For a clean environment, first dispatch a full-root plan with
   `observability_phase=first`. The workflow deliberately unsets the notification
   channel and alert IDs, so no fabricated placeholders enter Terraform. Apply that saved plan.
   On successful apply, download the protected
   `yandex-alert-specs-<commit>-<run>-<attempt>` artifact and inspect its single
   `alert-specs.json` file. Its schema contains only `alert_specs` and binding
   metadata: `commit_sha`, `evidence_sha256`, `github_run_id`,
   `github_run_attempt`, `observability_phase=first`, and `plan_sha256`. Match all
   binding values to the reviewed apply evidence before using the specifications;
   the workflow rejects extra fields and never uploads raw Terraform event output
   or any other root output. Create all 16 Monitoring alerts manually from those
   specs; provider `0.215.0` cannot mutate alerts. Run the pre-go-live live metric
   inventory and query check, including `sys.memory.used_percent`,
   `sys.filesystem.used_percent`, and `markiro.readiness.required_unavailable`.
   Then record the exact notification channel and one unique ID for every spec in
   protected infrastructure variables and dispatch a new
   `observability_phase=protected` saved plan/apply. The protected phase rejects a
   missing, duplicate, blank, or extra ID.
8. The app VM clean bootstrap installs and enables the runtime materializer but
   does not read an empty Lockbox payload. Before any deployment, populate the
   runtime Lockbox with every and only the `.env.production.example` inventory,
   then use the protected deploy flow: it restarts the materializer and remains
   blocked unless atomic exact materialization succeeds. Never treat VM creation
   as proof that runtime secrets were materialized.
9. Record only change, plan-summary, approval, and sanitized post-apply
   evidence IDs in the protected operational system.
10. Before the first deployment, verify the bootstrap IAM boundary still grants
    the audit service account `audit-trails.viewer` on this folder,
    `logging.writer` on the bootstrap-created audit log group, and the exact KMS
    encryption permission. Verify the deployment controller uses
    `YC_DEPLOYMENT_CONTROLLER_SERVICE_ACCOUNT_ID`; it must never exchange a
    GitHub OIDC token for `YC_TERRAFORM_SERVICE_ACCOUNT_ID`.

## Investigate drift and stop unsafe changes

<!-- runbook-contract:infrastructure-drift -->

1. Treat an unexpected plan difference as drift. Freeze apply and identify the
   responsible change in Yandex audit logs or the protected change record.
2. Restore the intended declaration through a reviewed repository change, then
   generate a new protected plan. Do not import, taint, edit state, or apply
   locally to conceal drift.
3. Use the recovery runbook for lost state, media, PostgreSQL, or VM data. Do
   not use Terraform destroy as a recovery action.
4. If a deployment requires public DNS, complete every first go-live gate, use
   the separately approved `production-public-dns` environment, then follow the
   DNS section of the first go-live runbook.
