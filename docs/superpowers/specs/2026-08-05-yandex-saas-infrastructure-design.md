# Yandex Cloud SaaS Infrastructure — Design Spec

**Date:** 2026-08-05
**Status:** Approved for implementation planning
**Slice of:** Markiro MVP roadmap plan 08, Yandex Cloud deployment
**Related:** `docs/architecture.md`,
`docs/superpowers/specs/2026-08-04-saas-production-bundle-design.md`,
`docs/runbooks/saas-production-deploy.md`

## Problem

Markiro has a verified, digest-addressed production bundle, but no cloud
environment that can safely run it for the first SaaS customer. The current
bundle deliberately stops before provisioning networking, PostgreSQL, object
storage, secrets, protected ingress, monitoring, deployment access, DNS, or a
live restore path.

The first customer needs a real SaaS environment, not a developer checkout or
a manually assembled public VM. The environment must remain small enough for
an MVP while protecting tenant data, supporting multiple users and roles per
tenant, and preserving the existing offline station and kiosk clients.

This design defines the Yandex Cloud infrastructure, deployment path, secret
boundaries, and go-live gates consumed by the existing production bundle.

## Goals

- Provision the first production environment reproducibly with Terraform.
- Expose one HTTPS origin through Yandex Application Load Balancer and Smart
  Web Security while keeping application hosts private.
- Reuse the existing `migrate`, `api`, and `edge` production services and their
  digest-pinned deployment contract.
- Use Managed PostgreSQL, private Object Storage, Lockbox, Cloud Logging,
  Monitoring, and Audit Trails with least-privilege service accounts.
- Keep application runtime secrets out of Git, Terraform input files, normal
  Terraform outputs, GitHub logs, and deployment records.
- Deploy to a private VM without permanent public SSH or a continuously
  running deployment host.
- Make infrastructure changes, application rollout, rollback, restore drills,
  and the first DNS cutover explicit and reviewable.
- Establish honest MVP recovery targets and a documented path to later high
  availability.

## Non-goals

- No Kubernetes, managed container platform, or service mesh.
- No multi-VM application cluster or high-availability PostgreSQL in this
  slice.
- No migration from GHCR to Yandex Container Registry.
- No platform SaaS admin, billing, subscription state, or public landing page.
- No new pallet or CommerceML/1C functionality.
- No domain or mailbox purchase and no usable production credential in the
  repository.
- No automatic public DNS cutover without a separately approved production
  apply.
- No claim of zero downtime. One application VM means a deployment or host
  failure can create a visible interruption.

## Selected topology

The public request path is:

```text
client
  -> public DNS
  -> Yandex Application Load Balancer
       -> Certificate Manager TLS termination
       -> Smart Web Security / WAF / Advanced Rate Limiter
  -> private app VM port 8080
  -> Caddy edge
  -> Nest API on the private Compose network
  -> private Managed PostgreSQL / Object Storage / external SMTP
```

The Application Load Balancer is the only public application endpoint. The app
VM, deploy-runner VM, and PostgreSQL host have no public address. Security
groups allow ALB-to-edge traffic only from the ALB node subnets, runner-to-app
SSH only between the two dedicated security groups, and PostgreSQL traffic only
from the app security group.

Both VMs use a NAT gateway for required outbound access. The app VM needs GHCR,
SMTP, package/security update, Yandex API, and any approved integration
endpoints. The runner needs GitHub, GHCR, Yandex API, and the private app VM.
Neither NAT nor a route table creates an inbound path.

The initial availability profile is intentionally modest:

- one application VM;
- one normally stopped deployment-runner VM;
- one Managed PostgreSQL 17 host;
- one ALB target;
- automatic PostgreSQL backups, PITR, and reproducible VM replacement.

Terraform module inputs must permit a later second app target and multi-host
PostgreSQL topology, but this slice does not pretend that unused parameters
provide high availability.

## Protected ingress

The ALB has two public listeners:

- port 80 performs an HTTP-to-HTTPS redirect without contacting the backend;
- port 443 terminates TLS using a pre-provisioned Certificate Manager
  certificate and forwards private HTTP to Caddy on port 8080.

