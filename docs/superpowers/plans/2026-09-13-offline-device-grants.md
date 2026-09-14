# Offline Device Grants (P1C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Implement signed, bounded offline new-work and frozen-task completion admission for Station, Handheld and kiosk while retaining every durable evidence/recovery path.

**Architecture:** A versioned native grant protocol shares entitlement facts with the public API but has independent authentication, signing and admission. The server signs immutable grants against locked device/task state; each client verifies the original JWS and atomically commits consumption with its existing journal. Observation is the default; production enforcement is a separately approved P1D operation.

**Tech Stack:** Node 24+, repository-pinned pnpm, NestJS/Drizzle/Postgres, Zod, Web Crypto ES256, Station SQLite/Tauri, Android Kotlin/Room/Signature, kiosk IndexedDB, Vitest and Gradle.

**Spec:** `docs/superpowers/specs/2026-09-13-public-api-offline-grants-design.md` (approved source: `.superpowers/design-2026-09-13-public-api-offline/program-design.md`). This plan covers P1C only; the companion public-API plan owns scopes, public principals, actor migration and public inventory endpoints.

## Implementation status

Completed and independently reviewed on 2026-09-14. The final workspace gates
and additional native/browser checks are recorded in
[the acceptance report](../../acceptance/offline-device-grants.md). Production
policy values, strict activation and physical pilot acceptance remain separate P1D
work.

## Global Constraints

- Two grants: device grant for new work until `startNotAfter`; task grant for one frozen task until `completeNotAfter`.
- Compact JWS; fixed `ES256` (P-256/SHA-256); protected `typ`, `kid`, `alg`; signature is exactly 64 bytes R||S. Verify original signing input, never reconstructed JSON.
- No production offline/completion duration is introduced here. Absent approved policy returns `policy_not_configured`; it does not block existing clients or commercial catalog/quotes/invoices/subscriptions/add-ons.
- New clients start in observation. Strict requires supported protocol, approved policy and explicit rollout; production activation and real pilot are P1D, outside this plan.
- Native paths do not require `publicApi`. Existing shadow owners remain shadow. `unknown` facts cannot produce a signed permission.
- Preserve tenant/device identity, server credential epoch, local credential/task leases, operator authorization, closed-task state, snapshot identity, print bytes, queues, device sequence and idempotency.
- Evidence ingestion with valid recovery authorization is independent of productive admission; distinguish accepted, duplicate and quarantined. Revoked credentials do not obtain recovery authorization merely by possessing a grant.
- Forward migrations only. Do not backfill historical evidence with fabricated grant IDs, epoch or approval.
- Negotiated task snapshot canonical bytes must hash to the signed digest. Each client compares an explicit projection of static task fields used in local execution and fresh label rendering against its authenticated durable bundle/manifest and commit inputs. Unused server storage metadata remains signed provenance; it is not compared to an unrelated local field. Number components may map to the existing formatted number, and active template specifications/policy must match. Include counterparty label text in the signed shift scope. Freeze the raw shift box capacity and the raw pallet capacity gated by palletsEnabled, matching the existing native bundle and productive owners; do not introduce a product-capacity fallback only in grant projections. Planned closure targets, operator identity, action timestamps and SSCC allocation retain their existing independent authority and do not replenish grant budgets. Retain already available wire fields locally as needed; legacy caches missing required execution facts must refresh before grant installation.
- No new CDN or online runtime dependency on an offline factory path. Private keys remain server-only. Public-key rotation ships verifiers before switching signer and retains historical keys.
- Each implementation task runs its own failing test, implementation, passing focused check and reviewable diff. Leave all implementation changes uncommitted; commit, push and PR require separate user authorization.

## Source-backed boundaries and file map

Existing anchors verified during planning:

| Surface           | Existing owner / integration files                                                                                                                                                                                                                                           | Added units                                                                                                                                                                                       |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared contract   | `packages/platform-contracts/src/index.ts`, `packages/domain/src/index.ts`                                                                                                                                                                                                   | `packages/platform-contracts/src/offline-grants.ts`; `packages/domain/src/offline-grants/{types,contracts,jws,clock,decision}.ts`                                                                 |
| Server credential | `packages/db/src/schema/platform.ts` (`stationDevices`), `packages/db/src/schema/pickup.ts` (`kiosks`); `apps/api/src/modules/station-pairing/station-pairing.service.ts`, `apps/api/src/modules/kiosk/pairing.service.ts`                                                   | `packages/db/src/schema/device-grants.ts`; `apps/api/src/modules/device-grants/credential-epoch.ts`                                                                                               |
| Issuer            | `apps/api/src/subscriptions/entitlement-snapshot-reader.ts` (`readEntitlementFacts`); inventory snapshot/bundle owners; `apps/api/src/modules/pickup-orders/kiosk-admission-proof.ts`                                                                                        | `apps/api/src/modules/device-grants/{device-grants.module,device-grants.controller,kiosk-grants.controller,grant-issuer.service,grant-policy,grant-keyset,frozen-task,grant-evidence.service}.ts` |
| Station           | `src/lib/{credential-recovery,device-recovery,shift-bundle,inventory-bundle,journal,inventory-journal,shift-close,close-box,box-printing,inventory-box-printing}.ts`, `src/lib/product-labels/{store,acceptance,printing,recovery}.ts` under `apps/station`                  | `apps/station/src/lib/offline-grants/{store,admission,transport,clock}.ts`; `apps/station/src-tauri/src/grant_clock.rs`                                                                           |
| Handheld          | `core/storage/{HandheldDatabase,Migrations,DeviceRecovery}.kt`, `core/{scan/ScanRecorder,inventory/InventoryRecorder,box/BoxRepository}.kt`, `feature/shift/ShiftRepository.kt`, `core/network/StationApi.kt` under `apps/handheld/app/src/main/kotlin/app/markiro/handheld` | same Kotlin root: `core/grants/{GrantDtos,GrantVerifier,GrantClock,GrantAdmission,GrantRepository}.kt`, `core/storage/{GrantEntities,GrantDao}.kt`                                                |
| Kiosk             | `apps/kiosk/src/store/{db,queue,installation-binding}.ts`, `apps/kiosk/src/session/flow.ts`, `apps/kiosk/src/sync/worker.ts`                                                                                                                                                 | `apps/kiosk/src/grants/{store,admission,transport,clock}.ts`                                                                                                                                      |
| Evidence          | `apps/api/src/modules/station-scans/station-scans.service.ts`, `apps/api/src/modules/inventories/station-inventory-sync.service.ts`, `apps/api/src/modules/pickup-orders/pickup-orders.service.ts`                                                                           | grant evidence classification service above; negotiated envelope contract                                                                                                                         |

