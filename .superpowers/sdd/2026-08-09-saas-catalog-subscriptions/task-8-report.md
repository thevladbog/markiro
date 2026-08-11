# Task 8 report — subscription features, expiry, and offline recovery

Date: 2026-08-11

## Outcome

Task 8 plus review rounds 1 through 3 are implemented. Subscription enforcement is explicit at the
registered route or authoritative mutation boundary; there is no global unsafe-method blocker and
no Task 9 UI. Authentication, profile/security maintenance, reads, exports, device bootstrap, and
eligible offline recovery remain available. Customer writes and paid features fail closed under the
configured `managed_only|all` policy.

Review-authorized migrations are additive:

- `0032_cute_frank_castle.sql` binds new station sync batches to terminal and canonical payload
  digest and adds tenant-scoped durable per-record quarantine;
- `0033_common_magdalene.sql` stores exact kiosk order admissions using only an opaque-token hash,
  canonical order-content digest, authoritative server timestamp, expiry, kiosk, sequence,
  subscription, and tenant.

Applied migrations `0030` and `0031`, including their snapshots, are byte-for-byte unchanged from
`HEAD`. Their SQL SHA-1 values remain `8831f2db00883d7ac4f1f7a71f51f916415a2aca` and
`46e0a1fe5f1d38e0f9a7e7f64e340d35051b3e83` respectively.

Round 3 required no schema change. Applied migrations `0030` through `0033` are unchanged from the
round-2 commit; no `0034` was added.

## Registered route inventory

`subscription-route-inventory.test.ts` compiles the real `AppModule`, walks registered controller
methods through Nest `ModulesContainer`, and compares all 97 routes carrying
`SubscriptionAccessGuard` with a canonical route/policy/ordered-guard inventory. Filtering by the
actual guard rather than a controller-name list means a new guarded GET is also caught. Duplicate,
new, removed, or stale canonical entries fail exact equality. Every unsafe method and conditional
CommerceML GET import remains covered by the wider exemption audit.

Every guarded customer route must have explicit subscription metadata and one exact guard chain:

- cabinet: `TenantGuard -> AuthorizationGuard -> SubscriptionAccessGuard`;
- station sync: `TenantGuard -> StationOnlyGuard -> SubscriptionAccessGuard`;
- kiosk: `KioskDeviceGuard -> SubscriptionAccessGuard`.

Every guarded unsafe method must own a handler-level policy; it cannot silently inherit the
controller's class-level read policy. Intentional side-effect-free POST, security maintenance, and
export continuity are explicit `read_only_allowed` canonical entries rather than accidental method
classification.

This includes customer GET routes, so the side-effecting shift bundle endpoint cannot hide behind
HTTP method classification. `GET /shifts/:id/bundle` is explicitly shift recovery. A new
unclassified route, stale exemption, removed guard, reordered trust boundary, or missing policy
fails the inventory.

The reflected inventory retains 28 exact documented exceptions: personal profile/security (3),
CommerceML transport/conditional import (2), invitation authentication lifecycle (3), unpaired
kiosk/station pairing (2, enforced after authoritative tenant resolution), tenant-owner activation
(2), and isolated platform/public-platform trust domain (16).

## Station recovery, replay, rolling upgrade, and bundle allocation

- New batches are bound after authentication to `(tenantId, stationDeviceId, canonical payload
  SHA-256)`. Only the same terminal and exact normalized payload replay; changed payload or another
  terminal receives stable `409 { code: "station_batch_mismatch" }` without acknowledgement or
  business write.
- The write transaction claims/locks the batch, resolves one entitlement snapshot, then locks all
  referenced same-tenant shifts. Mixed item, box, and exception batches partition into eligible
  writes and late/missing/foreign durable quarantine records. One denial cannot wedge later work.
- Eligibility uses authoritative `shifts.openedAt < subscription.endsAt`; the client clock grants no
  recovery authority. Exact replay returns stored outcomes without duplicate writes or quarantine.