The ALB virtual host uses the exact production hostname. Its Smart Web Security
profile enables baseline filtering, WAF protection, and conservative Advanced
Rate Limiter rules. Security logs go to Cloud Logging. Initial limits are
variables with reviewed defaults so they can be tuned from evidence without
rebuilding application images.

The backend group probes `GET /health/ready` with the production hostname as
the health-check authority. A success means required API dependencies are
ready. Optional SMTP or S3 degradation remains visible to operations without
removing the only backend from service.

Public DNS is an explicit Terraform feature gate:

```text
public_dns_enabled = false
```

The default plan creates no public application record. Certificate validation
records may be provisioned earlier so the certificate can become active before
the application address changes. The production stack accepts the ID of an
existing public Yandex Cloud DNS zone; purchasing a domain and delegating that
zone at the registrar are operator prerequisites outside Terraform. The
application `A` record is created only by an approved apply after every go-live
gate passes.

## Edge mode behind ALB

The current edge image owns public TLS and redirects HTTP to HTTPS. Reusing
that behavior behind a TLS-terminating ALB would create redirect loops and an
unnecessary second certificate boundary. The production edge therefore gains
an exact `behind-alb` mode while retaining the existing direct mode.

The edge image contains both reviewed configurations and a minimal entrypoint
that accepts only the supported mode enum. Unknown or missing production
configuration fails closed. In `behind-alb` mode Caddy:

- listens only for private HTTP on port 8080;
- performs no ACME operation and no backend HTTPS redirect;
- preserves the existing SPA, API, station, kiosk, health, docs, and
  `/1c_exchange` route table;
- preserves cache and browser security headers, including HSTS on responses
  that the client receives over ALB HTTPS;
- receives traffic only from the ALB security group;
- forwards the authoritative external host and HTTPS scheme to the API; and
- preserves a bounded, tested client-address chain.

The controlled proxy chain is `ALB -> Caddy -> API`. Production config sets the
API trust boundary to exactly those two proxy hops. Tests must prove that the
expected client address, host, and scheme survive the chain and that a direct
or forged forwarded-header path cannot enter through the configured network
rules. The API remains unreachable from a host port.

A cloud-specific Compose overlay selects `behind-alb` and publishes only the
private backend port. It does not add PostgreSQL, SMTP, MinIO, host-directory
mounts, mutable image tags, or a second application process.

## Terraform repository layout

Infrastructure lives under one explicit root:

```text
infra/yandex/
  bootstrap/
  production/
  modules/
    iam/
    network/
    compute/
    postgres/
    object-storage/
    ingress/
    observability/
  README.md
```

Provider and Terraform versions are exact constraints, and the provider lock
file covers Linux amd64 and the supported operator platform. Modules expose
small typed inputs rather than accepting unstructured resource maps.

### Bootstrap stack

The bootstrap stack is applied once with a protected operator identity. It
creates:

- the private Terraform-state bucket with versioning;
- the dedicated state-backend service account and minimum bucket access;
- the Terraform apply service account;
- the app runtime service account;
- the deploy-runner service account;
- the audit writer service account;
- workload identity federation and federated credentials constrained to this
  GitHub repository and production environment;
- empty Lockbox secret containers and their exact access bindings.

The first bootstrap uses local state. Immediately after the backend bucket and
credentials exist, the operator migrates bootstrap state into that bucket and
verifies the object version. The runbook does not leave a local authoritative
copy behind.

The state bucket and all other durable resources use `prevent_destroy`. A
normal `terraform destroy` must not delete state, PostgreSQL, media, audit
archives, or Lockbox containers.

### State concurrency

Yandex documents Object Storage plus YDB Document API for Terraform locking,
but also documents that this mechanism is deprecated in Terraform 1.11 and
later. The MVP does not add a deprecated YDB lock service.

Instead:

- the protected GitHub infrastructure workflow is the only state writer;
- plan and apply jobs share one non-cancelling production concurrency group;
- every apply uses a freshly generated plan for the same `main` commit after
  environment approval;
- local apply is prohibited by the runbook;
- bucket versioning protects prior state versions.