Read root/API/Station/Handheld `AGENTS.md`, `README.md` and `docs/architecture.md` before execution. Run `git status --short` and preserve existing work. Build shared packages before consumer checks. No local graph existed in this worktree during this planning pass; if one exists at execution, use its query first and update after code edits.

## Task 1: Freeze native protocol and portable signed fixtures

**Files:** Create `packages/domain/src/offline-grants/types.ts`, `packages/domain/src/offline-grants/contracts.ts`; `packages/platform-contracts/src/offline-grants.ts`; `packages/platform-contracts/test/offline-grants.test.ts`; `packages/platform-contracts/tools/generate-offline-grant-fixtures.mjs`; `packages/platform-contracts/fixtures/offline-grants-v1.json`; `apps/handheld/app/src/test/resources/offline-grants-v1.json`. Modify both package `src/index.ts` exports and platform-contracts `package.json` for `fixtures:offline-grants`.

**Interfaces:** Domain owns structural types AND strict signed-header/payload schemas in `contracts.ts` using its existing Zod peer. Platform-contracts reexports those schemas and owns transport envelope/result schemas. Domain verification imports its local schemas; no duplicated TS payload validator and no reverse domain-to-platform-contracts dependency. Schema inference/type assignment tests prove alignment. Use these protocol names in every later task:

```ts
export type DeviceKind = "station" | "handheld" | "kiosk";
export interface GrantOwner {
  tenantId: string;
  deviceId: string;
  kind: DeviceKind;
  credentialEpoch: number; // positive safe integer, server-owned
}
export interface GrantBase extends GrantOwner {
  version: 1;
  issuer: string;
  grantId: string;
  entitlementRevision: string;
  policyRevision: string;
  issuedAt: number;
  notBefore: number; // integer Unix milliseconds
}
export interface DeviceGrant extends GrantBase {
  kindOfGrant: "device";
  startNotAfter: number;
  capabilities: GrantCapability[];
}
export interface BudgetLine {
  id: string;
  unit: "event" | "unit" | "container";
  maximum: number;
}
export interface TaskGrant extends GrantBase {
  kindOfGrant: "task";
  taskKind: "shift" | "inventory" | "pickup";
  taskId: string;
  snapshotDigest: string;
  completeNotAfter: number;
  eventTypes: GrantEventType[];
  budget: BudgetLine[];
}
export type OfflineGrant = DeviceGrant | TaskGrant;
export interface GrantEnvelope {
  protocol: "offline-grants-v1";
  serverTime: number;
  owner: GrantOwner;
  mode: "observe" | "strict";
  grants: string[]; // original compact JWS, never reserialized
}
export type GrantIssueResult =
  | { status: "issued"; envelope: GrantEnvelope }
  | {
      status: "denied";
      reason:
        | "policy_not_configured"
        | "not_entitled"
        | "facts_unknown"
        | "task_not_frozen"
        | "bounds_required";
    };
```

Protected header is exactly `{typ:"markiro-offline-grant+jws",alg:"ES256",kid:string}`. Export the following finite literal unions and corresponding Zod enums from domain. These are grant protocol names, not assertions that existing entitlement registry entries already exist:

```ts
export type GrantCapability = "shift.start.v1" | "inventory.start.v1" | "pickup.start.v1";
export type GrantEventType =
  | "shift.scan.v1"
  | "shift.box.close.v1"
  | "shift.pallet.close.v1"
  | "shift.label.prepare.v1"
  | "shift.close.v1"
  | "inventory.scan.v1"
  | "inventory.repack.v1"
  | "inventory.box.close.v1"
  | "inventory.close.v1"
  | "pickup.complete.v1";
```

Allow shifts on Station/Handheld, inventory on Station/Handheld, pickup on kiosk. Productive event adapters map existing journal/box/pallet/label/repack owner operations to these names. Print transport, verification of saved bytes, undo/exception evidence and sync are recovery facts, not a way to prepare an extra unit through an uncharged event. Task 3 adds explicit native registry mappings before issuance is enabled. Times are milliseconds throughout, never implicit JWT seconds. `notBefore <= now < startNotAfter/completeNotAfter`; the deadline instant is denied. `GrantBase.kind` describes the device and `kindOfGrant` discriminates the payload.

