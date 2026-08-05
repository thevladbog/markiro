# Yandex Cloud Terraform foundations

This directory contains two independent Terraform roots pinned to Terraform
1.15.8 and `yandex-cloud/yandex` 0.215.0. Both use credential-free partial S3
backends after the one-time bootstrap migration:

- `bootstrap` creates prerequisites that must exist before remote state is used.
- `production` manages the SaaS environment.

## Runtime inputs

Set the deployment identifiers as Terraform variables from the existing Yandex
Cloud environment variables. Keep the temporary IAM token in `YC_TOKEN` so the
provider reads it directly:

```bash
export TF_VAR_cloud_id="$YC_CLOUD_ID"
export TF_VAR_folder_id="$YC_FOLDER_ID"
```

Set required `state_bucket_name` from the protected bootstrap output (or the
same approved operator configuration used for `backend.hcl`). Production uses
the name only to reject collisions with media and audit buckets; it does not
create or read the state bucket.

Supply S3-compatible backend authentication only through the standard AWS
environment variables in the deployment process. Never write those values to a
backend file, Terraform variables, shell history, or logs.

Copy the applicable `backend.hcl.example` to the ignored `backend.hcl` in the
same root and replace only the example bucket name and state key. Initialize a
new production checkout explicitly:

```bash
terraform -chdir=infra/yandex/production init -backend-config=backend.hcl
```

## First PostgreSQL provisioning boundary

Terraform creates the protected cluster and the database definition, but it
never creates a PostgreSQL owner, password, static access key, or Lockbox
secret payload. On the first deployment, use this controlled sequence after a
reviewed plan:

1. Apply only `module.postgres.yandex_mdb_postgresql_cluster.production`.
2. Through the approved database administration surface, create the PostgreSQL
   identity named exactly as `database_name`. Transfer its credential directly
   to the pre-created runtime Lockbox container through the protected console
   or approved secret broker; do not provide the credential to Terraform.
3. Apply `module.postgres.yandex_mdb_postgresql_database.application`, then
   return to normal reviewed production plans.

This sequencing is only for first provisioning. It keeps the database owner
credential out of Terraform configuration and state while satisfying the
provider-required database `owner` binding.

## Object storage encryption and runtime access

The application and audit identities receive direct, key-scoped KMS access:
`kms.keys.encrypterDecrypter` for media reads/writes and
`kms.keys.encrypter` for write-only audit archives. Object access is instead
limited by explicit bucket policies, so neither runtime identity receives
`storage.editor`, `storage.uploader`, or `storage.configurer`.

The Terraform production identity is the only configuration boundary. Its
existing folder-level management role applies bucket encryption, lifecycle, and
policy settings during reviewed applies; no extra `storage.configurer` binding
is granted to a runtime identity. No KMS key, database password, or static S3
credential is created by Terraform.

## Monitoring alert provisioning boundary

The pinned Yandex provider 0.215.0 does not expose a Monitoring alert resource
or alert data source. Terraform therefore creates the log groups, both Audit
Trails destinations, and the dashboard, while `module.observability.alert_specs`
is the authoritative contract for alerts created in the Yandex Monitoring
console.

Production apply and go-live must not proceed until an operator creates every alert in
the console with the exact query, comparison, thresholds, evaluation window,
and `notification_channel_id` emitted by `alert_specs`. Record the resulting IDs
under the matching `alert_ids` keys. The production root rejects a missing,
extra, or blank alert ID and a blank channel. Terraform does not claim ownership
of those alert resources.

## One-time bootstrap state migration

The bootstrap operator uses an approved, encrypted administrative workstation.
Do not print Terraform state, echo credentials, place secret values in command
arguments, or retain terminal/session logs containing secret material.

1. **Local bootstrap plan.** Load the required `TF_VAR_*` identifiers and a
   short-lived operator IAM token into the process environment. Initialize the
   bootstrap root locally and save the reviewed binary plan. The plan file is
   ignored and must remain on the encrypted workstation.

   ```bash
   terraform -chdir=infra/yandex/bootstrap init -backend=false
   terraform -chdir=infra/yandex/bootstrap plan -out=bootstrap.tfplan
   ```

2. **Approved bootstrap apply.** After independent plan approval, apply the
   exact saved plan locally. Do not apply an unreviewed, newly calculated plan.

   ```bash
   terraform -chdir=infra/yandex/bootstrap apply bootstrap.tfplan
   ```

3. **Out-of-band state HMAC creation.** Using the protected Yandex Cloud
   operator surface, create one HMAC credential for the dedicated
   `markiro-production-state` service account. Terraform must not create or
   import this credential. Capture it once through the approved secret-transfer
   channel without terminal or workflow logging.

4. **Direct Lockbox upload.** Transfer the HMAC identifier and secret directly
   into the empty `markiro-production-state-backend` Lockbox container using the
   protected Yandex Cloud console or an approved secret-broker integration.
   Never pass either value as a CLI argument, Terraform variable, or file.

5. **Backend migration with environment credentials.** Copy
   `bootstrap/backend.hcl.example` to the ignored `bootstrap/backend.hcl`, set
   only the non-secret bucket and key fields, and load the HMAC pair into the
   standard AWS environment variables through the approved secret broker. Check
   only that the variables exist, then migrate the authoritative state:

   ```bash
   test -n "${AWS_ACCESS_KEY_ID:-}"
   test -n "${AWS_SECRET_ACCESS_KEY:-}"
   terraform -chdir=infra/yandex/bootstrap init -migrate-state -backend-config=backend.hcl
   ```

