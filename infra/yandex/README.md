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
