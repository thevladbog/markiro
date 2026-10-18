# Protected platform image release for Timeweb

## Intent and scope

PR #731 was merged as `0ca0433f1ef2695667da1ad6bc9ef9ba1e6c4a96`.
The user resumed migration and delegated the implementation choices. The target
remains Markiro only, one 2 vCPU / 4 GiB VM, with local PostgreSQL and private S3.
Existing Timeweb mail, current production and DNS remain intact during preparation.

The first deliverable is a protected publisher for the exact platform-only API
and edge images. This is a prerequisite for a protected host deployment, not a
host deployment in itself. Existing legacy publishing and deployment stay intact.
No provider purchase, SSH, DNS, database restore or production mutation is part of
this code change. Subsequent host delivery must be a separately reviewed change.
Do not provision an idle paid VM before release and restore tooling are ready.

## Current evidence

The existing platform manifest strictly binds profiles, source/tooling SHA, image
digests, workflow run and timestamp. The local CI harness builds on a private
synthetic stack, runs migrations twice, checks the exact worker set and disabled
routes, verifies edge TLS against its own Caddy CA, and renders login/landing.
PR #731 CI passed. The main merge CI is a new run and must pass independently.
The current publisher only exports legacy edge images. The existing
`production-deploy` GitHub environment has required reviewers and main branch
restrictions; reuse this protected boundary for the publisher's write job.

The Timeweb project currently shows private S3 `markiro-tmp-media`, mail
`no-reply@markiro.app` and domain `markiro.app`, without a VM. Today's encrypted
backup report records an isolated PostgreSQL restore but excludes ownership/ACL
reproduction. These are observations, not completed cutover gates.

## Release trust and workflow

Add `.github/workflows/release-platform-images.yml`, manual dispatch only, main
only, named `Publish platform images`. It takes one `ci_run_id` input. The
publisher releases its own immutable dispatch SHA: sourceSha and toolingSha both
equal `github.sha`. A successful CI run for that exact main push is required;
reject pull-request/manual/fork runs, wrong repository/path/branch/SHA, incomplete
or failed runs, malformed IDs and missing expected fields. A global success with
a skipped mandatory bundle is insufficient: verify the successful
`production-bundle` and `ci-required` jobs for the exact successful run attempt.
Paginate jobs, or fail if the selected attempt exceeds the fetched complete page.

Build/test in a read-only GitHub-token job. Build API and platform edge once on
Linux amd64, run all platform contracts and the existing isolated platform CI
harness, then export those same verified image IDs as a Docker archive. Preserve
sanitized HTTP/browser evidence. Use existing public landing build variables.
Never upload runtime env, keys, full container logs or arbitrary temp directories.

A second job depends on verification, uses `environment: production-deploy`, and
has only contents:read and packages:write permissions needed for publication.
Download the exact artifact ID from the first job of this run. Before Docker load,
validate the evidence's exact shape, profiles, SHAs, run ID/attempt, expected image
repositories/tags/IDs and archive SHA256. Require regular non-symlink files.
After load compare Docker image IDs to the verified IDs, and push precisely them
without rebuilding. Tags include `platform-<sha>-<runId>-<attempt>` to avoid
rewriting the legacy `<sha>` API tag. Runtime use always references digests.

Before publication, revalidate that both local images are the expected IDs.
Resolve each resulting registry digest only from the matching repository, require
one unambiguous sha256 digest, and write the existing strict platform manifest.
Publish manifest plus separate release evidence (including verified archive
hash, image IDs and CI binding) as a uniquely run/attempt-named artifact. Do not
expand the version-1 runtime manifest or make it acceptable to legacy tooling.
No `latest`, automatic deploy, PR execution with write tokens, secrets in code,
mutable artifact-name lookup or silently successful publication without manifest.

## Code boundaries

Use small Node modules under `deploy/platform/` for trusted-CI validation and
verified-image evidence/artifact validation, with injectable inputs and generic
safe errors. A thin CLI may read protected local files, GitHub JSON downloaded by
the workflow, and call Docker with argument arrays. Follow existing exact-pinned
Actions and Node 24 / Corepack pnpm conventions. No dependency/lockfile changes.
GitHub API transport must retain HTTPS verification and avoid logging tokens or
untrusted full responses. Contract tests must exercise rejection behavior, not
only string-match workflow contents; workflow wiring tests supplement them.

## Acceptance

Focused failing-first tests cover wrong CI provenance/attempt/job completeness;
archive substitution; source/tooling/run/profile/tag mismatches; invalid or
ambiguous digests; symlinks; and image ID changes after verification. A valid
fixture roundtrip creates a manifest accepted by the platform parser and rejected
by the legacy parser. Existing 34 platform, production-bundle and CI-policy
contracts must remain green. Format and diff checks pass. Independent review
precedes push/PR. Actual protected publication is validated only after main merge
and environment approval; local mock/contract tests are not registry evidence.

## Next migration stages

1. Review and merge this publisher; dispatch on an exact green main SHA, approve
   the protected publication, then verify registry bytes/IDs and release artifacts.
2. Implement/review protected Timeweb host delivery: pinned SSH, clean environment,
   profile-aware release state, phase ordering and failure recovery. Supply Linux
   bootstrap, PostgreSQL roles/TLS and rehearsal egress isolation. Preserve legacy
   queues and prevent mail/report side effects while restoring a copy.
3. Confirm current Timeweb price and provision only the compact target. Measure
   restored database/index/WAL/image/restore workspace size before accepting disk.
   Restore fresh backup into new resources; reconcile keys, roles, object hashes,
   migration journal, tenant/license/audit records, sequences and pending intents.
4. Validate exact release under compact quotas, independent encrypted backup and
   restore, SMTP/S3, auth, licensing and reports. Preserve release-download URLs
   and signed artifacts; moving those is a separate gate before retiring Yandex.
5. Agree one-writer cutover: fence old writers/workers, final DB/S3 delta, then
   DNS/TLS and controlled target writes. Preserve MX/SPF/DKIM/DMARC. Rollback after
   new writes needs reconciliation, not DNS reversal alone. Retain old resources
   until acceptance; no CRM/n8n/Chatwoot migration or landing redesign here.
