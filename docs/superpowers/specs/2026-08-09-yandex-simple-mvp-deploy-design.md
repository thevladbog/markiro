# Yandex Cloud Simple MVP Deployment

**Date:** 2026-08-09
**Status:** Verbal design approved; written review pending
**Supersedes:** The deployment-runner and OS Login delivery sections of
`docs/superpowers/specs/2026-08-05-yandex-saas-infrastructure-design.md`
**Related:** `docs/superpowers/specs/2026-08-07-yandex-mvp-budget-design.md`,
`docs/runbooks/saas-production-deploy.md`,
`docs/runbooks/yandex-first-go-live.md`

## Problem

The private self-hosted deployment runner has delayed the first MVP release for
multiple days. The runner can start, register, validate the release and reach
the private application VM, but the application VM rejects a short-lived SSH
certificate with `MARKIRO_DEPLOY_FAILURE ssh-auth` even though the live Yandex
Cloud organization, OS Login profile, service-account identity, certificate
setting, instance IAM bindings, security groups and issued certificate all
match the documented configuration.

Continuing to add diagnostics or another custom access layer is not justified
for a one-customer MVP. The deployment path must become an ordinary protected
GitHub-hosted Docker delivery while the existing single-VM Compose runtime,
Managed PostgreSQL, Object Storage and managed ingress remain intact.

## Goals

1. Deploy the existing digest-pinned production Compose bundle from a standard
   GitHub-hosted runner.
2. Remove the JIT self-hosted runner VM, registration credential and access,
   runner service account, OS Login profile dependency and controller/cleanup
   job sequence.
3. Preserve release identity validation, immutable image digests, rollback
   rehearsal, smoke checks, deployment evidence and explicit environment
   approval.
4. Preserve the current application VM, Managed PostgreSQL, private Object
   Storage, ALB, TLS, Smart Web Security, Advanced Rate Limiter, monitoring,
   backups and audit resources.
5. Keep public DNS disabled until the first deployment and post-deployment
   checks succeed.
6. Keep SSH and registry credentials out of Git, Terraform state, artifacts and
   logs.

## Non-goals

- No Kubernetes, serverless container migration, instance group or second app
  host.
- No PostgreSQL or Object Storage topology change.
- No application, database-schema, station, kiosk or admin behavior change.
- No public API or edge listener directly on the application VM.
- No automatic DNS cutover.
- No dynamic GitHub runner IP allowlist, VPN, bastion or app-side pull agent in
  the MVP path.
- No attempt to repair or retain Yandex OS Login for deployment.

## Selected topology

The public application path remains unchanged:

```text
client -> DNS -> Yandex ALB -> SWS / ARL -> app VM port 8080 -> Compose
```

Only the deployment path changes:

```text
protected GitHub-hosted deploy job
  -> short-lived Yandex IAM token through existing GitHub OIDC federation
  -> read app VM address and authenticated serial-console host keys
  -> SSH with the protected deploy key to the app VM public address
  -> existing digest-pinned remote deployment and rollback logic
```

The application VM receives one Terraform-managed static public IPv4 address.
Its application listener on port 8080 remains reachable only from the ALB
security group. Port 22 is reachable from the internet because GitHub-hosted
runners do not have a stable free source range. This is an explicit
one-customer MVP risk acceptance, limited by key-only SSH, a dedicated account,
host-key pinning and protected-environment approval.

The deployment-runner VM and its management security group are removed. NAT
egress, the private app/data subnets and the ALB path remain unchanged.

## SSH trust boundary

The app image creates a dedicated `markiro-deploy` account during cloud-init.
The account has no password, cannot be used for direct root login and accepts
only the reviewed Ed25519 public key supplied through a non-secret protected
GitHub environment variable. SSH configuration must explicitly disable root
login and password, keyboard-interactive and challenge-response authentication.
The deployment account retains administrator-equivalent `sudo` capability
because the existing deployment contract must manage systemd units, Docker and
`/opt/markiro`; this capability is documented rather than disguised as a
restricted command set.

