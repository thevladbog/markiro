# v-b.tech Private Web Executor Design

**Status:** Approved direction, implementation pending

**Date:** 2026-08-21

## Purpose

Deploy the immutable v-b.tech static image on the existing Markiro production VM without a new
machine, public DNS changes, Cloud Functions, database changes, or contact-form activation. The
Markiro repository remains the only owner of the VM, Docker Compose project, Caddy process,
production SSH credentials, and runtime rollback state.

This design covers the first Markiro pull request only. A later v-b.tech pull request will update
its protected deployment handoff and runbooks to consume the executor defined here.

## Current state

Markiro already contains the shared-edge integration required by the static site:

- `deploy/production/compose.vbtech.yml` defines one hardened `vbtech-web` service with no host
  ports.
- `deploy/production/Caddyfile` owns the exact `v-b.tech` and `www.v-b.tech` authorities.
- `deploy/production/deploy.mjs` can include a v-b image in a Markiro release candidate.
- the live edge already has the v-b authority, but returns `502` because `vbtech-web` is absent.

The remaining boundary is operational. `.github/workflows/deploy-production.yml` accepts only a
Markiro release and cannot independently verify or deploy an immutable v-b image. Reusing the
Markiro release record for each v-b update would couple the two products and would reject repeat
deployment of the same healthy Markiro SHA.

The current runtime diagnostic is also insufficient for capacity acceptance. Version 2 reports
service health and release identity but not CPU, memory, root-filesystem headroom, the Compose
network, or `vbtech-web`. Its generic `ECONNREFUSED` rule can label a Caddy upstream failure as a
database connection failure even though the edge does not connect to PostgreSQL.

## Goals

- Deploy v-b.tech as an independently versioned static service inside the existing
  `markiro-production` Compose project.
- Verify the exact v-b source SHA, OCI digest, repository, signer workflow, source branch, and
  attestation before remote mutation.
- Keep the contact surface server-side disabled. `POST /api/contact` must not invoke an external
  function and must return the existing disabled response contract.
- Preserve a healthy v-b deployment across ordinary Markiro releases without requiring v-b inputs
  on every Markiro deployment.
- Roll back v-b independently without migrating, restarting, or replacing the Markiro API.
- Measure sanitized host capacity before and after deployment so the no-resize decision is based on
  real evidence.
- Smoke the private edge without changing public DNS and without claiming v-b TLS acceptance.

## Non-goals

- Creating or resizing a VM.
- Creating Cloud Functions, triggers, VPC subnets, security-group rules, PostgreSQL objects,
  Lockbox entries, service accounts, Object Storage buckets, SmartCaptcha resources, or Postbox
  identities.
- Changing external DNS or requesting a certificate for `v-b.tech`.
- Enabling the contact form or accepting a real contact submission.
- Changing Markiro application routes, database schema, frontend bundles, or API images.
- Automatically dispatching a cross-repository workflow. The first live run remains a separately
  approved operator action.

## Chosen architecture

### Markiro-owned executor

Add a separate protected workflow, `deploy-vbtech-production.yml`, to the Markiro repository. It
uses the existing `production-deploy` environment, SSH identity, authenticated host-key inventory,
registry transport, and `markiro-production-deployment` concurrency group. It does not modify the
existing Markiro release workflow inputs.

The workflow accepts exactly:

- `vbtech_release_sha`: one lowercase 40-character Git SHA;
- `vbtech_image_digest`: one lowercase `sha256:` digest;
- `confirm_private_deploy`: an explicit boolean confirmation.

Submission state is not an input in this phase. The workflow hard-codes it to `disabled`.

Before SSH, the workflow constructs
`ghcr.io/thevladbog/vbtech-web@<vbtech_image_digest>` and verifies its GitHub artifact attestation
against all of these predicates:

- repository `thevladbog/v-b`;
- signer workflow `thevladbog/v-b/.github/workflows/publish.yml`;
- source digest equal to `vbtech_release_sha`;
- source ref `refs/heads/main`;
- OCI subject equal to the supplied immutable image digest.

Mutable tags, foreign repositories, partial inputs, uppercase hashes, and an unconfirmed dispatch
fail before any remote command.

### Independent v-b runtime state

The remote executor maintains v-b lifecycle evidence separately from Markiro release records under
`/var/lib/markiro/vbtech/releases/`. Records are private, atomically written, bounded JSON and use
the states `pending`, `healthy`, and `failed`. A healthy record contains only:

- v-b source SHA;
- exact OCI image reference and digest;
- submission state `disabled`;
- creation time;
- terminal state.

No credentials, request bodies, environment dumps, container logs, or contact payloads are stored.
The latest structurally valid healthy record is the active v-b release. A repeat of the same healthy
SHA and digest is rejected before mutation. A failed attempt cannot replace the active record.

The executor runs from the active, validated Markiro release directory but has its own entrypoint
and lifecycle. It uses the committed base Compose file plus `deploy/production/compose.vbtech.yml`
with the stable project name `markiro-production`. It may pull and replace only `vbtech-web` and
recreate `edge` with the already active Markiro image and validated public configuration. It never
runs migrations and never starts, stops, recreates, or inspects application secrets for `api` or
`migrate`.

### Preservation during Markiro releases

Ordinary Markiro deployments read the latest structurally valid healthy v-b record on the VM. If
one exists, the new Markiro candidate carries that exact v-b image, release SHA, and disabled state
into its Compose model and release evidence. If none exists, Markiro remains a Markiro-only
deployment.