6. **Remote object and version verification.** In the Yandex Cloud console or
   through a metadata-only approved API call, verify that the configured object
   key exists in the protected bucket and has a current version ID. Do not
   download, display, or log the state object.

7. **Secure deletion of local authoritative state.** Only after remote object
   and version verification succeeds, securely erase the explicit local
   bootstrap state and backup files according to the workstation media policy.
   Do not use a broad recursive target. Clear the backend environment variables
   and delete the local binary plan as well. The remote versioned object is now
   the sole authoritative bootstrap state.

## Protected GitHub infrastructure workflow

`.github/workflows/yandex-infrastructure.yml` keeps pull-request validation
credential-free. Pull requests run Terraform formatting, exact lock/toolchain
checks, `init -backend=false`, validation, and infrastructure contracts without
OIDC, environment variables, Lockbox, or a remote backend.

The bootstrap root preserves two exact GitHub workload subjects on the same
Terraform service account and federation:

- `production` is reserved for the deployment controller.
- `production-infrastructure` is reserved for Terraform plan and apply jobs.
- `production-postgres-owner` is reserved for the database-only approval that
  attests the completed cluster apply, exact owner creation, and runtime
  Lockbox write before the database plan is created.

Configure `github_infrastructure_environment = "production-infrastructure"`
when bootstrapping. In GitHub, protect the `production-infrastructure`
environment with required reviewers and main-branch deployment restrictions.
Configure a second protected `production-public-dns` environment with the
separate reviewers authorized to approve public DNS cutover. The boolean
`enable_public_dns` input never substitutes for that approval: a true request
must pass the DNS environment before the infrastructure plan is generated.
Protect `production-postgres-owner` with reviewers authorized to verify that
the cluster plan applied, the exact `database_name` owner exists, and its
credential was written to runtime Lockbox. This database-only approval emits
the current GitHub run identity and non-secret snake_case change record
reference into saved-plan evidence; it does not inspect external record
contents.

The infrastructure environment supplies repository/environment variables, not
long-lived secrets. Required identity and state variables are
`YC_CLOUD_ID`, `YC_FOLDER_ID`, `YC_OIDC_AUDIENCE`,
`YC_TERRAFORM_SERVICE_ACCOUNT_ID`, `YC_STATE_BACKEND_SECRET_ID`, and
`YC_STATE_BUCKET_NAME`. It also supplies the non-secret `YC_*`/`MARKIRO_DOMAIN`
values mapped to the production root's `TF_VAR_*` inputs; collection variables
such as `YC_LOCKBOX_SECRET_IDS` and `YC_ALERT_IDS` use valid Terraform
expression syntax.

On a trusted run, the job requests a GitHub OIDC token for the configured
audience, exchanges it for a short-lived Yandex IAM token, and reads only the
state-backend Lockbox container. That container must have exactly two text
entries named `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`. Values are masked
before export and unset by an exit trap; the workflow never prints state,
Terraform outputs, or full plan JSON.

Pushes to `main` create a read-only plan. Manual apply requires the exact
current 40-character main commit in `target_sha`; the workflow regenerates a
binary plan for that commit, uploads the plan with commit and SHA256 evidence,
and the protected apply job rechecks the artifact hashes, checkout, dispatch
commit, and live repository main before running `terraform apply saved.tfplan`.
Saved-plan artifacts are potentially sensitive and therefore have one-day
retention.

## Toolchain contract

Regenerate provider locks only with the exact pinned Terraform release and both
deployment platforms. These commands use the Yandex Cloud provider mirror so
they remain reproducible where the public registry is unavailable:

```bash
terraform -chdir=infra/yandex/bootstrap providers lock -net-mirror=https://terraform-mirror.yandexcloud.net -platform=linux_amd64 -platform=darwin_arm64 yandex-cloud/yandex
terraform -chdir=infra/yandex/production providers lock -net-mirror=https://terraform-mirror.yandexcloud.net -platform=linux_amd64 -platform=darwin_arm64 yandex-cloud/yandex
corepack pnpm test:yandex-infra:contract
```

Both `.terraform.lock.hcl` files are committed. Local state, plans, generated
backend configuration, and automatic variable files are ignored and must never
be committed.

## Deployment-runner binary and SSH trust pins

The deployment runner installs Yandex Cloud CLI `1.23.0` from the exact
versioned official Linux AMD64 object and verifies the repository-controlled
SHA-256
`3e287905b63685847aa77f17f92bf7156037cc63b9a42c6cd901db69a61604c9`
before installation. It then requires `yc version --semantic` to return exactly
`1.23.0`. Yandex currently publishes no checksum or signature for that object;
the pin was independently measured from the exact HTTPS payload. Upgrade it only
through the two-reviewer procedure in
`docs/runbooks/saas-production-deploy.md`; mutable stable/latest paths are not
allowed in cloud-init.

Application cloud-init emits only the versioned `MARKIRO_SSH_HOST_KEY_V1`
OpenSSH public-key records to its serial output. The protected controller
requires exactly one valid `ssh-ed25519` and one valid `ssh-rsa` payload,
canonicalizes that pair, and retrieves it through the authenticated Compute
serial-output API. The private runner revalidates the exact pair and uses a
private `known_hosts` file with strict host checking for the app's internal IP.
Do not place SSH private host keys in Terraform, metadata, workflow outputs, or
deployment artifacts.
