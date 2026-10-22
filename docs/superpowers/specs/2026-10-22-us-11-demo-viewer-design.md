# US-11 separate synthetic read-only viewer

Status: root design under standing owner approval; implementation awaits the
matching plan, root self-review and independent builder check. Builds on the
owner-approved 2026-10-06 single-tenant and six-month specifications. No hosting,
public credentials, auth-policy relaxation or deployment authority is granted.

## Outcome and current evidence

Provide one reserved, separate viewer for the existing synthetic processor tenant.
Use the existing cabinet, normal password/MFA and current membership checks, with
read/download access but no business mutation or new package generation.
Exact source e5a00d71bf51aedd711269ca1a289749a8d172d8 has actual compiled
initialize/verify and all13 US jobs plus Cases accepted. Historical generic
failures remain unexplained; this does not assert their cause was fixed.
The viewer/browser and hosted-demo gates have not been exercised.

Current `resolveUsAccess` grants `traceability_auditor` exactly
`traceability.read` and `traceability.export.read`. Its general comma-role union
is not changed. `resolveUsPrincipal` reloads session, MFA assurance, verified
factor and active membership. The owner remains the Plan/Request initiator.
`UsDevelopmentOwnerStore.verifyLockedTrustedSeed` scopes owner facts separately;
adding a viewer must not alter that owner or organization metadata/audit.

## Reserved identity and command

Root-selected literals:

- Email `viewer@us-development.example.test`, name `Synthetic US development viewer`.
- Version `us-development-viewer-v1`, raw membership `traceability_auditor` only.
- Audit action `us.development.viewer.provisioned`, targetType `user`, targetId
  viewer ID, actor original owner, outcome `success`, before null.
- Exact audit after: `{ synthetic: true, seedVersion: "us-development-viewer-v1",
tenantId, originalOwnerId, viewerUserId, email: "viewer@us-development.example.test",
role: "traceability_auditor" }`. No credential/hash/factor/session facts.

Add `main.us-viewer.ts`, not an HTTP provisioner or startup hook. Exact syntax:
`provision --tenant-id <UUID> --owner-id <UUID> --confirm-local-synthetic-viewer`
or `verify --tenant-id <UUID> --owner-id <UUID>`. Reject missing, duplicate,
unknown, reordered or extra arguments; no arbitrary email/role/reset/force/URL.
Both modes read the chosen password through the existing bounded non-TTY stdin
reader (512 bytes, 12..128 characters, one final LF/CRLF, no interior CR/LF/NUL).
No plaintext in argv/env/files/logs/summary/screenshots. No invitation/email flow.

Use `loadUsDevelopmentEnv`, actual database `markiro_us_dev`, user `markiro_us`,
loopback55432 and existing US edition/development guards. Actual DB/user is
queried before store work. One pool client, connection timeout2000ms and statement
timeout5000ms; await pool.end. No migrations, owner/profile/dataset creation or
ambient primary environment loading. Fixed secret-free refusal, nonzero exit.

Store context is `{tenantId, originalOwnerId, requestId}`. Serialize only this
reserved viewer identity with advisory xact lock for the version; lock and verify
original trusted owner provenance in that transaction. Require current processor
profile, baseline `US-REG-2026-09-03`, retentionYears2 and America/Los_Angeles;
share-lock the actual profile rows rather than invoking a second transaction.
No schema migration or generic uniqueness/role-policy change is needed.

Fresh provision requires no reserved email and no existing provisioning audit
for this reserved command. Create user, one credential account with accountId
equal userId and Better Auth hash, one exact auditor membership and exact audit
atomically. User ID differs from owner. Initially emailVerified and
twoFactorEnabled are false. Do not create sessions/factors/assurances.

Replay/verify require the reserved identity, exact single provenance audit, all
viewer memberships counted (one in this tenant), all accounts counted (one
credential with own accountId/nonempty hash), exact raw role/name/email, original
owner and successful verifyPassword. Query bounded facts, reject duplicates and
orphan audits, including another tenant's reserved provisioning audit. Do not
adopt an unrelated preexisting user by email or repair any drift. Wrong password,
extra role/provider/membership, renamed user, changed audit or missing row is
conflict. Concurrent commands yield one creator; replay adds no audit/rows.
Verify never creates missing rows. Ambiguous commits are not automatically retried.

MFA/session state may evolve through normal authentication: do not require false
flags on replay, replace factors or clear sessions. Provision/verify validates a
transactional observation, not immunity to later privileged DB changes. Normal
server membership reload remains authoritative on every protected request.