- [x] Write schema tests rejecting negative/noninteger epoch, unknown fields, empty completion budget, duplicate budget IDs, invalid time ordering and incompatible task/device kinds. The first test includes:

```ts
expect(offlineGrantSchema.safeParse({ version: 1 }).success).toBe(false);
expect(grantIssueResultSchema.parse({ status: "denied", reason: "policy_not_configured" })).toEqual(
  { status: "denied", reason: "policy_not_configured" },
);
```

- [x] Run `pnpm --filter @markiro/platform-contracts exec vitest run test/offline-grants.test.ts`; expect missing export/schema failure.
- [x] Implement signed-header/payload strict Zod schemas in domain, reexport through platform-contracts, and implement envelope/result schemas in platform-contracts. Keep old pairing, bundle, recovery and batch DTOs byte/shape compatible. Grant protocol negotiation uses separate routes and does not add fields to legacy strict schemas.
- [x] Generate and commit a test-only P-256 fixture key plus vectors: valid device/task; alternate whitespace/key order with valid original-byte signature; altered payload; altered R/S; DER signature instead of R||S; `none`/HS256 header; unknown kid; wrong typ; tenant/device/epoch/snapshot mismatch; exact deadline; exhausted budget; unknown critical header. Private fixture key is explicitly test-only; build outputs must not include it. Store producer input, compact token and expected cryptographic/semantic result separately. The generator writes both fixture destinations identically; fixtures never contain production identities or scanned secrets.
- [x] Run `pnpm --filter @markiro/platform-contracts fixtures:offline-grants` and schema tests. Add a deterministic regeneration comparison that compares committed tokens without requiring randomized ECDSA signatures to regenerate identically: verify committed signatures against their recorded inputs and compare deterministic payload/vector definitions. Review the scoped diff and leave it uncommitted.

## Task 2: ES256 verification, trusted time and pure decisions

**Files:** Create domain `src/offline-grants/{jws,clock,decision}.ts`; `packages/domain/test/offline-grants-{jws,clock,decision}.test.ts`. Modify domain `src/index.ts` exports.

**Interfaces:** Consume Task 1 types. Produce:

```ts
export interface VerificationKey {
  kid: string;
  origin: string;
  jwk: JsonWebKey;
}
export type VerifiedGrantResult =
  | { ok: true; grant: OfflineGrant; compact: string }
  | { ok: false; reason: "malformed" | "bad_signature" | "unknown_key" | "wrong_origin" };
export function verifyGrant(
  compact: string,
  keys: readonly VerificationKey[],
  serverOrigin: string,
): Promise<VerifiedGrantResult>;
export interface TrustedClock {
  serverMs: number;
  monotonicMs: number;
  bootId: string;
  highWaterMs: number;
  wallHighWaterMs: number; // local wall clock; never compare directly with server time
}
export function assessClock(
  anchor: TrustedClock,
  sample: {
    monotonicMs: number;
    bootId: string;
    wallMs: number;
  },
): { trusted: true; now: number } | { trusted: false; reason: "clock_untrusted" };
export interface GrantIntent {
  owner: GrantOwner;
  capability: GrantCapability;
  taskId: string;
  snapshotDigest: string;
  eventId: string;
  eventType: GrantEventType;
  cost: Record<string, number>;
}
export type LocalDecision =
  | { allow: true }
  | {
      allow: false;
      reason:
        | "missing_grant"
        | "wrong_owner"
        | "not_yet_valid"
        | "expired"
        | "wrong_task"
        | "event_forbidden"
        | "budget_exhausted"
        | "clock_untrusted";
    };
export function assessNewWork(
  grant: DeviceGrant | null,
  intent: GrantIntent,
  now: number | null,
): LocalDecision;
export function assessCompletion(
  grant: TaskGrant | null,
  intent: GrantIntent,
  now: number | null,
  consumed: Readonly<Record<string, number>>,
): LocalDecision;
```

Cryptographic verification is asynchronous before opening local write transactions. A successful verification cannot bypass transaction-time owner/time/budget revalidation. Local operator/task authorization remains a separate required check. `GrantIntent.cost` is an internal value constructed by the durable event adapter from the validated action; network/UI inputs cannot choose cost, mode or owner.

- [x] Test original signing bytes and exact-deadline semantics with committed fixture inputs. Use table-driven tests for each fixture; expected verification output is recorded by Task 1. Add a decision test whose `now` equals `completeNotAfter` and assert `{allow:false,reason:"expired"}`.
- [x] Run `pnpm --filter @markiro/domain exec vitest run test/offline-grants-jws.test.ts test/offline-grants-clock.test.ts test/offline-grants-decision.test.ts`; observe failing imports.
- [x] Implement three-segment base64url parsing; reject extra/unrecognized protected fields, algorithm confusion, malformed JSON, noncanonical encoding and signature length other than 64. Import only P-256 public keys under the configured origin; call WebCrypto verify over ASCII `encodedHeader + "." + encodedPayload`. Validate decoded payload without reserializing before signature verification. Keep private signing entirely outside domain.
- [x] Implement time as server anchor + monotonic elapsed, persisted high-water mark, boot identity and an independent local-wall high-water captured at trusted synchronization. Reboot/unknown boot identity, backwards elapsed or local wall rollback below its own high-water => untrusted. A stable positive or negative local/server clock offset is not rollback and must remain usable. Process restart must not create a new server anchor; a client unable to preserve boot-relative monotonic identity returns untrusted until online sync. Persist returned server-domain high-water and the observed local-wall high-water in the same durable productive commit. Test stable clock offsets in both directions and a forward local wall jump followed by rollback.
- [x] Implement budget checking using nonnegative safe-integer costs and subtraction-safe comparisons (`cost <= maximum - consumed`). Every cost key must exist in budget; all applicable dimensions must be charged. Consumption belongs to `(tenant,device,taskKind,taskId,snapshotDigest,budgetLineId)`, independently of credential epoch, grantId, policy revision and batch identity: credential recovery and token renewal cannot reset the task allowance. Exact event replay returns its saved result before any fresh charge.
- [x] Run focused tests then `pnpm --filter @markiro/domain test`, `typecheck`, `lint`, `build` as separate commands. Review the scoped diff and leave it uncommitted.

