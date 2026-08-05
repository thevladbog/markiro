# Bootstrap Yandex SaaS foundations

Set up the Yandex identities, empty Lockbox containers, private state bucket, and
remote bootstrap state. Run this once from an approved encrypted administrative
workstation. Stop if a required production ID, protected operator account, or
independent approval is absent. Do not perform a live apply from CI.

## Prepare the protected operator session

<!-- runbook-contract:bootstrap-prerequisites -->

1. Open the protected change record. Store evidence IDs there, not in Git or
   chat.
2. Sign in with the organization administrator that has OS Login enabled. Create
   and record the distinct service-account OS Login profile required by the
   deploy runner. Do not grant a static SSH key or public IP address.
3. Use an encrypted workstation with terminal recording disabled. Start each
   shell with `set -euo pipefail` and `umask 077`; never enable shell tracing.
4. Confirm the exact IDs, domain ownership, KMS key, subnet ranges, bucket
   names, notification destination, and protected GitHub environments:
   `production-controller`, `production-deploy`, `production-cleanup`,
   `production-infrastructure`, `production-public-dns`, and
   `production-postgres-owner`. Restrict every environment to `main`, require
   independent controller and cleanup reviewers, and never protect an unused
   shared `production` environment.
5. Install only the vendor-verified Terraform `1.15.8` release through the
   approved workstation package process. Verify the vendor signature and
   checksum before installation, then expose the executable as stable
   `terraform` on the protected workstation `PATH`; do not use a temporary
   review directory. Configure the reviewed Yandex provider mirror in a
   protected Terraform CLI configuration file. Keep the file mode `0600` and
   verify the provider lock for Linux amd64 and Darwin arm64 before proceeding.

```bash
set -euo pipefail
terraform version -json | jq -e '.terraform_version == "1.15.8"' >/dev/null
node infra/yandex/scripts/check-toolchain.mjs
```

## Apply the local bootstrap plan

<!-- runbook-contract:bootstrap-local-apply -->

1. Load short-lived Yandex credentials and non-secret `TF_VAR_*` identifiers
   into the protected session. Do not save them in a `.tfvars` file.
2. Do not create `infra/yandex/bootstrap/backend.tf` yet. The bootstrap root
   deliberately has no backend declaration, so this first plan and apply use
   Terraform's real local backend. The ignored S3 backend declaration is added
   only after the state bucket and HMAC credential exist.
3. Run the following commands. Review the binary plan through the approved
   local review process; do not print it, export it, or attach it to the change
   record.

```bash
set -euo pipefail
umask 077
export TF_CLI_CONFIG_FILE=/protected/terraform/terraform.tfrc
terraform -chdir=infra/yandex/bootstrap init -input=false -lockfile=readonly
terraform -chdir=infra/yandex/bootstrap fmt -check
terraform -chdir=infra/yandex/bootstrap validate
terraform -chdir=infra/yandex/bootstrap plan -out=bootstrap.tfplan
terraform -chdir=infra/yandex/bootstrap apply bootstrap.tfplan
```

4. Record only the approved change ID and the protected review evidence ID.
   The local plan and local state are confidential operational material.

## Create the state HMAC outside Terraform

<!-- runbook-contract:bootstrap-state-hmac -->

1. In the protected Yandex Cloud operator surface, create one HMAC credential
   for `markiro-production-state`. Terraform must not create, import, or read
   it.
2. Copy the HMAC identifier and secret through the approved secret-transfer
   path directly into `markiro-production-state-backend` Lockbox. That Lockbox
   must contain exactly `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`.
3. Use the console or an approved broker that accepts secret content from
   standard input or a protected file descriptor. Never put secret content in a
   command argument, workflow input, trace, terminal capture, Terraform value,
   or rendered Compose output.
4. Verify only entry names and Lockbox access bindings. Do not retrieve or
   display entry values.

## Migrate bootstrap state to the private bucket

<!-- runbook-contract:bootstrap-state-migration -->

1. Copy `infra/yandex/bootstrap/backend.tf.example` to the ignored
   `infra/yandex/bootstrap/backend.tf`, then copy
   `infra/yandex/bootstrap/backend.hcl.example` to the ignored
   `infra/yandex/bootstrap/backend.hcl`. Set only the bucket and key fields in
   `backend.hcl`; `backend.tf` contains only the S3 backend type.
2. Have the approved broker inject the HMAC pair into the process environment.
   Check presence only; do not echo values.

```bash
set -euo pipefail
umask 077
test -n "${AWS_ACCESS_KEY_ID:-}"
test -n "${AWS_SECRET_ACCESS_KEY:-}"
cp infra/yandex/bootstrap/backend.tf.example infra/yandex/bootstrap/backend.tf
cp infra/yandex/bootstrap/backend.hcl.example infra/yandex/bootstrap/backend.hcl
terraform -chdir=infra/yandex/bootstrap init -migrate-state -backend-config=backend.hcl -lockfile=readonly
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
```

3. The protected GitHub workflow becomes the sole production-state writer after
   migration. It serializes plan and apply; local production apply is prohibited.

## Verify remote state and retire the local copy

<!-- runbook-contract:bootstrap-state-verification -->

1. Through the protected console or metadata-only API, confirm the expected
   state object key and current version ID in the private versioned bucket.
2. Record the object-version evidence ID in the protected operational system.
   Do not download, print, or attach the object.
3. After verification, securely remove only the explicit local bootstrap state,
   backup, plan, and generated backend files under the workstation media policy.
   Clear injected credentials and close protected file descriptors.
4. Confirm the bucket, Lockbox containers, and durable resources retain
   `prevent_destroy`. A normal destroy must not become a recovery procedure.

## Privileged IAM boundary

The bootstrap root is applied only by the protected operator. It creates the
service accounts and grants the exact service-specific roles needed by the
workload-federated Terraform identity, plus the Audit Trails collection,
destination logging, and KMS permissions. Terraform receives no primitive
`editor` or `admin` role. The separate deployment-controller identity is the
only production GitHub OIDC subject and is limited to runner control and the
read-only Compute, ALB, and PostgreSQL deployment gates. Record the resulting
`deployment_controller` service-account ID and `audit_log_group_id` in the
protected GitHub environment variables before any production plan.
