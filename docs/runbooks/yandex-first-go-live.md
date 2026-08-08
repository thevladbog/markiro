# Open the first Yandex SaaS tenant

Keep public DNS disabled until every ordered gate passes. This checklist proves
repository readiness, not a live rollout. Run it only after the user supplies
real cloud IDs, domain control, notification destination, secret payloads, and
explicit apply authority. Store evidence IDs only in the protected operational
system.

Set `MARKIRO_KIOSK_DOMAIN=kiosk.markiro.app` beside `MARKIRO_DOMAIN` in each
protected environment that carries `MARKIRO_DOMAIN`. The
desktop Tauri kiosk remains outside this web/TLS gate. This procedure gates only
the browser kiosk PWA served by the protected ingress.

## Complete the eleven gates

<!-- runbook-contract:go-live-gate-01-plan-drift -->

1. **Protected plan and drift.** Generate a current-main saved plan through
   `production-infrastructure`. With `public_dns_enabled=false`, expect exactly
   one additional kiosk certificate and
   one additional kiosk certificate validation record, with no replacement and
   no deletion of existing ingress or durable resources. Confirm no other
   unexpected drift or state migration exists. Approve only that plan.

<!-- runbook-contract:go-live-gate-02-durable-protection -->

2. **Durable-resource protection.** Confirm state, media, audit, PostgreSQL,
   and Lockbox resources retain `prevent_destroy`; verify state, media, and
   audit use distinct private buckets.

<!-- runbook-contract:go-live-gate-03-certificate -->

3. **Certificates.** Confirm the existing DNS zone is delegated and both
   Certificate Manager validation records are present. Verify
   issued status for both certificates. Confirm their exact admin and kiosk
   domains while `public_dns_enabled=false`.

<!-- runbook-contract:go-live-gate-04-alb-sws-arl -->

4. **Ingress protection before the first application release.** Verify the
   reserved ALB address, HTTPS listener, both active Certificate Manager
   certificates, Smart Web Security (SWS) profile, and attached Advanced Rate
   Limiter (ARL) profile use the reviewed hostname and private back-end
   configuration. Confirm both the global and per-IP ARL rules. The reviewed
   transition plan may contain approved WAF destroy actions for WAF resources
   managed by the prior configuration. Reject the plan if it contains any
   WAF create, update, or unchanged actions.
   After the approved removals are applied, confirm that no WAF resources remain in
   the configuration, state, or a fresh plan. Do **not** require a
   `HEALTHY` back end yet: the first app release has not started the edge listener.
   Keep the app VM private.

<!-- runbook-contract:go-live-gate-05-alert-specs -->

5. **Monitoring alerts.** Create every alert manually from
   `module.observability.alert_specs`. The provider has no alert mutation. For
   `certificate_risk`, update the console alert from the two-certificate artifact
   while retaining the existing `certificate_risk` alert ID. Verify
   exact alert IDs, notification-channel ID, query, threshold, and evaluation
   window in the protected configuration.

<!-- runbook-contract:go-live-gate-06-backup-restore -->

6. **Backup and restore.** Confirm PostgreSQL daily backups, 14-day retention,
   PITR, and a successful temporary PostgreSQL/media/state/VM recovery drill.
   Record observed RTO/RPO and cleanup evidence.

<!-- runbook-contract:go-live-gate-07-smtp-s3 -->

7. **SMTP and S3.** Load runtime payloads through the secrets runbook and
   complete its pre-first activation materialization checks. At this point no
   candidate or active bundle exists, so `required_unavailable` is the expected
   sanitized observer result rather than candidate health evidence. The later
   workflow rehearsal performs the authoritative candidate-bound preflight and
   readiness sequence. Do not claim real SMTP delivery or S3 access from this
   pre-first materialization check. Verify those operations only after the
   candidate-bound path is available, without exposing object URLs or
   credentials. Perform a sanitized comparison that reveals neither the Lockbox
   payload nor its values and records only that `KIOSK_ORIGIN=https://kiosk.markiro.app`
   is present exactly once and matches the protected kiosk domain.

<!-- runbook-contract:go-live-gate-08-release-manifest -->

8. **Release manifest.** Confirm the approved release manifest binds the exact
   successful 40-character commit to both GHCR image digests. Retain GHCR
   packages under the approved retention policy; reject mutable tags.