## Task 3: Server epoch, approved policies, frozen task and issuance ledger

**Files:** Modify DB `src/schema/{platform,pickup,index}.ts`; create `packages/db/src/schema/device-grants.ts`, `packages/db/test/device-grants-schema.test.ts`, `packages/db/test/device-grants-migration.test.ts`; generate forward migration using `pnpm --filter @markiro/db db:generate` (use the next generated filename, never edit applied migrations). Create API `src/modules/device-grants/{credential-epoch,grant-policy,frozen-task}.ts`; modify both pairing services in the map and their existing pair/recovery tests; create `apps/api/test/device-grants-epoch.test.ts`, `device-grants-policy.test.ts`, `device-grants-frozen-task.test.ts`.

**Interfaces:** `credentialEpoch` is persisted on stationDevices/kiosks, initialized to 1 for present identity and incremented atomically whenever credential ownership changes. It is not Station's local `CredentialGeneration` or Android generation. Produce:

```ts
export interface ApprovedGrantPolicy {
  revision: string;
  approvalReference: string;
  maxOfflineMs: number;
  maxCompletionMs: number;
}
export interface FrozenGrantTask {
  taskKind: "shift" | "inventory" | "pickup";
  taskId: string;
  snapshotDigest: string;
  eventTypes: GrantEventType[];
  budget: BudgetLine[];
}
export function computeGrantDeadlines(input: {
  now: number;
  policy: ApprovedGrantPolicy | null;
  entitlementBoundary: number | null;
}):
  | { status: "denied"; reason: "policy_not_configured" | "facts_unknown" }
  | { status: "ready"; startNotAfter: number; completeNotAfter: number };
```

A null entitlement boundary means no proven finite admission horizon in this first version, hence `facts_unknown`, not infinity. Values in fixtures are test time intervals, never configuration defaults. Read existing `entitlementLifecyclePolicies` in `packages/db/src/schema/entitlements.ts`: require `status=approved`, valid `payloadHash`, approval actor/time and `decisionReference`; parse offline/completion bounds from its versioned payload. Reuse that audited registry, do not add a parallel policy table. Current payloads have no numeric grant contract: introduce a documented strict versioned `offlineGrant` object within the existing payload for finite durations and explicitly configured per-task productive bounds. Missing/unknown payload versions deny issuance; approved rows remain immutable, so changes require a new approved policy version. Do not infer production limits from plannedQty, allocator blocks or expected snapshot count. The signed `policyRevision` binds existing policy ID/version/payload hash. No production seed policy is added.

- [x] Write policy tests for absent approval, invalid duration, finite paid/trial/grace boundary and shorter approved maximum. Example: `computeGrantDeadlines({now:1000,policy:null,entitlementBoundary:2000})` equals `{status:"denied",reason:"policy_not_configured"}`. Add real DB concurrency tests where pair/recover races issuance; only one epoch/credential owner can win.
- [x] Run focused tests red, generate reviewed SQL and build DB before API tests. New tables cover immutable issuance (`grantId`, compact bytes, header kid, payload digest, owner, revisions, task scope, deadlines, issue request identity) and evidence dispositions; policy references point to the existing audited lifecycle-policy registry. Use explicit tenant FKs for station/kiosk owners, a check that exactly one device-owner FK is set, and uniqueness matching owner/kind. Store private key outside DB records.
- [x] Cover every credential owner: station pair/recovery and durable revoke, kiosk pairing, direct enroll, status invalidation and unbind. Preserve station revoke's existing early committed key deletion; issuer must recheck live key existence as well as epoch. Pairing-code issuance and replacement preparation alone do not change epoch. Increment epoch in the existing credential replacement transaction, alongside retiring old key/linking new credential. A database BEFORE UPDATE trigger is the single invariant owner: actual credential changes increment, repeated no-ops do not; manual epoch edits and overflow fail closed. Prove all existing service mutation paths against the migrated database. Grant installation only obtains epoch through negotiated authenticated exchange. Revoke blocks issue immediately; no promise of instant offline revocation. Preserve older epoch grants as evidence provenance, never reassociate them with new production.
- [x] Freeze under the business owner's lock: inventory digest uses its existing selected snapshot/digest; event allowlist derives from check/repack mode and finite scope. Shift freezes product/template/task identity plus explicitly configured finite unit/container/event limits; absent limits returns `bounds_required`. Kiosk freezes the existing reservation's canonical order digest, exact lines and sequence; absent reservation returns `task_not_frozen`. A content change creates a new frozen identity and needs new-work admission; task completion cannot switch identity.
- [x] Extend `packages/platform-contracts/src/entitlements.ts` registry with explicitly versioned native definitions before adding issuer mapping: `native.shift.start.v1` (existing station/shift authorization, no new commercial feature), `native.inventory.start.v1` (existing station/inventory authorization plus inventory feature), `native.pickup.start.v1` (existing kiosk/operator/reservation authorization, no new commercial feature). Map domain capability `shift.start.v1`, `inventory.start.v1`, `pickup.start.v1` to these entries respectively. Handheld additionally requires existing `handheld.work.start.v1` and its feature, never a cabinet inventory-start permission. Positive baseline authorization plus finite approved lifecycle policy is required even when feature list is empty. Frozen completion event allowlist is scoped by these admitted tasks and cannot authorize a new start. Add registry coverage tests, bump registry version, and review the resulting entitlement fingerprint/revision invalidation with the companion API plan; no fabricated old registry IDs and no fallback wildcard. Bounds include every Task 1 productive event dimension; cost is calculated inside each trusted event owner from the persisted fact/container/line set, never from caller-supplied authoritative counts.
- [x] Run focused DB/API tests against migrated isolated Postgres; verify tenant FK rejection, rotation rollback and history preservation. Run DB package gates and inspect actual migration journal. Review the scoped diff and leave it uncommitted.

