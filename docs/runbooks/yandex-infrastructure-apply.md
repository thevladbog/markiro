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
3. Confirm access uses the exact protected environments: `production` for the
   deployment controller, `production-infrastructure` for Terraform, and
   `production-public-dns` for public DNS approval. Do not treat a boolean as
   environment approval.
4. Set `public_dns_enabled=false` unless this is the separately approved final
   DNS operation. Never use an automatic approval flag for public DNS.

## Generate and review the protected plan

<!-- runbook-contract:infrastructure-reviewed-plan -->

1. Dispatch **Yandex infrastructure** from the current `main` commit with the
   exact target SHA and `enable_public_dns=false`.
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
3. For first PostgreSQL provisioning, apply only
   `module.postgres.yandex_mdb_postgresql_cluster.production`. Create the owner
   named exactly as `database_name` through the approved database administration
   surface, write its credential directly to runtime Lockbox, then apply
   `module.postgres.yandex_mdb_postgresql_database.application`. Terraform must
   never receive the owner password.
4. Create Monitoring alerts manually from `alert_specs`; provider `0.215.0`
   cannot mutate alerts. Enter the exact resulting IDs and notification channel
   ID in protected infrastructure variables, then run a new reviewed plan.
5. Record only change, plan-summary, approval, and sanitized post-apply
   evidence IDs in the protected operational system.

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
