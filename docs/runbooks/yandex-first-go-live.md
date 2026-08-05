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

9. **First deployment rehearsal, still without public DNS.** First dispatch the
   protected **Deploy production** workflow manually with
   `deployment_phase=first`, `rollback_rehearsal=true`, and
   `rehearsal_run_id=none`; automatic
   `workflow_run` delivery always fixes this input to false. Its authoritative order is: materialize runtime
   secrets; start the private edge; probe
   `http://127.0.0.1:8080/health/ready` on the app VM with the production
   `Host` header; wait for ALB back-end `HEALTHY`; then probe the reserved ALB
   address via `curl --resolve <production-domain>:443:<reserved-alb-ip>`.
   This preserves TLS SNI and the production hostname without creating public
   DNS. The rehearsal deterministically stops after the candidate is running and
   before finalize; it must stop both candidate services and record the candidate
   failed because it has no previous healthy release. Retain the bounded
   `markiro-rollback-rehearsal-<release-sha>` artifact. The live
   `/opt/markiro/active-release` pointer remains absent (or unchanged if this
   check is being repeated); it never points at the failed rehearsal candidate.
   Wait for the independent `production-cleanup` job to succeed and retain its
   bounded `markiro-cleanup-<release-sha>` artifact from the same workflow run.
   Confirm that the deployment runner registration is absent and the runner VM is stopped.
   Record that run ID as `<successful-rollback-rehearsal-run-id>`. Only then
   dispatch the same approved release again with `deployment_phase=first`,
   `rehearsal_run_id=<successful-rollback-rehearsal-run-id>`, and
   `rollback_rehearsal=false` for the successful first deployment. The
   controller authenticates that exact successful rehearsal run, SHA, workflow,
   ref, inputs, rehearsal artifact, and cleanup receipt before starting a new
   runner. A
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

1. Obtain approval for the separately protected `production-dns-convergence`
   environment, then dispatch **DNS convergence verification** from `main` with
   the exact DNS-apply run that produced the approved release-specific artifact:

```text
release_sha=<current-main-40-character-sha>
dns_apply_run_id=<successful-approved-dns-apply-run-id>
```

The workflow authenticates the successful DNS-apply run and artifact digest,
runs the real `deploy/production/verify-dns.mjs` implementation against the
protected authoritative server, public resolvers, and exact approved A/AAAA
sets, then uploads an immutable convergence receipt. Record its successful
workflow run ID as `<successful-dns-convergence-run-id>`.

2. Only after that verifier succeeds, obtain approval for the dedicated
   `production-public-smoke` environment.
   This boundary authorizes only public read/route probes from the GitHub-hosted
   runner; it does not authorize infrastructure or application mutation.
   Prepare these exact dispatch inputs from the protected records:

```text
release_sha=<current-main-40-character-sha>
release_run_id=<publish-production-images-run-id>
deployment_run_id=<successful-first-deployment-run-id>
dns_apply_run_id=<successful-approved-dns-apply-run-id>
dns_verifier_run_id=<successful-dns-convergence-run-id>
```

3. Dispatch **Post-DNS production smoke** with those inputs. The workflow
   rejects an alternate-ref dispatch, serializes with production deployment,
   verifies that the release is still current `main`, authenticates the exact
   finalized first-release, DNS-apply, and DNS-convergence artifacts and their
   ordering, and only then runs the full public route smoke through
   `https://MARKIRO_DOMAIN`. It checks the live release header and rechecks
   current `main` immediately before and after the smoke. It
   never prepares, migrates, starts, finalizes, rolls back, or redeploys the
   application. Do not dispatch `deployment_phase=repeat` merely to obtain this
   smoke.
4. The receipt proves only TLS, routes, security headers, readiness,
   documentation, proxy behavior, and the exact live release identity exercised
   by this smoke. SWS/ARL and alert-delivery confirmation remain separate
   protected gate records; attach those real records to the go-live change and
   never infer them from the smoke receipt. This is the post-cutover public
   smoke and is not part of the pre-DNS first-deployment workflow.
5. Record convergence, smoke, SWS/ARL, and alert-delivery evidence IDs in the
   protected system. If any
   verifier fails, stop traffic expansion and follow the rollback procedure.