The matching private key is generated once by the operator under `umask 077`,
stored in the protected `production-deploy` GitHub environment secret and kept
in the operator's secure recovery storage. It is never passed to Terraform,
written to the repository, returned as an output or uploaded as an artifact.
The workflow writes it to a runner-temporary file with mode `0600` and removes
that file in an unconditional cleanup step.

The job does not use `ssh-keyscan`, `accept-new` or an unverified `known_hosts`
file. It reuses the existing authenticated serial-console host-key parser: the
deployment-controller service account reads the app VM's bounded host-key
records through the Compute API, and the job pins the exact internal evidence
to the current public address before connecting. A missing, malformed,
duplicated or changed host-key record fails before SSH.

## GitHub workflow

`Publish production images` remains unchanged: it builds and tests the bundle,
publishes the exact images by digest and uploads the trusted release manifest.

`Deploy production` becomes one protected GitHub-hosted job plus local cleanup:

1. Require the `production-deploy` environment approval.
2. Resolve and validate the exact successful release workflow run, SHA and
   trusted manifest.
3. For a finalized first deployment, validate the successful rehearsal
   evidence for the same release and run attempt.
4. Exchange GitHub OIDC for a short-lived token belonging to the existing
   deployment-controller service account.
5. Read the app VM public address, authenticated host keys and the existing GHCR
   registry credential from Yandex APIs. The service account receives only the
   additional Lockbox payload permission required for that registry secret.
6. Materialize the protected SSH key and `known_hosts` file under
   `$RUNNER_TEMP` with mode `0600`.
7. Run the existing immutable remote deployment, first-deployment smoke or
   repeat smoke, rollback rehearsal and finalization logic.
8. Upload the same bounded rehearsal or finalized-release evidence.
9. Always remove the SSH key, IAM token, registry material, manifest and
   temporary host-key files.

There is no automatic `workflow_run` deployment for the first rollout. A
successful image publication produces a release candidate; deployment remains
an explicit manual dispatch. Automatic repeat delivery may be reconsidered
after the MVP has a stable operational history, but it is not part of this
change.

The workflow no longer starts or registers a self-hosted runner and has no
`production-controller` or `production-cleanup` environment gate. The single
`production-deploy` approval is the human authorization boundary.

## Runtime adapter

The deployment adapter must not infer whether it is running inside Yandex
Compute. Its production entry point receives explicit validated inputs:

- the short-lived Yandex IAM token;
- the app instance ID;
- the exact public IPv4 address returned for that instance;
- the deploy login and private-key path;
- authenticated host keys;
- the trusted release manifest and expected release identity.

The deployment state machine, registry credential validation, archive bounds,
remote systemd execution, ALB target checks, first/repeat smoke behavior,
rollback and evidence shapes remain unchanged. Tests must reject a private-only
address, a foreign address, missing key material, permissive host-key settings,
raw SSH stderr and mutable image references.

## Terraform changes

The production Terraform configuration will:

1. Add one reserved external IPv4 address for the application VM.
2. Attach that address to the app VM while retaining the private interface and
   ALB target address.
3. Add an app security-group rule for TCP port 22 from `0.0.0.0/0`; retain the
   exact ALB-to-8080 and app-to-data rules.
4. Add the validated `app_deploy_ssh_public_key` input and render only the public
   key into app cloud-init. The protected `production-infrastructure`
   environment supplies this value to Terraform.
5. Disable OS Login metadata on the app VM and configure the dedicated deploy
   account and fail-closed sshd settings.
6. Remove the runner VM, runner security group, runner service account,
   runner-only IAM grants, runner outputs and runner cloud-init/systemd assets
   from the active production graph. Revoke the runner-registration payload and
   all access to it. Its `prevent_destroy` bootstrap container remains as an
   empty tombstone until a separately reviewed bootstrap-state decommission;
   it is not an input to production after this change.
7. Preserve the deployment-controller service account and GitHub OIDC binding,
   narrowing its live responsibilities to app discovery, serial host-key reads
   and the exact registry-secret payload.