## Task 4: Authenticated issuer, key rotation and negotiated routes

**Files:** Create API `src/modules/device-grants/{device-grants.module,device-grants.controller,kiosk-grants.controller,grant-issuer.service,grant-keyset}.ts`; wire `apps/api/src/app.module.ts`; modify API env loader/example variable inventories at their existing declarations; add `apps/api/test/device-grants-{issuer,routes,keyset}.test.ts`; update `test/subscription-route-inventory.test.ts`, relevant OpenAPI route contracts and generated OpenAPI via repository scripts.

**Interfaces:** `GrantIssuerService.issueDevice(owner: GrantOwner, requestId: string): Promise<GrantIssueResult>` and `issueTask(owner: GrantOwner, task: {taskKind: FrozenGrantTask["taskKind"];taskId:string}, requestId:string): Promise<GrantIssueResult>`. Task input is an identity lookup; callers never submit authoritative bounds, snapshot or capabilities. Native routes:

```text
POST /station/grants/v1/device         station/handheld credential only
POST /station/grants/v1/tasks          station/handheld, authorized task kinds only
GET  /station/grants/v1/keyset         current station/handheld authentication
POST /kiosk/grants/v1/device           kiosk credential only
POST /kiosk/grants/v1/reservations     authenticated canonical order attestation + frozen scope
POST /kiosk/grants/v1/tasks            current kiosk reservation only
GET  /kiosk/grants/v1/keyset            current kiosk authentication
```

The negotiated kiosk reservation endpoint reuses existing canonical order/nonce validation and authoritative attestation, persisting exact frozen scope and returning existing admission proof plus reservation task identity in a new envelope. Task-grant requests remain identity-only; no authoritative counts come from their callers. Existing strict native responses stay unchanged.

Request schema requires `protocol:"offline-grants-v1"`, stable `requestId` and advertised supported capability; routes return Task 1 result and never alter existing native responses. Keyset has `{protocol,origin,revision,keys:[{kid,jwk}],retiredKids:[]}`; retirement is an explicit security policy action, not routine key rotation.

- [x] Test released/cancelled working-device assignment, excluded retained-device selection, unresolved over-limit pool, kiosk archive/revoke, replacement in flight and their races with issuance. A valid credential alone must not regain commercially removed new-work rights. Completion of a previously authorized task and evidence recovery remain separate.
- [x] Test wrong-purpose credentials, cross-tenant/task/device access, unsupported protocol, `policy_not_configured`, replay and pending key rotation. Add racing revoke/epoch change test asserting no issue committed under stale authentication. Public keys and cabinet sessions cannot use the grant endpoint.
- [x] Run `pnpm --filter @markiro/api exec vitest run test/device-grants-issuer.test.ts test/device-grants-routes.test.ts test/device-grants-keyset.test.ts` red.
- [x] Read `readEntitlementFacts` in the same consistent owner transaction and use the shared deterministic evaluator; do not call fail-open shadow admission. First inspect the quota/revision/device/task lock order of pairing, replacement, retention and existing task writers; use that established order consistently for issuance, never impose device-first if a writer holds revision-first. Under those locks require consistent active assignment, effective retained membership and resolved pool capacity for station/handheld, or valid kiosk lifecycle/quota for kiosk; issuance and writers of those facts must share that fencing protocol. Audit exact actor domain/device ID, tenant, issue operation, grant/task target, allow/denial and revisions. Issuance is durable before response and replay returns saved compact bytes for unchanged request identity; changed task input with same requestId is conflict. Reauthenticate for replay and before issue commit.
- [x] Sign protected header/payload bytes with server key using Node `dsaEncoding:"ieee-p1363"`; assert 64-byte signature. Resolve key from server configuration with `kid`; fail startup/health readiness for inconsistent key/public keyset. Install no private material in client bundles, test fixtures excepted. Keyset updates are authenticated current-origin only; forbid server-origin changes by payload. Roll keyset before signer and retain earlier public keys.
- [x] Classify new issue routes as productive authorization, keyset retrieval as authenticated recovery-compatible read. An expired subscription can retrieve verifier keys/evidence status but cannot create new grant entitlement. Native recovery credentials may authorize evidence only according to their existing policy, not obtain new productive issuance automatically.
- [x] Run route inventory/OpenAPI checks and focused tests green. Review the scoped diff and leave it uncommitted.