No optional workflow input can silently remove v-b. Removal is outside this phase and requires a
separate reviewed operation. A malformed or ambiguous v-b state stops the Markiro deployment
before mutation instead of dropping the site.

This preservation rule keeps both products independently releasable:

- a v-b deployment changes the v-b container and shared edge only;
- a Markiro deployment changes its normal candidate while carrying the active v-b selector
  unchanged;
- rollback restores the previous selector set owned by the failing operation.

## Disabled contact behavior

`VBTECH_SUBMISSION_STATE` is always `disabled` in this phase. A function origin is not required and
must not be invented. Preflight accepts an absent function origin only when submission is disabled.
The Caddy route continues to reserve `/api/contact`, but its function proxy matcher cannot match in
the disabled state. All other `/api` routes remain rejected.

Tests must prove that disabled configuration parses without a function identifier, that no function
upstream is contacted, and that enabled or partial configuration still fails closed.

## Deployment sequence

1. Validate workflow inputs and explicit confirmation.
2. Verify the exact OCI digest and attestation before preparing SSH credentials.
3. Collect runtime diagnostic version 3 as the before snapshot.
4. Validate the active Markiro release directory, active Markiro image digests, Compose project,
   Caddy authority contract, and current v-b state.
5. Write a pending v-b record atomically.
6. Pull the exact digest reference and verify that Docker reports the approved repository digest.
7. Start only `vbtech-web` and wait for its bounded health check.
8. Recreate only `edge` with the active Markiro selector and the candidate v-b selector.
9. Run the private disabled smoke through the existing public IP using the valid Markiro TLS SNI
   while sending the exact `Host: v-b.tech` authority.
10. Mark the candidate healthy only after smoke succeeds.
11. Collect diagnostic version 3 as the after snapshot and emit a bounded capacity delta.

The private smoke proves routing and content only. It does not prove public DNS, a v-b certificate,
or public reachability.

## Failure and rollback

- Failure before `vbtech-web` replacement records the candidate failed and leaves the active
  service untouched.
- Failure after the candidate container starts but before edge activation stops the candidate and
  restores the previous healthy v-b service, if any.
- Failure after edge activation recreates edge with the previous healthy v-b selector, verifies the
  restored private route, and then marks the candidate failed.
- On the first deployment, rollback removes only the failed candidate service and restores the
  validated Markiro-only edge configuration.
- A rollback failure is reported together with the primary sanitized stage name; it never triggers
  DNS, API, database, or cloud mutations.

Every remote stage has a finite timeout. Error output is bounded and classified without echoing
environment values or raw container logs.

## Runtime diagnostic version 3

Extend the existing probe with sanitized, bounded fields:

- host CPU busy basis points sampled over a fixed short interval;
- total and available memory bytes;
- total and available root-filesystem bytes;
- the exact Compose network name after validating its project label;
- `vbtech-web` state, health, OOM state, and release SHA, or an explicit `missing` state;
- the active v-b SHA and digest from validated private state;
- an `upstream_connectivity` error class for edge-to-service failures.

The probe continues to omit process arguments, environment values, IP inventories, Docker logs,
container names outside the allowlist, and secret material. Version 2 parsing remains rejected by
version 3 consumers so stale evidence cannot satisfy the capacity gate.

The acceptance record compares before and after snapshots and calculates CPU, available-memory,
and available-disk deltas. It may recommend keeping the current VM size only from actual version 3
evidence; the repository does not encode a guessed capacity threshold.

## Private smoke contract

The executor uses the existing Markiro certificate and SNI solely as a trusted transport to the
known VM, then overrides the HTTP authority to `v-b.tech`. It verifies:

- root, English root, legal, privacy, and consent HTML routes;
- exact `X-Vbtech-Release-Sha` identity;
- v-b CSP and security headers;
- canonical `www` redirect behavior at the authority layer;
- normal branded 404 behavior;
- rejected reserved API routes;
- disabled `POST /api/contact` behavior;
- no host port published by `vbtech-web`.

The output contains only status, route labels, release identity, header markers, and pass/fail
metadata. HTML bodies are not retained.

## Test strategy

Implementation follows test-first development.

- Workflow contracts verify protected manual dispatch, exact permissions, pinned actions,
  concurrency, confirmation, disabled-only state, OCI attestation predicates, and no DNS or cloud
  commands.
- Remote-executor unit tests verify immutable input parsing, active Markiro validation, digest
  inspection, stage order, timeouts, atomic v-b records, first-install recovery, replacement
  rollback, and secret-free errors.
- Existing staged-deployment tests gain preservation cases proving that normal Markiro releases
  carry the active v-b selector and reject malformed state.
- Preflight and Caddy tests prove that disabled deployment needs no function origin and cannot proxy
  a contact request.
- Diagnostic tests verify every version 3 bound, resource calculation, network-label check,
  `vbtech-web` allowlist, and corrected upstream classification.
- Private-smoke tests verify separate TLS SNI and HTTP authority, exact route coverage, release
  mismatch rejection, and the explicit TLS/DNS evidence boundary.
- The final gate is the complete production contract suite and formatting checks. Live deployment,
  public DNS, v-b TLS, Cloud Functions, PostgreSQL, Postbox, SmartCaptcha, and form acceptance remain
  separately unrun.

## Operational approval boundary

Merging this code does not authorize a deployment. The first workflow dispatch requires a new
approval naming the exact v-b SHA and image digest. It authorizes only the private disabled web
deployment and diagnostic snapshots on the existing VM. It explicitly excludes Cloud Functions,
database objects, IAM, Lockbox, Object Storage, VPC, DNS, public exposure, and form activation.