This is a process lock rather than a distributed backend lock. That limitation
is explicit. A future move to a supported native lock or remote Terraform
service can replace it without changing resource modules.

## Production resources

The production stack creates:

### Network

- one VPC;
- separate ALB, application, data, and management subnets where required by
  provider resource semantics;
- route tables and NAT gateway;
- explicit security groups with no `0.0.0.0/0` ingress except ALB ports 80 and
  443;
- no public IPv4 address on application, runner, or database resources.

### Compute

- an Ubuntu LTS app VM with OS Login enabled;
- a bounded persistent boot disk and no application data volume;
- Docker Engine and Compose plugin installed by a versioned bootstrap process;
- `/opt/markiro` and `/etc/markiro` with restrictive ownership and modes;
- systemd units for runtime-secret materialization, deployment prerequisites,
  local health reporting, and the production Compose project;
- one small runner VM that is stopped outside deployment windows.

The app VM is replaceable. Production data, Terraform state, media, release
identity, and secrets must never exist only on its disk.

### PostgreSQL

- Managed PostgreSQL 17 without public access;
- one host for the MVP profile;
- the application database;
- a fixed maintenance window;
- daily automatic backup;
- 14-day automatic backup retention;
- PITR enabled;
- alerts for storage, connections, availability, and backup freshness.

Database credentials are not generated through ordinary Terraform resource
arguments. Terraform creates the cluster and database boundary; a separate
operator procedure creates or rotates the application database identity and
writes its credential directly to Lockbox. This prevents that value from being
copied into plans and normal state paths.

### Object Storage

The state, application media, and audit archive are different private buckets.
No bucket has anonymous access.

The media bucket is shared by the current avatar subsystem and future catalog
product images through key-prefix separation, not by making either prefix
public. It has:

- versioning enabled;
- old non-current versions removed after 30 days;
- incomplete multipart uploads removed after 7 days;
- least-privilege application access to media objects only.

The API continues to issue controlled media responses or signed access through
its existing private S3 abstraction. Infrastructure does not make image URLs
public.

### Secrets

Terraform creates Lockbox containers, metadata, and IAM bindings but does not
receive application secret payloads. An operator writes these directly to the
runtime secret:

- PostgreSQL connection data;
- Better Auth secret and production origins;
- pairing-code pepper;
- SMTP endpoint, credentials, sender, and reply-to configuration;
- mail-payload encryption key;
- Object Storage endpoint, bucket, and static access key;
- read-only GHCR deployment credential.

The app service account can read only the runtime secret. Before start and
before each deployment, a root-owned helper reads the current Lockbox payload,
validates the complete production environment contract, atomically replaces
`/etc/markiro/production.env`, sets mode `0600`, and never prints values.
Failure leaves the previous valid file in place but blocks a new deployment.

The S3 Terraform backend requires a static HMAC credential. It belongs to a
state-only service account and is stored in a different Lockbox secret. A
GitHub job exchanges its OIDC token for a temporary Yandex IAM token, reads the
backend credential immediately before `terraform init`, masks both values, and
removes them from the environment after the operation. No long-lived Yandex
authorized key is stored in GitHub Secrets.

Terraform state is still confidential even with application payloads kept out
of it. Access is limited to the state service account and protected
infrastructure workflow, and no sensitive state content is rendered in CI.

## Private deployment runner

A GitHub-hosted runner cannot route to a private VPC address. The design uses a
dedicated private self-hosted runner rather than exposing SSH on the app VM.

The runner:

- has no public IP and accepts no inbound internet traffic;
- is normally stopped;
- starts only from an OIDC-authenticated controller job;
- registers for exactly one protected production deployment using a
  just-in-time, one-use runner configuration;
- runs no pull-request workflow and checks out only the approved `main` SHA;
- reaches the app VM over its internal address through OS Login;
- cannot read the application runtime secret;
- has only the IAM and network permissions required for deployment; and
- is stopped by an independent `always()` cleanup job even after deployment
  failure.

The least-privilege GitHub credential needed to request the ephemeral runner
registration is stored in a runner-only Lockbox secret and rotated separately.
It grants no source write or package publication permission.

