# US-11 separate read-only viewer implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans task-by-task. Preserve the chosen separate implementer and independent reviewer method. Root alone stages, commits and pushes explicit reviewed paths.

**Goal:** A separately provisioned synthetic auditor can authenticate normally,
browse the accepted six-month dataset and download immutable results without
business write or package-generation authority.

**Architecture:** Separate internal viewer store/CLI composes existing trusted
owner, credential and membership patterns. Existing server capability/MFA checks
remain authoritative; the cabinet adds only presentation metadata/labels. New
owned HTTP and full-volume browser gates establish the complete viewer journey.

**Tech Stack:** Existing Node24, TypeScript/Nest/Better Auth/Drizzle/Postgres,
React/Vite/Zod, Vitest/Node tests and pinned Playwright; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-22-us-11-demo-viewer-design.md` and both
accepted2026-10-06 single-tenant/six-month specifications.

## Global Constraints

- Only US worktree `/Users/thevladbog/PRSOME/q/.worktrees/us-docs-audit`, codex/us-mvp;
  preserve hosting document and every ignored/raw historical failure artifact.
- Exact separate viewer, raw `traceability_auditor`, READ+EXPORT_READ only; normal
  password/MFA/current membership; no owner conversion/role union/auth bypass.
- Password bounded non-TTY stdin only, never argv/env/log/file/screenshot; no
  credential/MFA reset, public signup/invite, email dependency or secret sharing.
- No generic auth-policy/schema/dependency/environment/provider SDK/image change.
- Exact CLI actual DB markiro_us_dev/user markiro_us/loopback55432; no primary/base
  writes. Owned child integration is not fixed-name executable acceptance.
- Existing all13 US jobs/Cases, selectors/actions/pins/caps/error/cleanup assertions
  preserved. Add new owners without hiding tests or expanding old budgets.
- New full-volume viewer CI-only: setup60000ms, initialize900000ms once,
  browser300000ms, assertions5000ms, disposal60000ms, job45min; no blind retries.
- Read-only preserves business/private rows/bytes; normal auth and exact
  viewer-correlated download audits are allowed and independently counted.
- No hosting/deploy/releases/main/PR/tags/unknown cleanup; source approval is not
  actual HTTP/browser/wholeUS11 acceptance. Prior generic CLI causes remain unknown.

## Review Focus

1. Preexisting email/extra account/member/orphan audit cannot be adopted or repaired
   (Task1 collision tables, concurrency and audit-failure rollback).
2. Normal MFA/session evolution must survive idempotent verify without creating
   factors or restoring roles/passwords (Tasks1/2 authenticated lifecycle tests).
3. Download audit writes must be exact, not hidden by broad table exclusions
   (Tasks2/4 full business snapshot plus explicit auth/audit delta accounting).
4. Stale org/role/marker after logout/revocation cannot retain controls or mislabel
   another tenant (Tasks2/3/4 server+DOM+browser cases).
5. Partial acquisition/occupied ports/browser failure must close only owned
   resources without secrets in reports (Task4 stage-failure/closure tests).

## Task 1: Reserved viewer store and explicit command

**Files:** Create API deployment `us-development-viewer.ts`, `us-viewer-command.ts`,
`main.us-viewer.ts`; tests `us-viewer-command.test.ts`,
`us-development-viewer.e2e.test.ts`; Node smoke
`tools/us-development/test/viewer-command.smoke.mjs`; modify API package.json to
add `us:viewer` using the established compiled-entry pattern. Add exactly one
check-only selector owner and ownership tests in Task4's workflow increment;
until that increment, local source tests are not claimed as remote acceptance.
No owner/auth/domain resolver/schema source change is in this task.

**Interfaces:** Export `UsDevelopmentViewerContext` with tenantId,
originalOwnerId, requestId; `UsDevelopmentViewerResult` exact spec fields/status.
`new UsDevelopmentViewerStore(db).provision(context,password)` and
`.verify(context,password)` return Promise of that result. Export
`viewerCommandEnvironment(args,raw)` returning `{env,mode,tenantId,originalOwnerId}`;
mode provision/verify. Reuse `readOwnerPassword`, no second password parser.
Main generates requestId, validates actual DB/user before store work, and closes
its sole pool. No callback/authority seams or production test imports.

- [ ] Write service-free parser/refusal tests: exact argument order, missing/
      duplicate/extra/password/role/reset/force args; malformed tenant/ownerUUID;
      wrong editions/mode/host/port/DB/user; TTY/512-byte/12..128/no CRLF interior
      password rules. Assert secret marker absent from all outputs.
- [ ] Write owned-DB store tests against actual existing tables: created rows and
      hash accepted by Better Auth, exact owner-attributed audit, no factor/session;
      verify missing conflicts, replay status already_exists/no writes, verify status
      verified/no writes. Independently pin every spec identity/audit field.
- [ ] Collision table: unrelated matching email/name, orphan/duplicate/wrong audit,
      extra account/provider/membership/foreign tenant, raw comma/whitespace/owner/QA
      role, wrong password, changed name/hash/accountId, missing owner/profile or
      wrong baseline/timezone. All conflict without row/audit changes or repair.
- [ ] Prove one concurrent creator, exact replay, rollback on audit insert failure;
      retain owner/profile/provenance untouched and evolved normal MFA/session data.
- [ ] Observe genuine behavioral RED, implement only spec transaction/command,
      GREEN, typecheck/lint/build and focused owned integration when explicitly
      isolated prerequisites exist; otherwise retain unrun gate for CI, no implicit
      service startup or base fallback. Smoke actual compiled refusal with bounded
      stdin, no fake successful DB identity. Freeze task diff/report for review.

## Task 2: Actual viewer HTTP access and audited downloads

**Files:** Create `apps/api/test/us-demo-viewer-http.e2e.test.ts` and focused
`test/support/us-demo-viewer-http-fixture.ts`. Reuse current auth-client,
owned-profile DB/native Plan/Request fixture patterns without changing existing
mutating test owners. Any required production authorization defect is reported
to root before expanding manifest, not bypassed by a test fixture.

**Interfaces:** Fixture `startUsDemoViewerHttpFixture(rawUrl)` returns actual app,
owned database, reserved owner/viewer IDs, normal auth clients, native Plan/run/
artifact descriptors, `businessSnapshot()`, `auditSnapshot()` and awaited `close()`.
No session/factor injection: client uses normal sign-in/enroll/TOTP/select flows.
It creates compact service-backed artifacts for fast permission proof; Task4
separately proves the full six-month data. Owner remains initiator throughout.

- [ ] Genuine RED: separately provisioned viewer logs in and obtains exactly
      READ+EXPORT_READ; password-only cannot read/select tenant, fresh MFA is needed
      after logout. No trust-device/enrollment replacement/namespace relaxation.
- [ ] GET every surface in spec; PDF and all six artifact kinds return exact
      headers/filenames/bytes/hash and immutable pinned publication. Foreign IDs and
      tenant selection follow existing non-leaking denial semantics.
- [ ] Table-driven direct POST/PUT/PATCH/DELETE attempts for every business/QA/
      profile/settings/member/Plan/Request/case action deny. Add anonymous,
      device/API-key-only, expired/revoked assurance/session and fresh role-revocation
      cases. Assert unchanged business/journal/run/private bytes for all refusals.
- [ ] Pin exact Plan/artifact release audit fields/deltas by viewer/requestId;
      authenticate/MFA records explicitly accounted, not zero-all-table fiction.
      Provider writes remain zero during viewing. Close streams/app/pools, normal
      exact childDROP/catalog absence; resource failure fails test.
- [ ] Run actual tests on owned explicit fixture, report all skips/limits;
      no service-level-only pass called HTTP proof. Independent task review.

## Task 3: Localized synthetic/read-only cabinet marker

**Files:** Modify `apps/admin/src/us/client.ts`, `app.tsx`,
`master-data/workspace.tsx`; add `src/us/synthetic-demo.ts` for pure bounded marker;
tests `apps/admin/test/us-client.test.ts`, `us-app.test.tsx`,
`us-master-data-ui.test.tsx`, new `us-synthetic-demo.test.ts`.
No backend DTO/OpenAPI or generated client edit; no UI redesign.

**Interfaces:** `isUsSyntheticDemoOrganization(value: unknown): boolean` implements
spec exact name/slug/512-byte metadata marker. The normal org client retains
only optional bounded metadata needed by this presentation, not arbitrary data.
Workspace props carry presentation flag, never capability. Use existing i18n /
shared tokens; exact two-language copy is in spec, no untranslated new path.

- [ ] RED pure marker valid exact owner marker; absent/malformed/oversized/extra/
      wrong marker/name/slug/foreign object false, no fuzzy Synthetic-name matching.
- [ ] RED DOM separate auditor has no create/edit/QA/Validate/Ack/Prepare/Retry
      controls or profile setup, but read navigation/download works. Existing owner
      capabilities still show editing despite synthetic banner.
- [ ] EN/ES marker/read-only copy visible after selection; logout/session loss/
      org switch/capability revocation clears stale flags and controls. Test keyboard
      semantics/focus and layout-independent accessible text; do not call DOM green
      visual browser acceptance. Implement minimal existing-shell composition.
- [ ] Admin focused/package/typecheck/lint/build (shared deps built), fullformat /
      isolation; independent task review and pending Task4 visual proof disclosed.

## Task 4: Dedicated full-volume owned browser and CI acceptance

**Files:** Create `apps/api/test/support/us-demo-viewer-browser-fixture.ts`,
`us-demo-viewer-browser-fixture.test.ts`, `us-demo-viewer-browser.e2e.test.ts`;
add `tools/us-development/test/viewer-entry.test.mjs` for additive ownership /
refusal contracts. Modify `.github/workflows/us-development.yml`,
`tools/ci/affected.mjs` and exact affected tests only as required by additive
owner. Add `tools/us-development/test/support/demo-viewer-owner.mjs` and
`tools/us-development/test/demo-viewer-ownership.test.mjs`; modify only the
integration points in `support/dataset-command-positive-owner.mjs` described
below. Modify `support/dataset-command-positive-fixture.mjs` and its existing
`dataset-command-positive-ownership.test.mjs` only for the guarded reuse/root
resolution interface and its regression tests below. All these support paths
are under `tools/us-development/test/`. Extend `tools/us-development/check-isolation.mjs`
only if its current generic check-only validation actually rejects the new exact
owner; do not manufacture an allowlist requirement. Write `docs/us/demo-viewer.md`.

**Observed interface correction:** Current client Plan list/detail/PDF GETs have
no matching US Vite proxy entries. Modify only `apps/admin/vite.us.config.ts` and
add `tools/us-development/test/plans-proxy.test.mjs`: prove dev/preview middleware
RED, then allow exact GET collection/canonical UUID detail/PDF with unchanged
upstream rewrite. Reject queries, Range, aliases/encoded IDs, trailing slashes,
fragments and every other method/Plan command. Existing routes, API authorization
and client behavior remain unchanged. The new pure suite retains existing Node
tooling ownership; include both additional paths in independent Task4 review.

**Interfaces:** `startUsDemoViewerBrowserFixture()` accepts no success/identity
override; strict CI-only prerequisite check before DB/Docker/listen. Own fresh
actual installation through new `createDemoViewerInstallationFixture` with one
`command("initialize")`; actual compiled main.us-viewer provision reads private
stdin and emits only finite summary. Instantiate actual US app/Vite/browser after
free-port probes; no worker remains active for viewing. Return private in-memory
credential material only inside fixture/test lifetime, canonical descriptors,
snapshot/audit functions and awaited exact `close()`. No serialization to disk.

**Owned cancellation correction:** Run only actual compiled API/current Vite
serving in exact invocation-owned children with fixed inline runner source,
handles registered before acquisition, finite readiness/stop/closed IPC and
ignored stdout/stderr. No password/factor/session IPC/argv/env/files. Existing
private API runtime configuration may use its normal environment, never logs.
Use pinned BrowserServer bound explicitly127.0.0.1/port0, memory-only endpoint,
same one UI-authenticated context. Common setup/disposal60s deadlines latch
terminal failure while pending; only one nativeinitialize interval is excluded
from setup, still<=900s. Independent closers start despite a held earlier stage;
late acquisitions are closed and all rejections observed. Normal stop first,
then exact owned TERM/KILL/server.kill only within the existing budget; any
forced path fails acceptance. Await actual consumers before dependent normal
installation close; no discovered PID/port takeover or forced DB drop.

Frozen shared installation acquisition/close has no cancellation API: an
arbitrarily pending operation at deadline must fail incomplete, retain owned
ledger/late normal cleanup and never become drained/absent/success by assertion.
No next resource starts. Successful disposal still requires all settled and exact
normal DB/catalog/container absence<=60s. Cover held promises, same-tick expiry,
late fulfillment/rejection, independent cleanup/order/idempotency and forced-path
failure with service-free behavioral RED/GREEN before implementing this correction.

**Guarded reuse/root ruling:** Keep `createDatasetPositiveFixture` and its
`assertDatasetPositiveRunner` accepting only the actual `dataset_command_positive`
job. Add a separately guarded `createDemoViewerInstallationFixture` accepting
only actual `demo_viewer_acceptance`, with the same remaining Linux/GitHub-hosted/
fixed-DB/no-Node-options predicates. Each public entry validates before any I/O,
then delegates to one private acquisition function; never rewrite `GITHUB_JOB`
or pass a fabricated identity. Do not export the unguarded acquisition function.
Resolve the repository root from this support module's fixed file URL, not cwd
or an argument/env override. Make its source/config/migration/compiled imports
absolute against that root, invoke Git with `-C` that root, and give only the
actual compiled command child an explicit root cwd if needed. Keep generic
exported bounded child-runner defaults and all accepted resource/error/measurement
semantics unchanged. API Vitest/Vite/browser remain package-cwd processes, using
absolute fixture paths without global `process.chdir` or a second seed runner.
No root-level runner or cross-process credential/session transfer is needed.
Prove both entry guards refuse the other job and all existing invalid identities
before I/O; prove root resolution from repository and API cwd without acquiring
resources. Preserve whole acquisition/command bodies after mechanically restoring
only these root/guard substitutions; excluded provider/probe/cleanup bytes match.

**Additive ownership ruling:** Append one exact viewer block. New viewer-owner
normalizer removes only its independently pinned whole valid block (including
EOF/uniqueness and structural checks), retaining malformed additions. Integrate
that normalization ahead of the existing positive structural/byte removal, only
when the existing positive block is valid. Preserve its literal block, all old
predecessor hashes, all old job commands/selectors/pins/caps and malformed-owner
rejection semantics. No hash re-anchoring or release-lock weakening. New ownership
tests independently pin the viewer block and e5a whole-workflow predecessor bytes
and structure; mutate both old/new blocks, ordering, duplicate selectors and
privileges to prove rejection. Existing chained normalizers consume this one
narrow integration; do not patch each historical hash test to ignore differences.
Keep Task3's three modified suites owned by the original browser matrix command;
only the genuinely new `us-synthetic-demo.test.ts` gains selection in the new job.

- [ ] Before new resources, write pure/local-refusal tests: no CI/dirty or wrong
      checked identity refuses before I/O; exact finite job selector/flags/pins/caps;
      no ordinary matrix/workflow/role/SDK/cleanup weakening. Preserve all old owners.
- [ ] Test partial-acquisition disposal at each owned boundary and occupied-port
      refusal without taking over/killing unknown processes. Extend existing narrow
      resource test interfaces only if needed, never the production command.
- [ ] Add job `demo_viewer_acceptance` check-only with existing PG service pins,
      Node/pnpm/build/Chromium setup and current pinned private provider standards.
      Select new Task1 pure/store/refusal + Task2 actual HTTP exactly once; select
      only new Task3 marker suite once (modified DOM/client suites retain their old
      browser owner); dedicated browser test and fixture refusal suite exactly once.
      No extra full seed hidden in original browser300s or native jobs.
- [ ] On actual clean CI, initialize once<=900000; compiled viewer provision with
      bounded protected stdin; normal UI password/MFA, no storageState/cookie injection.
      Browser<=300000/45min job, all assertions<=5000, setup/disposal<=60000. No retry
      or timeout increase if actual workload exceeds this bound.
- [ ] Journey spec data/history/correction/orphan/partialstock/Trace/Readiness,
      Plan PDF + three ZIP downloads with canonical filenames/length/hash, all EN/ES,
      light/dark, desktop/narrow, keyboard. After real UI MFA, use that same browser
      context's request facility for 18 individual authenticated HTTP releases:
      six kinds for each of the three full-volume run IDs. Match each published
      descriptor/hash/bytes/headers and inspect every ZIP entry. This is part of the
      same 300000ms journey, not a second fixture/seed or extra timing allowance.
      Count these 18 exact viewer release audits plus the browser Plan/three ZIP
      release audits in the same before/after delta, each with correlated requestId.
      Task2 compact HTTP matrix remains permission proof, not full-volume evidence.
      No credentials/factor screens/network secrets in screenshots/traces/logs.
- [ ] Compare whole business/private baseline and exact expected auth/download
      deltas; awaited close all resources, exact DB/container absence. Save only
      synthetic post-auth evidence and measured phase timings, not human-time claims.
- [ ] Root self-review interfaces/coverage/cost; task review then whole-increment
      independent review. Focused tests/package statics/build/format/isolation and
      final exact-SHA all existing13+Cases+new owner success with actual logs required.
      Root chooses proportionate ordinary API integration ONCE after final source;
      no automatic broad reruns. Commit/push only explicit paths with both required
      author/committer identities; no releases/deploy. Viewer completion requires
      actual HTTP/browser proof, not merely source or CLI green.

## Root preflight/self-review

| Interface                           | Decision / conflict resolution                                                                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Owner -> viewer                     | Locked original provenance reused; distinct user/audit; no owner metadata/profile role conversion.                                                     |
| Viewer repeat -> normal MFA         | Verify immutable owned identity/credential/audit, allow normal evolving auth state, never reset it.                                                    |
| HTTP download -> read-only          | Business/private baseline invariant; exact expected release audit and auth deltas allowed and counted.                                                 |
| Authenticated org -> shell          | Exact bounded presentation marker only, no access authority or backend contract expansion.                                                             |
| Existing browser -> new full-volume | Separate owner and time envelope; old compact test/caps untouched, no cross-runner DB/session reuse.                                                   |
| Full seed -> viewing                | Preparation once; no worker/generation during visitor reads; current positive initialize+verify remains independent.                                   |
| New owner -> positive fixture       | Two real job-specific guarded entries/private acquisition; fixed module-derived root; no identity forgery or global cwd change.                        |
| New workflow -> old evidence        | Exact viewer normalizer before positive removal; all old blocks/hashes/assertion semantics retained; old DOM suites not duplicated.                    |
| Compact HTTP -> full HTTP           | Task2 proves permissions; Task4 same UI-authenticated context performs all18 actual full-volume releases within browser budget and exact audit deltas. |

Coverage maps spec identity/command to Task1, server/API/audits to Task2, marker/
controls to Task3, full-volume/browser/resources/CI to Task4. No missing human
choice blocks design: these are root-selected implementation calls under standing
approval. Root verified all three independent builder-check findings against
current source and resolved them above on 2026-10-22. Runtime feasibility and
timing remain actual CI gates, not source-review claims. Release Task1 only after
the builder confirms these design gaps closed; later tasks remain sequenced and
independently reviewed. No resource acquisition is authorized by this document
without the task's explicitly isolated prerequisites and root release.
