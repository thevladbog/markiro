# Yandex Cloud Terraform foundations

This directory contains two independent Terraform roots pinned to Terraform
1.15.8 and `yandex-cloud/yandex` 0.215.0. The production root uses a
credential-free partial S3 backend. Bootstrap starts with Terraform's local
backend and introduces its S3 declaration only for the one-time migration:

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

The Terraform production identity uses a bootstrap-created list of reviewed,
service-specific roles. It has no primitive `editor` or `admin` role. Privileged
IAM grants, including runtime KMS access and Audit Trails collection/destination
rights, are created only in the protected bootstrap boundary. No KMS key,
database password, or static S3 credential is created by Terraform.

## Monitoring alert provisioning boundary

The pinned Yandex provider 0.215.0 does not expose a Monitoring alert resource
or alert data source. Terraform therefore creates the log groups, both Audit
Trails destinations, and the dashboard, while `module.observability.alert_specs`
is the authoritative contract for alerts created in the Yandex Monitoring
console.

Clean first provisioning uses `observability_phase=first`: it deliberately
accepts no notification channel or alert IDs and emits reviewable
`module.observability.alert_specs`. An operator then creates all 16 alerts in the
console with the exact query, comparison, thresholds, and evaluation window, and
performs the live metric inventory/query check. Only
`observability_phase=protected` accepts the notification channel and the 16
unique resulting IDs. The protected root rejects a missing, extra, duplicate, or
blank alert ID and a blank channel. Terraform does not claim ownership of those
alert resources.

## One-time bootstrap state migration

The bootstrap operator uses an approved, encrypted administrative workstation.
Do not print Terraform state, echo credentials, place secret values in command
arguments, or retain terminal/session logs containing secret material.

1. **Local bootstrap plan.** Load the required `TF_VAR_*` identifiers and a
   short-lived operator IAM token into the process environment. Initialize the
   bootstrap root locally and save the reviewed binary plan. The plan file is
   ignored and must remain on the encrypted workstation.

   ```bash
   terraform -chdir=infra/yandex/bootstrap init -input=false
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
   `bootstrap/backend.tf.example` to the ignored `bootstrap/backend.tf`, then
   copy `bootstrap/backend.hcl.example` to the ignored `bootstrap/backend.hcl`.
   Set only the non-secret bucket and key fields, and load the HMAC pair into
   the standard AWS environment variables through the approved secret broker.
   Check only that the variables exist, then migrate the authoritative state:

   ```bash
   test -n "${AWS_ACCESS_KEY_ID:-}"
   test -n "${AWS_SECRET_ACCESS_KEY:-}"
   cp infra/yandex/bootstrap/backend.tf.example infra/yandex/bootstrap/backend.tf
   cp infra/yandex/bootstrap/backend.hcl.example infra/yandex/bootstrap/backend.hcl
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

The combined bootstrap/foundation must preserve separate GitHub workload
subjects on the shared federation:

- `production-controller` is reserved for the GitHub-hosted deployment
  controller and may federate only as the deployment-controller service
  account.
- `production-cleanup` is reserved for the independent GitHub-hosted cleanup
  job and may federate only as the deployment-controller service account.
- `production-deploy` protects the self-hosted deployment job. That job has
  `id-token: none`, and this subject must not have a Yandex federated
  credential.
- `production-infrastructure` is reserved for Terraform plan and apply jobs.
- `production-postgres-owner` is reserved for the database-only approval that
  attests the completed cluster apply, exact owner creation, and runtime
  Lockbox write before the database plan is created.

Configure `github_controller_environment = "production-controller"`,
`github_cleanup_environment = "production-cleanup"`, and
`github_infrastructure_environment = "production-infrastructure"` when
bootstrapping. In GitHub, protect the `production-infrastructure`
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

Protect `production-controller`, `production-deploy`, and
`production-cleanup` independently with main-branch deployment restrictions.
Use distinct required-reviewer policies for controller and cleanup so approval
of one privileged subject cannot authorize the other. The exact external
subjects are `repo:thevladbog/markiro:environment:production-controller`,
`repo:thevladbog/markiro:environment:production-deploy`, and
`repo:thevladbog/markiro:environment:production-cleanup`; only the first and third
receive deployment-controller credentials. Neither may exchange for the
Terraform service account.

The infrastructure environment supplies repository/environment variables, not
long-lived secrets. Required identity and state variables are
`YC_CLOUD_ID`, `YC_FOLDER_ID`, `YC_OIDC_AUDIENCE`,
`YC_TERRAFORM_SERVICE_ACCOUNT_ID`, `YC_STATE_BACKEND_SECRET_ID`, and
`YC_STATE_BUCKET_NAME`. It also supplies the non-secret `YC_*`/`MARKIRO_DOMAIN`
values mapped to the production root's `TF_VAR_*` inputs; the `YC_ALERT_IDS`
collection uses valid Terraform expression syntax. Audit Trails derives its
exact Lockbox scope from the three distinct runtime, registry, and runner
registration secret inputs rather than accepting a separate list.

On a trusted infrastructure run, the job requests a GitHub OIDC token for the configured
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

Both VM bootstraps install Docker Engine `28.5.2` and Docker Compose v2
`2.40.3` from exact official HTTPS artifacts with repository-controlled
SHA-256 pins. The app bootstrap does not become complete until the server and
plugin versions match and `docker compose ... config --quiet` renders the
production model from the bundled Compose contract. Ubuntu `docker.io` and
mutable install scripts are not part of the image contract.

Both VMs also install Unified Agent `26.07.11` from the exact Ubuntu 24.04
package and repository-controlled SHA-256. It collects Linux memory/disk
metrics and ships only the bounded, allowlisted, redacted journal export.
`markiro-monitoring-producer` writes the ALB-backend, PostgreSQL-backup-age,
readiness-degradation, and runner-runtime metrics used by `alert_specs`;
`remote-deploy.mjs` writes the deployment result metric. Every custom alert
spec names its producer and its missing-data behavior.

Private GHCR authentication uses the separate deploy-only registry Lockbox
container. The deployment-runner VM identity reads exactly `GHCR_USERNAME` and
`GHCR_TOKEN`, validates that closed shape, and sends it through the
strict-host-key-checked SSH standard input. The app VM identity has no registry
Lockbox access. Its root helper uses `docker login --password-stdin` under a
transient `DOCKER_CONFIG`, then always logs out and removes that directory.
Those entries never enter cloud-init or the runtime environment file. Rotation
is a new Lockbox version followed by one verified digest deployment and
revocation of the prior read-only token.

The protected controller, not the VM, calls GitHub `generate-jitconfig` and
upserts only the encoded one-use configuration into the runner's metadata while
it is stopped. The runner deletes that key and waits for the provider operation
to complete before executing Actions Runner. The VM must use a distinct
least-privilege identity with no access to the runner-registration Lockbox;
only the controller workload identity may read the GitHub admin token.

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
