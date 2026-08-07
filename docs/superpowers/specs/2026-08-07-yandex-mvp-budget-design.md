# Yandex Cloud MVP Budget Profile

**Date:** 2026-08-07
**Status:** Verbal design approved; written review pending
**Related:** `docs/superpowers/specs/2026-08-05-yandex-saas-infrastructure-design.md`, `infra/yandex/README.md`, `docs/runbooks/yandex-first-go-live.md`, `docs/runbooks/saas-production-deploy.md`

## Problem

The production Yandex Cloud design was sized for a broader SaaS launch. The
first MVP will serve one low-volume customer, while the expected monthly cloud
budget is 15,000–18,000 RUB. The current Terraform therefore over-allocates the
application VM and PostgreSQL host and enables WAF processing before that cost is
justified.

The budget reduction must not turn the MVP into a public single-server setup or
remove controls that protect credentials, backups, auditability, and basic edge
abuse resistance.

## Goals

1. Bring the initial steady-state Yandex Cloud configuration toward the
   15,000–18,000 RUB monthly target for one low-volume customer.
2. Reduce only resources that can be scaled vertically or re-enabled without a
   topology migration.
3. Keep the application VM private and retain managed ingress, TLS, DNS,
   encryption, secrets, audit collection, and backups.
4. Retain provider-side global and per-IP rate limiting at the public edge.
5. Make the reduced capacity and WAF deferral explicit in contracts, runbooks,
   and scaling guidance.

## Non-goals

- Applying Terraform to the live cloud or changing production data.
- Replacing Yandex Managed PostgreSQL with PostgreSQL on the application VM.
- Moving the MVP to a VDS provider.
- Making the application VM, database, or deployment runner public.
- Reducing PostgreSQL storage below the provider-supported minimum, shortening
  backup retention, or weakening encryption and secret handling.
- Changing application behavior, Caddy configuration, API endpoint throttles,
  or deployment receipt semantics.
- Removing the Smart Web Security profile or Advanced Rate Limiter.

## Approved target profile

| Area               | Current configuration                                             | MVP configuration                     |
| ------------------ | ----------------------------------------------------------------- | ------------------------------------- |
| Application VM     | 4 vCPU, 8 GiB RAM, 100% core fraction                             | 2 vCPU, 4 GiB RAM, 100% core fraction |
| Managed PostgreSQL | `s2.medium`                                                       | `s3-c2-m8` (2 vCPU, 8 GiB RAM)        |
| PostgreSQL disk    | 50 GiB                                                            | unchanged                             |
| PostgreSQL backups | 14 days                                                           | unchanged                             |
| Public ingress     | ALB, Certificate Manager, DNS                                     | unchanged                             |
| Edge rate limiting | SWS security profile with global and per-IP ARL rules             | unchanged                             |
| WAF                | enabled through the SWS profile                                   | removed for the one-customer MVP      |
| Network            | private application, database, and runner subnets with NAT egress | unchanged                             |
| Security services  | KMS, Lockbox, Audit Trails, private object storage                | unchanged                             |

The runner VM profile is unchanged because it is started only for controlled
deployments and does not create the same steady-state monthly compute cost as the
always-on application VM.

## Security boundary

The ALB remains the only public application entry point on ports 80 and 443. Its
virtual host remains attached to a Smart Web Security security profile, and that
profile remains attached to the existing Advanced Rate Limiter profile. The
global and per-IP ARL rules remain fail-closed Terraform contracts.

Only the WAF profile resource and its WAF rule are removed. This is acceptable
for the initial single-customer MVP because the application already validates
its business inputs and authenticates protected routes, while ARL still limits
coarse request abuse at the provider edge. It is a deliberate temporary risk
acceptance, not a statement that WAF has no value.

Yandex Cloud documents Advanced Rate Limiter rule processing as non-billable;
requests allowed onward to other Smart Web Security rules are billed according
to those rules. WAF processing adds another paid processing layer. The pricing
reference used for this decision is
<https://yandex.cloud/ru/docs/smartwebsecurity/pricing>.

WAF must be reconsidered before any of these events:

- onboarding a second external customer;
- enabling public self-registration or other anonymous write-heavy flows;
- a customer contract or security review requires managed WAF controls;
- edge or application telemetry shows probing, exploit attempts, or abuse that
  rate limits do not adequately contain.

## Terraform and contract changes

The implementation will make the smallest coherent change:

1. Change the application VM resource block to 2 vCPU and 4 GiB RAM.
2. Change the PostgreSQL preset to `s3-c2-m8` while preserving topology, disk,
   backup retention, HA-related settings, users, and databases.
3. Remove the WAF profile, its attachment rule, and the exported WAF profile ID.
4. Preserve the SWS security profile, ARL resources, ALB attachment, IAM roles,
   security log group, and current SWS/ARL alert specifications.
5. Update Terraform contract tests first so they require the reduced sizes,
   reject a WAF resource or WAF rule, and continue to require SWS/ARL attachment.
6. Update only documentation that currently promises WAF or describes the old
   resource sizes. Earlier infrastructure specifications remain historical; this
   document supersedes only the MVP sizing and WAF decisions.

No new optional Terraform mode is introduced. The repository's production
configuration becomes the approved MVP profile, avoiding two partially tested
security and sizing branches before the first launch.

## Rollout and operations

This change is delivered as code and contract updates only. Live provisioning,
GitHub environment variables, secrets, DNS delegation, registry images, and the
first deployment remain separate operator steps after the change is merged.

Before a live apply, the operator must review `terraform plan` and confirm that
the diff contains the expected compute resize, PostgreSQL preset change, and WAF
removal without replacement of storage, database identity, network boundaries,
KMS keys, Lockbox secrets, or backup resources. Any destructive database or disk
replacement blocks the rollout until separately reviewed.

The monthly amount remains an estimate rather than a hard Terraform guarantee.
Actual cost varies with traffic, log volume, object storage, NAT egress, public
IP usage, and provider pricing. Billing alerts and the first complete billing
period must be used to validate the 15,000–18,000 RUB target.

## Capacity triggers

The reduced profile is intentionally vertical-first. Scale the application VM
before adding replicas when sustained production telemetry shows any of the
following under normal customer load:

- CPU above 70% for 15 minutes;
- memory above 80% for 15 minutes;
- repeated readiness failures, restarts, or latency alerts attributable to host
  saturation.

Scale PostgreSQL when sustained CPU, memory, connection pressure, query latency,
or storage alerts show exhaustion rather than an isolated deployment or batch
spike. Any PostgreSQL resize must preserve backups and be executed through the
provider-supported maintenance path.

## Verification and acceptance

Implementation is accepted when:

- focused Terraform contract tests fail on the old configuration and pass on the
  MVP configuration;
- the full Yandex infrastructure contract suite passes;
- production bundle and documentation contracts affected by the wording pass;
- `terraform fmt -check` and `terraform validate` pass where provider access and
  initialization are available;
- `git diff --check` and repository formatting checks pass;
- the final diff contains no unrelated application, database schema, Caddy, or
  CI behavior changes;
- automated results are reported separately from the unperformed live
  `terraform plan`, apply, DNS/TLS, billing, and load validation.