- Pre-0032 unbound rows never let the first post-upgrade caller manufacture terminal or payload
  ownership. B-first then A remains payload-independent, produces no business/quarantine write, and
  leaves the row unbound. New writes can never create unbound rows.
- Capability negotiation preserves the exact legacy top-level response for old clients. New clients
  opt into `subscription-state-v1` and `station-recovery-v1`, retain negotiated denied outcomes, and
  still decode old-server responses.
- Shift bundle reads and SSCC allocation now share one transaction. The service locks and reloads the
  authoritative same-tenant shift before resolving access or touching a serial counter. Planned,
  non-aggregation, and post-expiry-opened shifts receive no block. An active aggregation shift
  opened before expiry remains eligible recovery after expiry.

## Kiosk recovery and durable order admission

- The kiosk error parser retains server `code` independently of `message`.
  `subscription_read_only` quarantines only that record and the same drain pass continues; ordinary
  403 remains retryable.
- Rolling capability negotiation prevents a pre-Task-8 kiosk from wedging on that new coded 403.
  The current client sends `x-kiosk-capabilities: subscription-recovery-v1` and receives the exact
  403 verdict it understands. A client with no capability receives the same exact
  `subscription_read_only` body under terminal-compatible 422, before any business write. A helper
  frozen from commit `d8c6fc8b` proves that status is terminal to the old worker.
- Before a new queued order is submitted, an authenticated kiosk requests a just-in-time server
  reservation for that exact sequence and normalized order content. The server selects its own
  `claimedAt` inside the write-access transaction and returns a random opaque bearer. PostgreSQL
  stores only its SHA-256 hash and the canonical content digest; raw KM, badge, token, and proof are
  absent from admission rows and tenant audit data.
- After expiry, recovery requires an exact tenant/kiosk/sequence/token-hash/content-digest/timestamp
  match. Caller backdating, an unused generic bearer, forged tokens, changed content, wrong sequence,
  another kiosk, or another tenant fail with exact `subscription_read_only` and no business write.
- The persisted subscription FK is the issuance authority. A later pending renewal cannot invalidate
  a genuine reservation issued under the previously active subscription; it also cannot retarget the
  admission to another tenant or kiosk.
- There is no fixed 128-record window and no HMAC keyring or rotation dependency. Each locally durable
  order obtains its own reservation, so sequence 128 after 129 queued records is covered and two
  server-secret rotations are irrelevant.
- Proofless/pre-deploy and failed-attestation records remain durable locally but are never
  auto-applied after expiry. Exact 403 handling moves each one to durable client quarantine/manual
  recovery and continues draining later records. The existing seven-day client no-new-work lock is
  unchanged.
- Admission and delivery now share the one serialized drain. A new order is first stored as
  `pending_attestation`; the exact attested body is durably written before submit. A delayed
  response crossing expiry cannot race a second drain into submitting the proofless body, and a
  conditional update that finds the row removed neither submits nor resurrects it. A crash before
  persistence re-attests; a crash after persistence resumes the exact proof-bearing submit.
- Admission rows are constant-sized and unique per authenticated tenant/kiosk/sequence; rotating a
  bearer for the same sequence updates in place without imposing a fixed honest-queue cap. Distinct
  129-record backlogs remain valid. Durable order success consumes the admission in the order
  transaction; durable rejection consumes it in the rejection transaction; already-durable replay
  also cleans a leftover row. No bearer/proof or raw business payload is logged or added to audit.
- Bootstrap now derives redacted subscription state from the same single recovery resolution and
  transaction; there is no split subscription/proof read and no unconditional proof array.

## CommerceML

`mode=import` asserts write access after the authenticated exchange session resolves authoritative
`tenantId` and before assembly, parsing, or catalog/order-status mutation. Denial returns the stable,
non-leaking `failure\nsubscription write unavailable`, appends the exact bounded integration journal
event, and cannot partially mutate data. The matrix covers active, expired, broken managed,
unmanaged `managed_only`, and unmanaged `all`; query/export and success acknowledgement remain
available.

## RED evidence

Round 1 RED established the behavioral surface:

- kiosk exact parser/drain: 2 failures in 108 tests (lost code; denied head wedged later work);
- station replay binding: 3/3 focused cases failed; mixed recovery returned whole-batch 403;
- DB binding/quarantine schema: 2/2 failed;
- station negotiation: two API and two client response/capability failures;
- CommerceML expired import incorrectly returned success;
- registered inventory initially reported 28 undocumented exceptions.

Round 2 RED before the production fixes:

- admission schema 1/1 failed because `kioskOrderAdmissions` did not exist;
- kiosk API client 1/25 failed because exact-order attestation was absent;
- kiosk app 1/47 failed because submission never called `/kiosk/order-admissions`;
- API review matrix: 8 failures and 89 passes across four files: proofless/backdated work was
  accepted, just-in-time reservation was absent, bootstrap still exposed a fixed 128 window and
  split snapshot reads, planned expired bundle allocated, a legacy batch was first-caller-bound, and
  route inventory missed guarded customer GETs;
- final adversarial self-review added one RED: a valid old reservation returned 403 when a pending
  renewal became resolver-selected.

Round 3 RED before production changes:

- kiosk API client: 1 failure / 24 skipped because the recovery capability header was absent;
- kiosk worker: pending attestation lost the race to submit, and removal during a delayed response
  could have submitted or resurrected the stale in-memory row;
- API recovery matrix: 5 behavioral failures across legacy no-cap response (403 instead of 422),
  unconsumed success, unconsumed terminal rejection, unconsumed already-durable replay, and 129
  retained rows lacking an explicit same-sequence storage-bound assertion;
- route inventory: the canonical contract was initially empty against 97 actual guarded customer
  routes; the earlier unsafe-mode assertion compared against the nonexistent `read` enum value;
- full kiosk integration then exposed a further real regression: because attestation had become the
  first network step, reachability state was updated only around submit. Both direct outage and
  gateway outage tests failed until attestation carried the same signal.

## GREEN verification

| Check | Result |
| --- | --- |
| Round 3 focused API expiry/recovery | 1 file, 12/12 passed |
| Registered 97-route canonical inventory | 1 file, 2/2 passed |
| Round 3 focused kiosk API/worker | 2 files, 112/112 passed |
| Final affected kiosk API/worker/shell | 3 files, 159/159 passed |
| Durable admission schema focused | 1/1 passed |
| DB full suite | 19 files, 100/100 passed |
| API final configured full suite | 116 passed files, 1 skipped; 1204 passed, 2 skipped (1206 total) |
| Kiosk final full suite | 20 files, 437/437 passed |
| Station focused timeout retry | 2/2 passed, 55 filtered |
| Station isolated full suite | 51 files, 581/581 passed |
| DB/API/kiosk/station typecheck | passed |
| DB/API/kiosk/station lint | passed |
| DB/API/kiosk/station build | passed |
| Repository `format:check` | passed |
| `git diff --check` | passed |
| Migration apply | `0033` applied successfully to configured local development Postgres |

The final API full run used `.env` plus the exact non-secret values from
`PLATFORM_TEST_ENV`. Expected Nest error output in the green run comes from explicit fault-injection
and rollback tests. A full run accidentally launched from the main checkout also passed but is not
counted; the table records only the subsequent configured run from this Task 8 worktree. The DB
count likewise records the configured rerun with `DATABASE_URL`, not the initial intentionally
skipped no-environment invocation.

The two configured API skips are:

1. `local-infrastructure.e2e.test.ts`: real Mailpit/MinIO product lifecycle;
2. `provision-tenant-owner.e2e.test.ts`: real documented tenant-owner CLI command.

## Limits

- No physical station/kiosk, scanner, printer, Windows/Tauri, or factory-network acceptance was run.
- The two explicitly infrastructure-gated API tests above were not exercised.
- Automated tests cover the wire protocol, IndexedDB/local journal persistence, queue progression,
  restart/replay, tenant isolation, transaction boundaries, and durable quarantine; they do not
  replace hardware acceptance.
- No Task 9 customer banner or broad UI/global blocker was added.
