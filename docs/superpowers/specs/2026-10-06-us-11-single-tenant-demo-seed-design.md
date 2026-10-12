# US-11: one reproducible demo tenant and read-only viewing

Status: owner-approved specification, 2026-10-06. The owner approved
the conversational design and this written specification; this file does not claim implementation or authorize
hosting, destructive reset, publishing or changes to authentication policy.

## 1. Outcome and scope

Prepare one synthetic U.S. processor tenant that a visitor can inspect through
the existing EN/ES cabinet, including authorized downloads of prepared results.
The visitor must not modify business records or generate new packages. There is
no self-service registration, new customer onboarding, billing, multi-customer
provisioning, Station workflow, physical scanner/print claim or second demo.

This increment delivers the versioned dataset, an explicit initialization and
verification command, a restricted viewer identity, and a complete local browser
journey. A subsequent separately reviewed deployment increment selects the
non-RF provider/domain and supports external runtime configuration. No cloud
resources, domain, credentials or publicly reachable service are created here.
Screenshots/video may follow from the accepted dataset; they are not substitutes
for the browser/API acceptance defined below.

Work remains in `/Users/thevladbog/PRSOME/q/.worktrees/us-docs-audit`, branch
`codex/us-mvp`. Preserve unrelated and accepted uncommitted work. No staging,
commit, push, PR, merge, release, primary-database mutation, old fixture cleanup,
dependency installation, personal environment-file write or local archive/design
file change is included. Tests use owned disposable U.S. databases and owned
private storage fixtures; they never populate the shared base database implicitly.

## 2. Current implementation boundaries

- `UsDevelopmentOwnerStore` owns the reserved synthetic organization and its
  original owner/credential/provisioning audit. Its `verifyTrustedSeed` is reused
  by both Plan and Requests provenance checks. Existing organization name,
  slug, metadata and owner audit are not repurposed as the dataset journal.
- `resolveUsAccess` already grants `traceability_auditor` exactly
  `traceability.read` and `traceability.export.read`, not QA or write authority.
- Receiving, Transformation, Shipping, genealogy, Cases, Search/Trace/Readiness,
  Plan and Requests have existing service boundaries and local tests. Dataset
  orchestration composes those boundaries rather than writing finalization
  snapshots, genealogy, balances, Plan approvals or Ready runs with SQL.
- Existing test fixtures provide examples, not an operational seed command.
  Runtime code must not import from `apps/api/test` or mutable fixture transports.
- `loadUsDevelopmentEnv` enforces loopback hosts, explicit U.S. editions and
  development/test mode. The worker additionally rejects an untrusted/dirty
  publishing build. Do not loosen either check to make this increment appear
  deployed or to publish the current dirty checkout.

Sources of truth are direct owner instructions, repository instructions, current
code/contracts and the shared [MVP contract](../../us/mvp-contract.md). Dataset
content follows [Scenario A](../../us/demo-scenario.md); its historical status
labels and interactive operator script are not proof of completion and do not
grant mutations to a viewing account.

## 3. Dataset and identity

Use a code-owned, versioned Scenario A definition. Its content digest covers the
synthetic business inputs and references, not credentials or mutable execution
timestamps. A version is never silently replaced by a new definition.

| Element           | Required content                                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Tenant            | Existing reserved synthetic tenant, processor profile                                                                                      |
| Timezone          | `America/Los_Angeles`, consistent with fictional Scenario A locations                                                                      |
| Parties/locations | Orchard Slice Supply, North River Fresh Foods, Harbor Market; exact fictional descriptions/555 contacts from Scenario A                    |
| Products          | Fresh-cut apple slices and apple snack cups, manually reviewed synthetic FTL classification                                                |
| Receiving         | One finalized event dated `2026-09-14`, two inbound lots `OSS-260914-A1` and `OSS-260914-A2`, each `500 lb`                                |
| Transformation    | One finalized event dated `2026-09-15`, consumes `500 lb` from each input, output `NRF-260915-APL01` with `100 case` at processor location |
| Cases             | Exactly 100 distinct GS1-valid SSCCs, explicitly synthetic, linked through the existing case service to the output lot                     |
| Shipping          | One finalized event dated `2026-09-16`, `100 case` to Harbor Market, existing output TLC unchanged                                         |
| Documents         | Scenario A ASN/BOL/work-order/batch/invoice references; no real attachments, businesses, contact data or remote fetching                   |
| Plan              | Approved synthetic processor Plan, actual immutable English PDF, existing synthetic marking and approver ID/time semantics                 |
| Request           | One synthetic request `REQ-2026-APPLE-001`, complete chain scope and a successfully published Export-ready run                             |

Use exact decimal quantities and existing UOM values; packaging descriptions do
not authorize implicit conversion. The 100 lb narrative process loss is not a
required KDE or an additional balance write. Synthetic boxes may require minimal
schema-supporting rows; those remain tenant-scoped seed-owned facts, not completed
physical production. SSCC generation/validation uses `@markiro/domain`; no new
GS1 allocation or physical traceability claim is implied.