Result has exactly status (`created`/`already_exists`/`verified`), tenantId,
viewerUserId, email, role, synthetic:true and mfaRequired:true. No owner password,
hash, factor, token, cookie, storage key or completion claim is returned.

## HTTP boundary and read-only accounting

Exercise genuine provisioned viewer login, TOTP enrollment/challenge and normal
organization selection. No cookie/storageState injection as authentication proof.
Retain existing allowlist, limiter, origins/hosts, namespaces and no-trust-device
rules. Do not change `us-auth`, adapter, principal or generic role resolver merely
to make the viewer work. Any demonstrated defect needs a separately scoped ruling.

Read Events/current/immutable history; Lots/Cases/SSCC; Search; both Trace
directions; Readiness; Plan/history/PDF; Requests/run/history and all six private
artifact kinds. Compare exact selections, quantities, identities, hashes and bytes.
Directly deny event/reference/profile/member/settings/QA/classification/case
mutations, Plan approve/replace, Request create/update/close/Validate/Ack/Prepare/
Retry. Cover anonymous, device/API-key only, password without MFA, revoked/expired
session or factor, foreign tenant/IDs and changed current membership.
Use existing 401/403/404 semantics and exact audit assertions where emitted.

Read-only is not zero writes to every table: normal auth/MFA updates its own
rows; downloads deliberately insert `traceability.plan.downloaded` and
`traceability.request.artifact_downloaded`. Assert exact viewer actor, tenant,
request ID, target, result, pinned run/Plan/artifact/size/hash and exact allowed
deltas. No broad audit/auth exclusion hiding unexpected business writes.
Business, dataset journal, Plan/run/artifact rows and private object bytes stay
unchanged; provider reads may increase, PUT/DELETE/failures/active at end are zero.

## Existing cabinet and synthetic presentation

Use existing tokens, navigation and capability gates, not a new design system.
Preserve bounded optional organization metadata from normal authenticated org
responses. Presentation marker is true only for exact reserved slug
`us-development-demo`, name `Synthetic US development`, and parsed exact metadata
`{synthetic:true,seedVersion:"us-development-owner-v1"}` with no extra keys.
Only a string at most512 bytes is considered; absent/invalid/other metadata
produces no marker. Never derive authority from this flag. It is presentation,
not a new server-side provenance certification. No backend access DTO change.

After authentication/selection show localized non-dismissable text:
EN `Synthetic demo data — not real customer activity.`
ES `Datos de demostración sintéticos — no son actividad real de clientes.`
For exact auditor capabilities show EN `Read-only access` / ES `Acceso de solo lectura`.
Keep owner editing possible when its capabilities permit it; marker is not a
business gate. Clear selected marker/capabilities on logout/session loss; do not
mislabel another organization. Do not show profile setup to the auditor.
Existing edit/QA/new-run controls remain absent or disabled for the viewer;
server denial is mandatory even if the UI hides them. Preserve downloads and
keyboard focus, EN/ES, light/dark and desktop/narrow layouts.

## Full-volume browser proof and resource boundary

Do not expand the existing compact mutating Request browser test or its300000ms
cap. Add a dedicated check-only CI owner, isolated runner and fresh owned full
installation, preserving every existing13 US job/command/pin/cap and Cases.
Reuse strict current positive-fixture ownership principles and pinned SeaweedFS,
nonroot UID/GID, config/privacy, capability probes, checked build and exact cleanup;
no local bypass, cross-runner DB reuse or uploaded DB/session/credential artifact.
Use two actual job-specific guarded public entries into one private acquisition
implementation: existing positive entry remains positive-job-only; separate viewer
entry accepts only the new viewer job with identical remaining runner predicates.
Resolve workspace paths from the fixed support module location, not caller cwd or
caller-provided roots. Never forge job identity or globally change cwd. Preserve
all old workflow blocks and predecessor hashes through one exact viewer-addition
normalizer integrated before the positive-owner normalization; malformed additions
remain visible. Existing modified DOM suites retain their original owners.

New viewer job: one actual initialize<=900000ms, provision viewer through actual
compiled stdin command, then browser journey<=300000ms; setup and disposal each
<=60000ms, independent assertions<=5000ms, job45min including build/install.
No extra verify command here: unchanged positive job independently retains one
initialize then verify. Viewer job takes its own before/after business/private
baseline and exact allowed auth/download audit deltas. Preparation worker is not
kept running during viewing. No new provider policy or image/SDK change.