<!-- runbook-contract:go-live-gate-09-deploy-smoke-rollback -->

9. **First deployment rehearsal, still without public DNS.** First dispatch the
   protected **Deploy production** workflow manually with
   `deployment_phase=first`, `rollback_rehearsal=true`, and
   `rehearsal_run_id=none`, `rehearsal_run_attempt=none`; automatic
   `workflow_run` delivery always fixes this input to false. Its authoritative
   order is: transfer the immutable candidate bundle; materialize runtime
   secrets; run candidate-bound preflight; start the private edge; probe
   `http://127.0.0.1:8080/health/ready` on the app VM with the production
   `Host` header; wait for ALB back-end `HEALTHY`; then privately probe the same
   reserved ALB address via both
   `curl --resolve <admin-domain>:443:<reserved-alb-ip>` and
   `curl --resolve <kiosk-domain>:443:<reserved-alb-ip>`. These probes preserve
   TLS SNI and both production authorities without creating public DNS. The
   rehearsal deterministically stops after the candidate is running and
   before finalize; it must stop both candidate services and record the candidate
   failed because it has no previous healthy release. Retain the bounded
   `markiro-rollback-rehearsal-<release-sha>-attempt-<rehearsal-run-attempt>`
   artifact. The live
   `/opt/markiro/active-release` pointer remains absent (or unchanged if this
   check is being repeated); it never points at the failed rehearsal candidate.
   Wait for the independent `production-cleanup` job to succeed and retain its
   bounded `markiro-cleanup-<release-sha>-attempt-<rehearsal-run-attempt>`
   artifact from the same workflow run attempt.
   Confirm that the deployment runner registration is absent and the runner VM is stopped.
   Record that run ID as `<successful-rollback-rehearsal-run-id>` and its current
   successful attempt as `<successful-rollback-rehearsal-run-attempt>`. A rerun
   keeps the run ID but changes the attempt; never reuse evidence from an older
   attempt. Only then
   dispatch the same approved release again with `deployment_phase=first`,
   `rehearsal_run_id=<successful-rollback-rehearsal-run-id>`, and
   `rehearsal_run_attempt=<successful-rollback-rehearsal-run-attempt>`, and
   `rollback_rehearsal=false` for the successful first deployment. The
   controller authenticates that exact successful rehearsal run, SHA, workflow,
   ref, inputs, rehearsal artifact, and cleanup receipt before starting a new
   runner. A successful finalized first deployment creates
   `/opt/markiro/active-release`; only after its authenticated finalized-release
   evidence exists, complete the secrets runbook's post-activation active-path
   verification against the exact successful SHA. A `deployment_phase=repeat`
   run instead requires the previous ALB back end to be healthy and performs
   public-hostname smoke only after DNS has been approved and applied.

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
3. Review the new sanitized plan. Confirm the one approved apply
   publishes both approved A records, one for the exact admin domain and one for
   the exact kiosk domain, to the same reserved ALB address and retains all
   durable-resource protections.
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
sets for both domains, then uploads an immutable two-domain convergence receipt.
It must bind the exact distinct admin and kiosk names to independently sorted,
nonempty answer sets containing the same approved ALB address. Record its
successful workflow run ID as `<successful-dns-convergence-run-id>`.

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
   ordering, and only then runs the full public route smoke through both
   `https://MARKIRO_DOMAIN` and `https://MARKIRO_KIOSK_DOMAIN`. It checks the live
   release header on both authorities and rechecks
   current `main` immediately before and after the smoke. It
   never prepares, migrates, starts, finalizes, rolls back, or redeploys the
   application. Do not dispatch `deployment_phase=repeat` merely to obtain this
   smoke.
4. The two-domain post-DNS smoke receipt proves only TLS, routes, security headers, readiness,
   documentation, proxy behavior, and the exact live release
   identity exercised by this smoke. SWS/ARL and alert-delivery confirmation remain separate
   protected gate records; attach those real records to the go-live change and
   never infer them from the smoke receipt. This is the post-cutover public
   smoke and is not part of the pre-DNS first-deployment workflow.
5. Record convergence, smoke, SWS/ARL, and alert-delivery evidence IDs in the
   protected system. If any
   verifier fails, stop traffic expansion and follow the rollback procedure.