CTE dates remain civil fixture dates. Request receipt time is captured once when
initializing the request; due time remains exactly 24 elapsed hours later.
Repetition reuses these stored instants, even when the request becomes overdue.
No machine/authentication/audit clock override or silent deadline extension is
allowed. The viewer sees the existing honest clock/status display.

Across fresh isolated installations, generated IDs, audit timestamps, approval
times and artifact hashes can differ. Reproducibility means the same versioned
scenario and verifiable relationships; it is not an identical-byte promise across
different installations. On repeated verification of one installation, existing
IDs, snapshots, Plan versions, run identity and artifact bytes must remain stable.

## 4. Initialization, repetition and failure

### Explicit command boundary

Provide a US-only CLI composition, not a startup hook or public HTTP endpoint.
It accepts an explicit initialize-or-verify operation, expected database identity,
expected reserved tenant UUID and scenario version/digest. An explicit target
confirmation is required for initialization. The first provision of the reserved
owner remains the existing separate command; missing owner/profile prerequisites
produce precise guidance, never implicit password/role/profile repair.

Before any mutation verify both deployment editions, the permitted local target,
actual database/schema identity, tenant UUID, original trusted-seed marker/audit,
current owner authority, required private storage configuration and supported
build identity. Configuration failure makes no business writes. No RU fallback,
ambient primary `.env`, arbitrary tenant-by-slug or unvalidated connection target
is accepted. A storage/worker prerequisite failure must not look like a successful
complete seed.

### Durable ownership and verification

Keep a small US-only database journal separate from trusted tenant metadata. Its
tenant-composite constraints identify the scenario version/content digest, stage
and exact owned record IDs, expected input/revision digests, operation keys where
supported, receipts and completion evidence. Add a new migration if needed;
never rewrite applied migrations or use a committed filesystem manifest as the
database source of truth. A journal entry is orchestration evidence, not proof a
business event or artifact succeeded.

Serialize initialization of the same tenant/scenario and enforce unique ownership
in the database. Losing or concurrent invocations must not create duplicate
events/lots/links/Plan versions/requests/runs. Supported command operation keys are
captured durably before invocation and reused with their exact original body.
Services remain authoritative for actor/capability reload, tenant ownership,
readiness, finalization, downstream quantity checks and artifact publication.

Stage order is references/profile prerequisites → Receiving → Transformation →
synthetic cases/linking → Shipping → trace/readiness verification → Plan approval
→ request validation/Prepare → bounded worker completion → artifact verification.
Each completed stage is reconciled from canonical service/database results before
advancing. Persist the actual generated output lot binding; never manufacture an
output lot separately to satisfy the next stage.

There is no global transaction across PDF rendering, private storage and worker
execution. An interrupted invocation may leave valid partial seed-owned records.
Restart reconciles exact journaled identities/receipts and resumes supported
retry-safe operations. A command without a safe replay/ownership seam must not
be resubmitted after an ambiguous outcome or inferred successful from a matching
business number: stop with a finite recovery code and preserve the partial state
for explicit diagnosis. Transactional setup/receipt capture is preferred where
the service supports it. Never fabricate command idempotency.

A fully populated repetition is a verification-only no-op: no new revision,
audit mutation, approval, request, run, duplicate link or artifact upload.
Mismatch, missing journaled record, edited/voided seed event, corrupt provenance,
different scenario digest or inaccessible/mismatched artifact is an error, not
authorization to restore, overwrite or append replacement history. No deletion,
reset, password reset, MFA reset or role restoration command is included.

### Package completion

Plan approval uses existing synthetic provenance, immutable PDF publication and
actual code-owned configuration snapshot. No operational backup/storage fact is
asserted true merely to pass approval. Prepare uses real fresh validation and
exact scope, with only supported warning acknowledgement as necessary.

Execute the existing bounded worker until the journaled run reaches a terminal
state or a documented timeout. Queued/processing/failed/incomplete is not a
complete Export-ready demo. Use both server status and explicit `exportReady`;
never infer it from a mode label or object presence. Verification checks the
complete six-artifact set, actual bounded bytes, MIME/filename, lengths, SHA-256,
manifest/ZIP membership and pinned Plan identity using current artifact semantics.
Once prepared, viewing the results does not require a permanently running worker.

Emit a bounded secret-free summary with scenario version/digest, canonical IDs,
stage status and artifact verification outcome. No passwords, MFA keys, tokens,
cookies, signed URLs, requester payloads or storage credentials in output/logs.

## 5. Viewer access

Provide explicit US-only setup/verification of a reserved synthetic viewer
identity in this same tenant. No invitation/email provider dependency, self-service
sign-up or public-token route is added. Use established Better Auth credential
hashing and normal session/MFA enrollment; initialization does not fabricate an
enrolled MFA state, copy authenticator secrets or turn authentication off.