The app cloud-init change replaces the application VM. This is acceptable
before the first successful production release, but the protected Terraform
plan must show no replacement or deletion of PostgreSQL, Object Storage, KMS,
ALB, certificates, DNS zones or audit storage. Any such unrelated destructive
action blocks apply.

## Secrets and recovery

The new inventory contains two operator-managed deployment values:

- `YC_APP_DEPLOY_SSH_PUBLIC_KEY`: protected
  `production-infrastructure` environment variable used only as a Terraform
  input;
- `YC_APP_DEPLOY_SSH_PRIVATE_KEY`: protected `production-deploy` environment
  secret used only by the deploy job.

The public and private halves must be checked for an exact fingerprint match
before infrastructure apply. The private key must have an offline recovery copy
so an operator can connect directly if GitHub Actions is unavailable. Rotation
creates a new pair, applies the public half first, verifies access, then removes
the previous key and secret.

The existing runtime and registry secrets remain in Lockbox. The app VM
continues to fetch runtime configuration through its service-account identity.
Deployment logs may emit only fixed diagnostic categories; they must not print
the private key, IAM token, registry credential, environment file or raw SSH
stderr.

## Failure and rollback behavior

- Failure before SSH changes no remote state and removes all temporary local
  credentials.
- Transfer, prepare, migration, ALB or smoke failure uses the existing bounded
  rollback state machine.
- A rollback rehearsal for the first release must still end with no active
  release and produce authenticated rehearsal evidence.
- A finalized first deployment requires the exact successful rehearsal artifact
  for the same release and run attempt. There is no separate runner-cleanup
  receipt in the hosted path.
- Because there is no self-hosted runner, failure cleanup never starts or stops
  a VM and cannot block the deployment concurrency group.
- If hosted SSH fails after the Terraform apply, the operator uses the offline
  private-key copy and the same pinned host-key evidence to inspect the app VM;
  no OS Login fallback is retained.

## Rollout sequence

1. Merge the workflow, adapter, Terraform, contract and runbook changes while
   public DNS remains disabled.
2. Generate the Ed25519 key pair locally, verify its fingerprint and configure
   the protected GitHub variable and secret without printing the private key.
3. Run the protected Terraform plan. Confirm the expected app replacement,
   reserved address, SSH rule and runner-resource removals only.
4. Apply infrastructure and verify app cloud-init completion, key-only SSH,
   public-address identity and ALB target inventory.
5. Publish a release from `main`.
6. Run and approve a `first` rollback rehearsal from the GitHub-hosted runner.
7. Run and approve the finalized `first` deployment using the exact rehearsal
   evidence.
8. Verify ALB pre-DNS smoke for both admin and kiosk authorities.
9. Only then continue the existing protected public-DNS apply, convergence and
   post-DNS smoke process.

## Verification and acceptance

Implementation is accepted when:

- focused tests fail against the old self-hosted/OS Login design and pass
  against the hosted deployment design;
- workflow contracts require `ubuntu-latest`, one protected deploy gate,
  explicit OIDC permissions, exact release identity, key cleanup and no
  self-hosted/controller/cleanup job path;
- Terraform contracts require the reserved app address, public SSH rule,
  key-only deploy account and removal of runner resources while continuing to
  require private ALB and database paths;
- mutation tests reject password/root SSH, unpinned host keys, leaked private
  key material, missing cleanup, mutable images and reintroduced runner/OS Login
  paths;
- Yandex runtime, infrastructure, runbook and production-bundle contract suites
  pass;
- Terraform formatting and validation pass with the pinned provider when it is
  available;
- repository formatting, secret scanning and `git diff --check` pass;
- a live protected Terraform plan contains only the approved compute/network/IAM
  transition and no data-service replacement;
- a live first rollback rehearsal and finalized first deployment both pass
  before public DNS is enabled.

Automated contracts do not count as live SSH, cloud apply, rollback, TLS, DNS or
customer acceptance. Each external gate is reported separately.
