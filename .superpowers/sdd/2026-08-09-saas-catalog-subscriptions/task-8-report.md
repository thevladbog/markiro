# Task 8 report — subscription features, expiry, and offline recovery

Date: 2026-08-11

## Outcome

Task 8 plus review rounds 1 and 2 are implemented. Subscription enforcement is explicit at the
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

## Registered route inventory

`subscription-route-inventory.test.ts` compiles the real `AppModule`, walks registered controller
methods through Nest `ModulesContainer`, and inspects every route carrying
`SubscriptionAccessGuard`, every unsafe method, and conditional CommerceML GET import.

Every guarded customer route must have explicit subscription metadata and one exact guard chain:

- cabinet: `TenantGuard -> AuthorizationGuard -> SubscriptionAccessGuard`;
- station sync: `TenantGuard -> StationOnlyGuard -> SubscriptionAccessGuard`;
- kiosk: `KioskDeviceGuard -> SubscriptionAccessGuard`.

Every guarded unsafe method must own a handler-level non-read policy; it cannot silently inherit
the controller's class-level read policy.

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
- Admission failure before delivery does not lose work: the queue row is written first, and its
  cursor-safe update cannot resurrect a row concurrently dequeued by sync. Exact applied replay
  remains idempotent.
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

## GREEN verification

| Check | Result |
| --- | --- |
| Round 2 focused API matrix | 5 files, 100/100 passed |
| Final adversarial expiry/recovery file | 1 file, 10/10 passed |
| Durable admission schema focused | 1/1 passed |
| DB full suite | 19 files, 100/100 passed |
| API final configured full suite | 116 passed files, 1 skipped; 1201 passed, 2 skipped (1203 total) |
| Kiosk full suite | 20 files, 435/435 passed |
| Station focused timeout retry | 2/2 passed, 55 filtered |
| Station isolated full suite | 51 files, 581/581 passed |
| DB/API/kiosk/station typecheck | passed |
| DB/API/kiosk/station lint | passed |
| DB/API/kiosk/station build | passed |
| Repository `format:check` | passed |
| `git diff --check` | passed |
| Migration apply | `0033` applied successfully to configured local development Postgres |

The final API full run used `.env` plus the exact non-secret values from
`PLATFORM_TEST_ENV`. A preceding invocation without those three variables failed 52 suites during
environment parsing and is not counted as behavioral verification; the correctly configured rerun
above supersedes it. Expected Nest error output in the green run comes from explicit fault-injection
and rollback tests.

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