OS Login is enabled at the organization and VM levels. The runner service
account receives `compute.osLogin` or the minimum verified administrative
variant plus the resource-auditor/operator permissions required by Yandex. The
one-time bootstrap runbook creates the service-account OS Login profile because
Yandex does not create that profile automatically.

Security groups allow TCP 22 only from the runner security group to the app
security group. There is no SSH rule from the public internet.

## CI and infrastructure changes

Changes under `infra/**` run these PR gates:

- `terraform fmt -check`;
- `terraform validate`;
- exact provider-lock verification;
- static infrastructure security checks;
- repository contract tests for public-IP, bucket, DNS, secret-output, and
  destructive-resource invariants;
- a non-applying production plan when protected read credentials are
  available.

The PR plan is evidence only and is never applied. After merge, the workflow
generates a new plan from that exact `main` commit, waits for the protected
production environment approval, and applies only that saved plan. A stale,
different-commit, or unreviewed plan fails closed.

The public DNS feature gate is not enabled by the normal infrastructure apply.
The first cutover is a separate workflow input and approval with its own plan.

## Release evidence

The current image workflow already verifies and publishes both SHA-tagged
images, then records their repository digests. It gains a durable,
machine-readable release manifest containing:

```json
{
  "commit": "<40-character git SHA>",
  "api": "ghcr.io/thevladbog/markiro-api@sha256:<64 hex>",
  "edge": "ghcr.io/thevladbog/markiro-edge@sha256:<64 hex>",
  "workflowRunId": "<trusted run id>",
  "createdAt": "<UTC timestamp>"
}
```

The manifest is produced only after both pushes succeed. Deployment downloads
it from the successful trusted workflow and revalidates its schema, repository
names, full commit, digests, and workflow identity. Tags remain release labels,
not deployment selectors.

## Application deployment

A production deployment is manually dispatched or approved after a successful
image publication:

1. The GitHub-hosted controller exchanges OIDC for a temporary Yandex IAM
   token.
2. It validates infrastructure state, certificate status, SWS attachment, ALB
   health, and PostgreSQL backup freshness.
3. It starts the private runner and waits a bounded time for its one-use
   registration.
4. The runner downloads the trusted release manifest and exact repository
   revision.
5. It transfers only the approved production bundle to a new protected release
   directory on the app VM; the app VM receives no GitHub source credential.
6. The app VM refreshes and validates its environment from Lockbox without
   disclosing values.
7. Existing production preflight validates release SHA, both digests, file
   modes, and the cloud Compose model.
8. The VM pulls API and edge by the approved repository digests.
9. It runs the digest-selected migration job once and stops on failure.
10. It recreates API, waits for bounded readiness, then recreates the
    `behind-alb` edge.
11. It verifies ALB backend health and runs the complete external production
    smoke against the approved hostname.
12. It writes a protected healthy release record with no secret content.
13. The independent cleanup job removes the ephemeral runner registration and
    stops the runner VM.

The current single-service deployment can cause a short interruption. The
design must not describe it as rolling or zero-downtime deployment.

On migration failure neither service is switched. On readiness or smoke
failure the release is failed and the previous digest pair is redeployed. The
database is not rolled back: every migration remains compatible with the
immediately previous API release. A cleanup failure never masks the original
deployment error and always raises its own operator alert.

## Logging, metrics, and audit

ALB and Smart Web Security access/security logs use a dedicated Cloud Logging
group. Docker uses `journald`; Yandex Unified Agent ships bounded, sanitized
application and system logs and collects Linux CPU, memory, and disk metrics.
Normal operational logs are retained for 14 days.

Audit Trails collects management events for the production folder and selected
data events for sensitive services such as Lockbox and Object Storage. It sends
a searchable operational copy to Cloud Logging and a 90-day archive to the
dedicated audit bucket. The audit destination bucket is not also selected as a
source of its own data-event trail.

At least one tested notification channel is a go-live prerequisite. Minimum
alerts cover:

- no healthy ALB backend;
- elevated ALB 5xx ratio and latency;
- unusual SWS deny or rate-limit volume;
- app VM CPU, memory, and disk pressure;
- PostgreSQL availability, storage, connection pressure, and backup age;
- certificate validation or expiry risk;
- optional SMTP or S3 degradation reported by the local readiness observer;
- failed infrastructure apply or application deployment; and
- a runner VM that remains running after its cleanup deadline.

The readiness observer polls the existing bounded health endpoint locally and
emits only status/category metrics. It never exports raw provider errors or
dependency endpoints.

## Backup and recovery

Managed PostgreSQL performs daily backups with 14-day retention and PITR. The
media and Terraform-state buckets use versioning. The application VM has no
authoritative persistent application data.

Before first customer access, operators must perform and record:

- restoration of the current PostgreSQL backup to a temporary cluster;
- migration and application smoke against the restored cluster;
- restoration of one deleted test media object from a previous version;
- restoration of a previous Terraform-state object version in an isolated
  validation path; and
- application VM recreation followed by deployment of an approved release.

Temporary recovery resources are removed only by a separately confirmed
cleanup after evidence is recorded.

Initial operational targets are RTO within four hours and RPO within thirty
minutes. They are targets, not provider guarantees. The restore drill records
observed values, and a miss blocks go-live or requires an explicitly accepted
exception.

## Go-live gates

The public application record remains absent until all of these are evidenced:

1. Terraform plan and approved apply are clean, with no unexplained drift.
2. State, media, audit, PostgreSQL, and Lockbox deletion protections are active.
3. The Certificate Manager certificate is active.
4. Smart Web Security, WAF, rate limits, and initial allow/maintenance controls
   are verified.
5. ALB reports the backend healthy.
6. A fresh PostgreSQL backup exists and the restore drill passed.
7. Production SMTP and S3 probes pass.
8. The trusted release manifest and both image digests are recorded.
9. Deployment, external route smoke, and rollback rehearsal pass.
10. First-owner activation, login, tenant invitation, and owner/admin/manager/
    operator access boundaries are exercised for multiple users.
11. The alert channel delivers a real test notification.

Only then may a separately approved plan set `public_dns_enabled=true`. The
existing authoritative/public DNS verifier confirms exact convergence before
normal public traffic is opened.

## Verification strategy

Implementation follows test-driven, reviewable slices. Automated coverage must
include:

- direct and `behind-alb` edge modes;
- exact route parity between both modes;
- external host/scheme/client-chain propagation and spoof rejection;
- no API host binding and no unapproved production Compose services;
- Terraform formatting, validation, provider lock, and static analysis;
- contract assertions that app, runner, and PostgreSQL have no public address;
- exact ingress and east-west security-group rules;
- private buckets, media/state versioning, lifecycle, and `prevent_destroy`;
- absent public DNS at the default variable value;
- no secret values in committed variables, outputs, plan summaries, or logs;
- workload-identity subject restrictions and least-privilege IAM contracts;
- immutable release-manifest parsing and trusted-workflow linkage;
- runner startup timeout, one-use registration, cleanup, and forced stop;
- missing Lockbox payload, invalid environment, stale backup, unhealthy ALB,
  failed migration, failed readiness, failed smoke, and rollback paths;
- local production-bundle smoke using an ALB-like HTTP front end; and
- documentation contracts for bootstrap, secret rotation, deployment,
  rollback, DNS cutover, and disaster recovery.

Real Yandex Cloud apply, certificate issuance, SMTP delivery, restore drill,
and DNS cutover require approved cloud/folder IDs, organization OS Login,
domain control, notification destination, and production secret payloads. CI
must not claim those live checks passed when only local contracts ran.

## Documentation deliverables

The implementation updates or adds:

- Yandex Terraform bootstrap and operator guide;
- production infrastructure apply runbook;
- app and runner VM bootstrap/recovery guide;
- Lockbox payload and secret-rotation runbook;
- deployment and rollback runbook integrated with the existing bundle;
- PostgreSQL/media/state restore-drill runbook;
- first go-live and DNS-cutover checklist;
- architecture and MVP roadmap status.

Every example uses non-secret placeholders, avoids commands that render the
full environment or Terraform state, and distinguishes repository verification
from live cloud evidence.