Read the chosen password only through a bounded protected input mechanism such
as the existing CLI stdin convention. No plaintext password in argv, environment,
tracked files, seed content digest, logs, test screenshots or final reports.
Administrative credentials remain separate and are never distributed to viewers.

Persist exactly one membership with `traceability_auditor`, without unioned
owner/admin/QA roles. Existing identity/membership/credential collisions or a
changed role produce an error; repetition does not elevate, downgrade, repair or
reset them. Never attach a preexisting unrelated identity based only on email.
Current membership remains reloaded server-side at every protected boundary.

The owner who created the Plan/request/run retains the required privileges;
turning that initiator into the viewing account would invalidate existing worker
or artifact authorization assumptions. The viewer has no authority to seed,
approve, Validate/Ack/Prepare/Retry, create/update/close events/requests, link/unlink
cases, edit classifications, manage members/settings or alter the profile.
Necessary auth/self-session/MFA actions are not business-record write grants.

Use the existing cabinet and shared tokens; hide or disable editing actions
according to current capabilities, never merely trust hidden UI. Viewing covers
Events/immutable history, Lots/Cases/SSCC, Search, backward/forward Trace,
Readiness, Plan/history/PDF and frozen Requests/packages. The shell visibly labels
the synthetic tenant in both EN/ES. The operator's earlier create/generate demo
script is separate from the read-only visitor walkthrough.

## 6. Acceptance and limits

Implementation must demonstrate test-first failure/pass coverage and independent
review, preserving unrelated dirty work and the current default API setup failures.

Required automated/integration evidence:

1. Wrong edition, database identity, tenant UUID, seed provenance, version/digest,
   role or prerequisites fail before mutation; second-tenant records are untouched.
2. Fresh initialization yields precisely the three CTE events/three lots/100
   synthetic active case links, quantities, source identities and two genealogy
   input edges specified above. Shipping consumes the same output lot in `case`.
3. Repetition leaves identities, versions, audit rows, journal business evidence,
   Plan/run counts and existing artifact hashes unchanged. Concurrent attempts
   cannot create duplicates; journal completion is not accepted without canonical
   verification.
4. Injected partial-stage/ambiguous-reply/worker/storage failures preserve valid
   history, never produce false complete status, and recover only through supported
   exact replay or explicit diagnosed ownership. No destructive repair is tested
   against a shared database.
5. Current Trace graph/table prove two inbound sources and one recipient; all
   selected records have real current finalized basis and expected readiness.
6. Synthetic Plan and request contain the actual three-CTE chain. Ready package
   verification proves all six artifacts and immutable pinned sources/Plan.
7. Viewer can read/download through actual HTTP authentication; direct mutation
   attempts are denied server-side, with exact audit assertions where emitted,
   and cross-tenant/device/anonymous credentials remain denied.
8. Secret/privacy scanning uses synthetic fixtures only; no real personal data,
   uncontrolled remote source fetch or prohibited approval/certification claim.

Required browser evidence is a clean seed → normal viewer authentication/MFA →
read-only full chain → Plan/request download journey against actual local API,
private storage fixture and separate worker. Include EN/ES, light/dark, desktop
and narrow viewports, keyboard focus, exact identifier/quantity preservation,
synthetic labels and absent editing authority. Test harness credentials/auth
screens are never captured. Fixture teardown deletes only its exact owned
disposable DB/build/storage prefix/processes; real seed command never tears down
the populated tenant after success.

Measure package generation, seed and walkthrough timing separately. The existing
<60s package and <2min seed goals are targets until measured; automated duration
is not trained human effort. Inspect generated XLSX/PDF visually in a later
artifact acceptance gate if not exercised here; machine hash verification alone
does not prove spreadsheet-client compatibility or document layout.

Acceptance is local synthetic demo readiness only. Hosted API/frontend runtime,
actual private provider policy/health, non-RF data locations including auth/logs,
HTTPS/cookies/origins, remote CI, external deployment/source identity and handing
out working credentials require the subsequent deployment increment. A minimal
demo may omit HA, scaling, billing and customer onboarding, but not authentication,
private objects, edition/tenant isolation or truthful synthetic provenance.
Backups/restore and real operational acceptance are not asserted by this seed.

## 7. Approval and next artifact

This design intentionally chooses persistent service-backed initialization over
an ephemeral test fixture or raw precomputed final-state SQL dump. It preserves
the existing audit/provenance and artifact publication boundaries at the cost of
a small durable seed journal and explicit partial-failure handling.

The owner approved this written specification. Next, write the
implementation plan with separate independently reviewed stages for dataset and
safe journal/command boundary, service-backed business chain, Plan/package,
viewer access, and complete acceptance. No implementation plan or product code
is approved by the conversational design alone.