Start actual compiled `createUsDevelopmentApplication` and current Vite US config
in exact invocation-owned child processes on free loopback3100/5174 only. Register
their handles synchronously, before readiness, so pending framework acquisition
can be cancelled and late acquired resources closed. Fixed inline runner source
uses finite readiness/stop/closed IPC only; stdout/stderr are ignored. Password,
MFA and sessions never enter IPC/argv/environment/files; ordinary existing private
API configuration stays in its normal environment and is never logged. Fail on
occupied ports, no takeover. Pinned Chromium uses one BrowserServer owner with
an explicitly127.0.0.1/port0 control listener and a memory-only endpoint, retaining
the same single normal UI-authenticated browser context.
Current Plan list/detail/PDF client GETs require a narrow missing-proxy correction:
exact GET collection/canonical UUID detail/PDF only in dev and preview, no queries,
Range, encoded aliases, trailing slashes, fragments or Plan mutation/preview
routes. Prove the middleware boundary with pure RED/GREEN tests; preserve every
existing proxy route and server authorization policy. This is local development
transport integration, not an authorization bypass or completed browser proof.
Use normal UI password/MFA forms; keep generated secrets in process memory and
never capture auth/enrollment screens, network headers, console or traces/video
that include credentials. Screenshots may start only after assurance and removal
of factor material; no saved storageState/cookie jar or remote credential handoff.

Journey: page/filter six-month history; exact Scenario A dates/TLCs/quantities/
SSCC; split/partial stock; both Trace directions; corrected prior revision;
orphan missing-origin Readiness; approved Plan/history/PDF; all three frozen
Requests. Browser downloads Plan PDF and each ZIP; actual authenticated HTTP
requests from that same normal UI-authenticated browser context individually
release all18 artifact kinds across the three full-volume run IDs and verify
published descriptors/headers/bytes/hashes/ZIP entries. These requests belong to
the same300000ms journey and exact audit-delta accounting in addition to the
browser Plan/three ZIP releases. Compact Task2 HTTP fixtures prove permission
boundaries only, not full-volume releases. No generation
or mutation during visitor journey. Check keyboard focus, EN/ES/light-dark,
1440x900 and390x844. Preserve anti-off-origin interception and exact download
filename/length/hash. Browser checks are not physical labels/PDF visual acceptance.

Close browser/context, Vite/API, streams/clients/pools, then exact owned DB normal
DROP without FORCE/catalog absence and attested provider removal/absence; await
all children. Failed cleanup fails gate. No unknown process/base cleanup.
All extra resources are test-owned and CI-only for this full-volume gate.

Use actual monotonic common setup/disposal deadlines, not post-hoc elapsed checks.
Only the single native initialization interval is excluded from setup charging;
all original caps remain fixed. Register pending operations and late-result
handlers before awaiting. Expiry is terminal; late success immediately closes,
never resumes setup. Begin independent shutdowns despite one pending closer,
then await consumer termination before dependent normal installation cleanup.
Reserve cancellation/drain time inside the same60s budget. Exact owned child
TERM/KILL or BrowserServer.kill may unblock failure cleanup, but any forced path
permanently fails acceptance, never substitutes for normal successful disposal.

The frozen shared installation API has no cancellation handle before acquisition
resolves or during an arbitrarily pending legacy close. At deadline this is an
explicit incomplete-acquisition/disposal failure; retain the observed pending
ledger and late exact normal-close continuation. Never call it drained/absent or
let late closure turn failure green. No new resource stage may start afterward.
This negative limitation is not a weaker success gate: successful acceptance
still requires every operation settled and all exact normal absence proofs within
the unchanged deadline. No forced DROP or unreviewed legacy cancellation change.

## Acceptance and non-goals

TDD, independent task review, final whole-increment review, package statics/build,
format/isolation/ownership tests and actual HTTP/browser CI are required. New
store tests use owned random child databases; never populate shared base.
Do not repeat accepted broad CLI/native tests locally for paperwork. Root rules
proportionate API integration after final source and owns scoped identity commits.
Keep source/CI/HTTP/browser evidence distinct and disclose skips/baseline warnings.

No public hosting, deployment, DNS, invitation, signup, password/MFA recovery,
credentials distribution, generic multi-customer provisioning, policy/SDK/
dependency/env changes, production/RU/Station, release/tag/PR/main or unmeasured
human-time/cost/compliance claims. Automation remains active until viewer delivery
or genuine new-authority blocker, not merely CLI completion.