## Task 5: Station persistence and atomic admission

**Files:** Create Station `src/lib/offline-grants/{store,admission,transport,clock}.ts` and `src-tauri/src/grant_clock.rs`; modify `src-tauri/src/lib.rs` command registration; DB `src/sqlite/{schema,migrations}.ts`; existing Station owners listed in map; `src/lib/{shift-entry-lease,api-client}.ts`; create `apps/station/test/offline-grants-{store,admission,recovery}.test.ts`, `packages/db/test/offline-grants-sqlite.test.ts`.

**Interfaces:** `installStationGrant(envelope: GrantEnvelope, generation: CredentialGeneration): Promise<void>` verifies before I/O, then checks current owner/epoch and existing credential lease again at persistence. `StationGrantAdmission` exposes `assessNewWork`/`assessCompletion` with Task 2 intents; DB atomic command carries `{eventId,owner,taskId,snapshotDigest,grantId,cost,clockHighWater,mode}` plus existing event payload. Rust `grant_clock_sample` returns `{bootId,monotonicMs,wallMs}` using boot-relative monotonic source; inability to establish boot identity yields untrusted time.

- [x] Add a real SQLite test racing two last-unit commits. Assert one durable event, one charge, one outbox receipt and `budget_exhausted` for the loser. Add exact-event replay, transaction failure between charge/event/outbox, stale credential installation, task-close followed by delayed bundle and database upgrade with pending sending print.
- [x] Run new focused Station/SQLite tests red. Add grant/consumption/event-charge/clock stores to authoritative DB package. Use the existing single-statement command/trigger approach for pooled SqlExecutor: one statement checks owner/budget, inserts unique event charge and invokes existing fact/outbox writes. If a particular owner requires multiple statements, introduce a held-connection native transaction command for that owner; never add `BEGIN`/`COMMIT` to pooled JavaScript calls.
- [x] Preserve existing recovery reservation boundaries in inventory journal: charge with the durable reservation, and replay pending reservation under its saved decision without another debit. Enforce at journal/box/pallet/duplicate-print owner commits, not only page buttons. Starting task/next shift/changed product requires device grant and existing operator authorization. Completion requires same frozen identity, allowed event and remaining multidimensional budget. Observe stores would-deny reason but preserves existing authorization/result; strict denies new productive fact only.
- [x] Install envelopes from separate negotiated transport while holding existing generation/entry coordination. Clear admission eligibility on credential sealing without deleting grants/events. Persist boot anchor/high-water; Rust clock unit tests cover restart same boot and changed boot, and WebView fallback uses untrusted after process recreation.
- [x] Preserve prepared/sending/delivery-unknown/verified print states. Admission denial must not turn unknown delivery into failed/no print or regenerate saved product bytes. Explicit recovery of saved jobs remains reachable; admitting a new unit/print job still requires valid productive decision.
- [x] Run focused tests plus Station package gates after `pnpm turbo run build --filter='@markiro/station^...'`; run DB SQLite tests and `cargo test --manifest-path apps/station/src-tauri/Cargo.toml`. Review the scoped diff and leave it uncommitted.

## Task 6: Handheld verifier, Room upgrades and generation-safe admission

**Files:** Create Kotlin grant/storage units from map; modify `core/storage/{HandheldDatabase,Migrations,DeviceRecovery,StorageModule}.kt`, `core/network/StationApi.kt`, `core/{scan/ScanRecorder,inventory/InventoryRecorder,box/BoxRepository}.kt`, `feature/shift/ShiftRepository.kt`. Add `app/src/test/kotlin/app/markiro/handheld/core/grants/{GrantVerifierTest,GrantAdmissionTest,GrantMigrationTest,GrantRecoveryTest}.kt`.

**Interfaces:** Kotlin DTOs mirror Task 1 names/types, with time/epoch/count represented as `Long` and validated within JS safe-integer range. `GrantVerifier.verify(compact: String, ownerOrigin: String): VerifiedGrantResult`; `GrantRepository.install(envelope: GrantEnvelope)` runs under `db.recovery.commit`; `GrantAdmission.assessNewWork(intent: GrantIntent, now: Long?): LocalDecision` and `assessCompletion(intent: GrantIntent, now: Long?, consumed: Map<String,Long>): LocalDecision` consume persisted verified grants and current owner inside the same Room transaction.

