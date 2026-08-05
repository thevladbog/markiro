# Open the first Yandex SaaS tenant

Keep public DNS disabled until every ordered gate passes. This checklist proves
repository readiness, not a live rollout. Run it only after the user supplies
real cloud IDs, domain control, notification destination, secret payloads, and
explicit apply authority. Store evidence IDs only in the protected operational
system.

## Complete the eleven gates

<!-- runbook-contract:go-live-gate-01-plan-drift -->

1. **Protected plan and drift.** Generate a current-main saved plan through
   `production-infrastructure`. Confirm no unexpected drift, replacement,
   deletion, or state migration exists. Approve only that plan.

<!-- runbook-contract:go-live-gate-02-durable-protection -->

2. **Durable-resource protection.** Confirm state, media, audit, PostgreSQL,
   and Lockbox resources retain `prevent_destroy`; verify state, media, and
   audit use distinct private buckets.

<!-- runbook-contract:go-live-gate-03-certificate -->

3. **Certificate.** Confirm the existing DNS zone is delegated and Certificate
   Manager validation records are present. Verify the certificate is active for
   the exact production domain while `public_dns_enabled=false`.

<!-- runbook-contract:go-live-gate-04-alb-waf-arl -->

4. **Ingress protection before the first application release.** Verify the
   reserved ALB address, HTTPS listener, active Certificate Manager certificate,
   Smart Web Security (SWS) web application firewall (WAF) profile, and Advanced
   Rate Limiter (ARL) profile use the reviewed hostname and private back-end
   configuration. Do **not** require a `HEALTHY` back end yet: the first app
   release has not started the edge listener. Keep the app VM private.

<!-- runbook-contract:go-live-gate-05-alert-specs -->

5. **Monitoring alerts.** Create every alert manually from
   `module.observability.alert_specs`. The provider has no alert mutation.
   Verify exact alert IDs, notification-channel ID, query, threshold, and
   evaluation window in the protected configuration.

<!-- runbook-contract:go-live-gate-06-backup-restore -->

6. **Backup and restore.** Confirm PostgreSQL daily backups, 14-day retention,
   PITR, and a successful temporary PostgreSQL/media/state/VM recovery drill.
   Record observed RTO/RPO and cleanup evidence.

<!-- runbook-contract:go-live-gate-07-smtp-s3 -->

7. **SMTP and S3.** Load runtime payloads through the secrets runbook. Verify a
   controlled SMTP delivery and private S3 media access without exposing object
   URLs or credentials.

<!-- runbook-contract:go-live-gate-08-release-manifest -->

8. **Release manifest.** Confirm the approved release manifest binds the exact
   successful 40-character commit to both GHCR image digests. Retain GHCR
   packages under the approved retention policy; reject mutable tags.

<!-- runbook-contract:go-live-gate-09-deploy-smoke-rollback -->

9. **First deployment rehearsal, still without public DNS.** Dispatch the
   protected **Deploy production** workflow manually with
   `deployment_phase=first`. Its authoritative order is: materialize runtime
   secrets; start the private edge; probe
   `http://127.0.0.1:8080/health/ready` on the app VM with the production
   `Host` header; wait for ALB back-end `HEALTHY`; then probe the reserved ALB
   address via `curl --resolve <production-domain>:443:<reserved-alb-ip>`.
   This preserves TLS SNI and the production hostname without creating public
   DNS. The workflow finalizes only after those probes. Rehearse the failure
   path too: the first deployment must stop both candidate services and record
   the candidate failed because it has no previous healthy release. A
   `deployment_phase=repeat` run instead requires the previous ALB back end to
   be healthy and performs public-hostname smoke only after DNS has been
   approved and applied.

<!-- runbook-contract:go-live-gate-10-tenant-rbac -->

10. **Tenant RBAC.** Create an isolated test tenant with multiple users and
    roles. Verify cross-tenant denial and role boundaries through authorized
    application tests.

<!-- runbook-contract:go-live-gate-11-notification-delivery -->

11. **Notification delivery.** Trigger and receive an authorized test for every
    Monitoring notification path and deployment failure alert. Record delivery
    evidence without copying messages or destinations into Git or chat.

## Apply the separately approved public DNS plan

<!-- runbook-contract:go-live-public-dns-apply -->

1. Obtain a separate approval for the exact `production-public-dns`
   environment. A true workflow input is not approval. Reconfirm all eleven
   gate records, the current main SHA, ALB address, and rollback contact.
2. Dispatch **Yandex infrastructure** for the current 40-character `main` SHA
   with `enable_public_dns=true`. This must enter the separately protected
   `production-public-dns` environment before the protected infrastructure
   plan is created with `public_dns_enabled=true`.
3. Review the new sanitized plan. Confirm it changes only the approved
   application A record and retains all durable-resource protections.
4. Approve the protected saved-plan apply through
   `production-infrastructure`. Do not run local Terraform apply and do not
   use automatic approval.

## Verify authoritative and public DNS convergence

<!-- runbook-contract:go-live-dns-convergence -->

1. Run the existing convergence verifier from the approved checkout. It checks
   both the authoritative zone and public recursive resolution before normal
   Smart Web Security (SWS) traffic is opened. Enter only non-secret DNS values.

```bash
set -euo pipefail
read -r -p 'Production domain: ' MARKIRO_DOMAIN
read -r -p 'Authoritative DNS server: ' MARKIRO_AUTHORITATIVE_DNS_SERVER
read -r -p 'Approved public DNS resolvers (comma-separated): ' MARKIRO_PUBLIC_DNS_RESOLVERS
read -r -p 'Approved ALB IPv4 address: ' MARKIRO_APPROVED_DNS_A
read -r -p 'Approved ALB IPv6 addresses, or none: ' MARKIRO_APPROVED_DNS_AAAA
export MARKIRO_DOMAIN MARKIRO_AUTHORITATIVE_DNS_SERVER MARKIRO_PUBLIC_DNS_RESOLVERS
export MARKIRO_APPROVED_DNS_A MARKIRO_APPROVED_DNS_AAAA
node deploy/production/verify-dns.mjs
unset MARKIRO_DOMAIN MARKIRO_AUTHORITATIVE_DNS_SERVER MARKIRO_PUBLIC_DNS_RESOLVERS
unset MARKIRO_APPROVED_DNS_A MARKIRO_APPROVED_DNS_AAAA
```

2. Run the authorized HTTPS smoke through the public hostname **only now**,
   after DNS convergence. Confirm the certificate, SWS/ARL behavior, backend
   readiness, and alert delivery. This is the post-cutover public smoke; it is
   not part of the pre-DNS first-deployment workflow.
3. Record convergence and smoke evidence IDs in the protected system. If any
   verifier fails, stop traffic expansion and follow the rollback procedure.
