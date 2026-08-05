# Yandex Cloud Terraform foundations

This directory contains two independent Terraform roots pinned to Terraform
1.15.8 and `yandex-cloud/yandex` 0.215.0:

- `bootstrap` creates prerequisites that must exist before remote state is used.
- `production` manages the SaaS environment and uses a partial S3 backend.

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

Copy `production/backend.hcl.example` to the ignored `production/backend.hcl`
and replace only the example bucket name and state key. Then initialize the
roots explicitly:

```bash
terraform -chdir=infra/yandex/bootstrap init -backend=false
terraform -chdir=infra/yandex/production init -backend-config=backend.hcl
```

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