- [x] Add fixture loop test reading `offline-grants-v1.json`; require identical accept/reject results to TS, including leading high-bit R/S, all-zero malformed signature and original payload whitespace. Add Room upgrade preserving pending scans/inventory batches/product labels, concurrent final budget unit, stale network response after generation changes and consumed allowance surviving renewal.
- [x] Use JDK 17 (`JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home`) and Android SDK (`ANDROID_HOME=/Users/thevladbog/Library/Android/sdk`) as process-local environment settings; do not overwrite existing local.properties. Run from `apps/handheld`: `./gradlew --no-daemon testDebugUnitTest --tests '*GrantVerifierTest' --tests '*GrantAdmissionTest' --tests '*GrantMigrationTest' --tests '*GrantRecoveryTest'`; expect failing classes/behavior.
- [x] Implement fixed `SHA256withECDSA` on P-256. Convert each unsigned 32-byte R/S into minimal positive ASN.1 INTEGER (strip redundant zeroes, prefix 0 when high bit set), then encode DER SEQUENCE for Android Signature provider; reject non-64-byte JWS signature. Verify exact original ASCII signing input. Do not let incoming `alg` select provider algorithm.
- [x] Add forward Room migration and entities/DAO. Inside existing `db.recovery.commit`, read owner/lease, replay existing event, check clock/identity/budget, charge and save sequence/event/outbox atomically. Inventory's nested recovery commits and mutex keep their existing ownership semantics; don't move crypto/network suspension into the transaction. Integrate all existing native productive scan, box, pallet and duplicate-label owners through the same transaction API, with deny-by-default for unmapped productive events in strict mode.
- [x] Use `SystemClock.elapsedRealtime()` plus boot identity and saved high-water; process recreation preserves boot-relative trust; reboot/rollback invalidates until sync. Persist nothing from a network response whose credential generation changed before commit. Keep UI/recovery navigation and previously recorded evidence reachable.
- [x] Run focused tests green, then `./gradlew --no-daemon testDebugUnitTest lintDebug assembleDebug`. Review the scoped diff and leave it uncommitted.

## Task 7: Kiosk IndexedDB admission and reservation-preserving completion

**Files:** Create kiosk `src/grants/{store,admission,transport,clock}.ts`; modify `src/store/{db,queue,installation-binding}.ts`, `src/session/flow.ts`, `src/sync/worker.ts`, `src/api/{client,types}.ts` where native client methods live; create `apps/kiosk/test/offline-grants-{store,admission,recovery}.test.ts`.

**Interfaces:** `installKioskGrant(envelope: GrantEnvelope): Promise<void>` verifies Task 2 signatures before opening IDB; `enqueueGrantedOrder(input: {body: CreateOrderDto;employeeId:string;intent:GrantIntent}): Promise<void>` writes queue, reservation binding, charge and high-water using `withTransaction`. Read mode only from authenticated persisted rollout configuration, never an enqueue parameter/UI override. Recompute intent cost from the validated order/reservation; caller cost is not authoritative. Consume Task 4 negotiated endpoints independently of existing order attestation.

- [x] Test two browser contexts charging the last allowable reservation/line; restart between reservation nonce persistence and submit; dequeue racing late grant/attestation update; renewal without budget reset; changed order lines with old task grant; old queued orders lacking grant fields surviving migration and sync.
- [x] Run `pnpm --filter @markiro/kiosk exec vitest run test/offline-grants-store.test.ts test/offline-grants-admission.test.ts test/offline-grants-recovery.test.ts` red.
- [x] Add IDB version/store migration preserving all old records. Do not await network/WebCrypto inside `withTransaction` callbacks (they must remain synchronous). Recheck installation owner, current epoch, verified-token identity and clock in transaction. Serialize updates across overlapping stores and never reinsert a queue record deleted by acknowledgement.
- [x] New cart/order creation uses device admission and current operator policy; completion uses already frozen reservation/order canonical digest, line set, quantities and same `deviceSeq`. A grant is not a replacement for the existing opaque server admission token. Queue evidence with saved grant decision; keep existing attest → persist → submit retry flow. Absent frozen online reservation cannot be invented locally under completion permission.
- [x] Browser boot identity cannot reliably distinguish reboot from reload. Scope `performance.now()` anchor to current process session; after recreation remain `clock_untrusted` for strict production until authenticated sync. Observation/legacy operation and all recovery remain available; never extend a deadline with local Date.now alone.
- [x] Run focused tests green and kiosk package test/typecheck/lint/build after dependency build. Review the scoped diff and leave it uncommitted.

## Task 8: Recovery evidence classification independent of admission

**Files:** Create API `src/modules/device-grants/grant-evidence.service.ts`, `apps/api/test/device-grants-evidence.test.ts`; modify the three evidence owners in map and native negotiated transport adapters; extend new `packages/platform-contracts/src/offline-grants.ts` only. Add Station `test/offline-grants-evidence.test.ts`, Handheld `core/grants/GrantEvidenceTest.kt`, kiosk `test/offline-grants-evidence.test.ts`.

**Interfaces:** Export `interface GrantEvidenceEnvelope { protocol:"offline-grants-v1"; batchId:string; payloadDigest:string; grants:string[]; eventGrants:Record<string,string>; payload:unknown }` from contracts. This envelope wraps the original batch without changing its bytes/identity and is validated by the matching existing batch schema. `GrantEvidenceService.classify(owner: GrantOwner, envelope: GrantEvidenceEnvelope): Promise<{batchId:string;outcome:"accepted"|"duplicate"|"quarantined";reason:string|null}>`. The service accepts only an already authenticated recovery owner and never authenticates using the grant itself. Unknown payload data must be parsed before reaching business DB queries.

- [x] Test expired subscription/grant with valid current recovery auth retains batch; old epoch signed evidence after explicitly authorized same-device credential recovery is retained with historical provenance; revoked credential alone is 401/403. Assert duplicate repeats preserve one raw envelope/receipt, altered payload under same batchId conflicts, wrong tenant/device never exposes or modifies other tenant facts, over-budget/late events quarantine instead of disappearing.
- [x] Run focused API/client evidence tests red.
- [x] Add dedicated negotiated evidence routes under station/kiosk grant v1 with existing recovery access-policy decorators and existing credential-kind guards. Persist raw envelope digest and original batch plus exact provenance/disposition durably before reconciliation. Keep malformed transport rejection separate from disputed but parseable evidence quarantine. For legacy clients invoke unchanged recovery ingestion and retain old response shape.
- [x] A device timestamp alone is never chronology proof. Evidence received after completeNotAfter is quarantined unless independent existing server-owned evidence proves timely authorization of the exact effect. Grant signature proves issued scope, not when a device acted; do not retroactively bless evidence on renewal. Test both receipt within completion window and late receipt without proof.
- [x] Observation preserves existing productive sync outcomes. Missing or expired grants become stored would-deny diagnostics, not a new quarantine reason for otherwise valid observe-mode work. Strict grant classification is selected from server-owned rollout provenance, never an incoming mode flag. Test observe/no-policy compatibility separately from strict disputed-evidence quarantine.
- [x] Reconciliation distinguishes retention from accepted production: missing/invalid grant, timing/epoch/snapshot disputes are stored with reason and do not silently become legitimate production. Accepted historical frozen events can reconcile without needing today's productive entitlement. Atomic receipts/idempotency prevent re-creating domain events after ambiguous response. Existing conflict/quarantine recovery remains visible and does not lose print state.
- [x] Tests assert exact tenant, original device/epoch, recovered auth actor, batchId, classification, audit action/target/result, event count and retained bytes. Run API route inventory and native focused evidence tests green. Review the scoped diff and leave it uncommitted.

## Task 9: Observation UX, CI ownership and full workflow acceptance

**Files:** Modify Station `src/i18n/{ru,en}.json`, kiosk `src/i18n/{ru,en}.json`, Handheld `app/src/main/res/{values,values-en}/strings.xml`; integrate status into existing task/blocked/recovery screens without new commercial displays. Add `apps/api/test/public-api-offline-grants-workflow.test.ts`, `docs/acceptance/offline-device-grants.md`, `docs/operations/offline-device-grants.md`; modify `tools/ci/affected.mjs`, `.github/workflows/ci.yml` and architecture docs.

**Interfaces:** Render local decision reasons, never subscription price/contract dates: Russian `Новая работа недоступна. Подключите устройство для обновления допуска.` and `Требуется проверка времени устройства.`; English `New work is unavailable. Connect the device to refresh access.` and `Device time needs verification.` Recovery action remains visible. Observe-mode decision is diagnostic and must not present a false blocked production state.

- [x] Write workflow regression using companion P1B.3b public API: create → import exact bytes → select snapshot → start; device issues/fetches grant, goes offline, reaches new-work deadline, completes finite task allowance, rejects extra unit, reconnects and reconciles one duplicate batch. Assert API key actor survives, native requests do not require publicApi, renewal does not duplicate output and evidence remains after downgrade. Without companion API readiness, run the same server frozen-task fixture but report public workflow acceptance incomplete.
- [x] Add renderer tests for strict denied and observation diagnostic, both locales, recovery navigation. Test no-policy server + new/old native clients preserves current behavior and cannot activate strict from a client-supplied flag. Add CI fixture ownership so shared protocol changes actually run Android, domain, contracts and all native jobs.
- [x] Implement local rollout gate as default observe; strict is enabled only by server-authorized configuration with approved policy and exact supported capability. Add no production allowlist/flag/default durations. Document compatibility rollback: disable strict admission while preserving new stores, receipts and signed history; old code must not write unsupported store versions. Document key rotation pre-distribution and separate security retirement procedure.
- [x] Run all changed packages' focused and standard gates (test, typecheck, lint, build); rebuild shared dependencies before consumers. For broad final change load isolated test env and run `pnpm turbo lint typecheck test build --concurrency=1 --force`, then Android `./gradlew --no-daemon testDebugUnitTest lintDebug assembleDebug`, Station Cargo tests, route/OpenAPI checks, `pnpm test:production-bundle:contract` if env/deploy contracts changed, `pnpm format:check` and `git diff --check`. Record infrastructure skips as incomplete coverage, never passing DB proof.
- [x] Exercise browser Station/kiosk offline/restart/clock warning/recovery screens at intended viewport; run Android emulator process/reboot scenarios. Record actual Windows printer/scanner, vendor handheld and physical print acceptance separately in the acceptance document. A build, Cargo host test, browser mock or debug APK does not prove those surfaces. Production strict rollout, actual policy durations and hardware pilot remain separately approved P1D gates.
- [x] Self-review spec coverage: both grant kinds, three native clients, signed TS/Kotlin fixtures, bounded frozen identity, clock distrust, epoch+local lease, atomically consumed limits, recovery classification, no commercial blocks, unchanged shadow and explicit strict activation. Review the scoped diff and leave it uncommitted.

## Review and handoff gates

Each task is a separately reviewable delivery. Server-only completion does not complete P1C. Shared contract/epoch work can land independently of public API execution; final cross-surface workflow requires the companion API implementation. Engineering may implement strict behavior for tests, but neither this plan nor its completion authorizes production activation or chooses production durations.

No unresolved product choice is needed to implement observation and the strict-ready mechanisms: missing approved duration/bounds deliberately denies issuance only; old work remains unchanged. Actual approved policy records, rollout cohort and hardware acceptance are external P1D inputs. If existing task data has no finite bounds, report `bounds_required` and retain observation instead of silently deriving an unlimited grant or inventing a business cap.
