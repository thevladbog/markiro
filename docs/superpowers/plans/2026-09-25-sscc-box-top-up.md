# Proactive box SSCC top-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep Station and handheld closing boxes during an active shift by obtaining the next box SSCC range before their current range runs out.

**Architecture:** Add one device-authenticated, tenant-scoped shift endpoint that decides whether to reserve the next box block using server consumption. Both clients perform an independent low-water background check and durably apply the returned blocks to their existing SSCC pools. Do not alter scan-batch identity or closure semantics.

**Tech Stack:** NestJS/Drizzle/Postgres, React/Tauri/SQLite, Kotlin/Retrofit/Room/coroutines, Vitest, JUnit.

**Spec:** `docs/superpowers/specs/2026-09-25-sscc-box-top-up-design.md`

## Global Constraints

- Base: `origin/main` at `7ae07b9a3d4d1ad1ad992b9f4201a9975a223f17`; implementation worktree is isolated from the user's unrelated checkout. Before coding, check its status and re-read the scoped API, Station, and handheld guides.
- Keep the change box-only (`extensionDigit = 0`), preserve 2,000 block size and all existing physical-label/SSCC rules. No schema migration is expected. Never reset a local cursor or trust a client-supplied consumption count.
- The route is additive; deploy API before either client. 404 from an old API is a non-spinning compatibility case. Network failures leave the existing local pool usable.
- Each implementation task starts with a focused failing test, then the smallest code change, then the focused green test. Do not commit, push, open a PR, deploy, or clean the worktree without separate user authorization.
- The newly created worktree has no `node_modules`. Install via the declared Corepack/pnpm toolchain if the package store permits; do not link another checkout's mutable `node_modules` or `dist`, modify `.env`, or bypass the lockfile policy.

## Review Focus

1. Does a top-up racing with itself or `GET /shifts/:id/bundle` reserve only one ahead block? The lock must precede the latest-block read and follow the device-fence/shift-lock order.
2. Are tenant, station-device, shift participant, active aggregation state, replacement fence, and recovery subscription checked before any grant?
3. Are original bounds, server cursor, all live blocks, and revocations returned and applied without replaying a printed serial, including a reseed that reuses `fromSerial`?
4. Do late responses after shift/credential/recovery changes write nothing on either client? Does a failed/404 request leave scanning and existing ranges intact?
5. Are Station and handheld tested against the same response shape, with no pallet allocation and no scan-batch digest change?

---

## Task 1: Freeze the route contract and denial policy in tests

**Files:**

- Create: `apps/api/test/sscc-box-top-up.e2e.test.ts`
- Modify: `apps/api/test/subscription-route-inventory.test.ts`
- Modify: `apps/api/test/entitlement-operation-inventory.test.ts` only if its route inventory requires the new method
- Modify: `apps/api/src/modules/shifts/dto.ts`
- Modify: `apps/api/src/modules/shifts/shifts.controller.ts`

**Interfaces:** Produces `BoxSsccTopUpDto` and `ShiftsService.topUpBoxSscc(tenantId: string, shiftId: string, deviceId: string): Promise<BoxSsccTopUpDto>`. The route returns this DTO for a station-device credential; no body is accepted. Task 2 completes the service's allocation behavior.

- [ ] **Step 1: Write the failing tests.** Reuse isolated tenant/device/shift setup from `shifts-bundle.e2e.test.ts`. Assert the participant response's exact three keys, no box-block-count increase for cabinet/non-participant/cross-tenant calls, and the route metadata:

```ts
expect(Object.keys(response.body).sort()).toEqual(["blocks", "issuerProblem", "revokedFrom"]);
expect(
  response.body.blocks.every((block: { extensionDigit: number }) => block.extensionDigit === 0),
).toBe(true);
expect(blockCountAfterDeniedRequest).toBe(blockCountBeforeDeniedRequest);
```

- [ ] **Step 2: Run red.** `corepack pnpm --filter @markiro/api exec vitest run test/sscc-box-top-up.e2e.test.ts test/subscription-route-inventory.test.ts` must fail because the route is missing. Add a failing metadata assertion for station-only auth and explicit `@AllowSubscriptionRecovery("shift")`; read-only recovery must later match `bundleSscc`'s opened-before-expiry rule.
- [ ] Define `BoxSsccTopUpDto` in `shifts/dto.ts` and a matching OpenAPI schema, reusing the non-null block field shape from `ssccBundleOpenApiSchema` instead of copying a subtly different one:

```ts
interface BoxSsccTopUpDto {
  blocks: NonNullable<ShiftBundleDto["sscc"]>[];
  revokedFrom: number[];
  issuerProblem: "org_gln_missing" | "issuer_gln_missing" | null;
}
```

`blocks: []` means no usable grant; `issuerProblem` distinguishes missing issuer from exhausted/denied allocation. The endpoint takes no request body. The DTO must always serialize all three fields.

- [ ] **Step 3: Add the route and the minimum secured service method.** Use `@Post(":id/sscc/top-up")`, `@UseGuards(StationOnlyGuard)`, `@AllowSubscriptionRecovery("shift")`, `@ApiStationAuth()`, `@ApiParam({ name: "id", format: "uuid" })`, and `@ApiOkResponse({ schema: boxSsccTopUpOpenApiSchema })`; pass only `req.tenantId!`, `id`, and `req.deviceId!` to the service. The service must tenant-check the shift, participant, status/mode and replacement fence before returning even an empty result. Task 2 adds allocation to the same method; never expose a route that skips those checks.
- [ ] **Step 4: Run green and inspect.** Run the command below; this task's route-auth/shape tests must pass. Run `git diff --check` and review only its listed paths before Task 2.

**Command:** `corepack pnpm --filter @markiro/api exec vitest run test/sscc-box-top-up.e2e.test.ts test/subscription-route-inventory.test.ts test/entitlement-operation-inventory.test.ts`

## Task 2: Serialize and implement server-side preallocation

**Files:**

- Modify: `apps/api/src/modules/sscc/sscc.service.ts`
- Modify: `apps/api/src/modules/shifts/shifts.service.ts`
- Extend: `apps/api/test/sscc-box-top-up.e2e.test.ts`

**Interfaces:** Consumes `BoxSsccTopUpDto` and the secured `topUpBoxSscc` method from Task 1. Produces a response where `blocks` is ascending by `allocationOrder`, has only live box blocks for the authenticated device/prefix, and carries original bounds plus `consumedThroughSerial`.

- [ ] **Step 1: Write failing allocation tests.** 401 is auth, missing/cross-tenant shift is 404, and a foreign station participant is 403. Cover threshold 401 versus 400, zero/fully consumed, first-block partial capacity, global exhaustion, repeat/parallel POST, POST racing bundle GET, distinct devices/prefixes, and pallet count unchanged. Representative assertions:

```ts
expect(at401.body.blocks).toHaveLength(1);
expect(at400.body.blocks).toHaveLength(2);
expect(repeated.body.blocks).toEqual(at400.body.blocks);
expect(new Set(allGrantedSerials).size).toBe(allGrantedSerials.length);
expect(palletBlockCountAfter).toBe(palletBlockCountBefore);
```

- [ ] **Step 2: Run red.** `corepack pnpm --filter @markiro/api exec vitest run test/sscc-box-top-up.e2e.test.ts` must fail on the 400/new-block assertion; inspect whether DB-required cases ran or were skipped.
- [ ] **Step 3: Implement the shared allocation gate.** Both bundle and top-up follow: `assertDeviceReplacementNewWorkAllowed` → shift row `FOR UPDATE` → active/mode/subscription checks → issuer resolution → lock `(tenant, device, issuerPrefix, 0)` → latest-block decision. The top-up also checks `shiftDeviceParticipants` for `(tenantId, shiftId, deviceId)` inside this transaction. A transaction-scoped advisory lock or dedicated row lock is valid only if both paths use it, before the latest-block SELECT. No route argument may select the device or issuer.
- [ ] **Step 4: Implement the low-water decision and response.** Use the equivalent of the following branch after locking; `allocate` is the existing atomic counter allocator:

```ts
const serverRemaining = latest
  ? latest.toSerial - (latest.consumedThroughSerial ?? latest.fromSerial - 1)
  : 0;
const shouldAllocate = !latest || (latest.consumedThroughSerial !== null && serverRemaining <= 400);
if (shouldAllocate) await this.allocate(tenantId, issuerPrefix, 0, deviceId, 2000, tx);
```

Then select all live blocks in ascending allocation order and `revokedFromSerials` in that same transaction. Catch only issuer `BadRequestException` and `SsccCapacityExhaustedException` as no-new-range states while preserving already-held blocks; propagate storage failures. Original bounds/cursor must survive the mapping. Do not touch pallets or scan-batch DTO/digest.

- [ ] **Step 5: Run green.** Run the commands below; verify no DB-required case silently skipped. Review the diff of the two service files and the endpoint test.

**Commands:**

```bash
corepack pnpm turbo run build --filter='@markiro/api^...'
corepack pnpm --filter @markiro/api exec vitest run test/sscc-box-top-up.e2e.test.ts test/shifts-bundle.e2e.test.ts test/sscc.e2e.test.ts
```

## Task 3: Station background check and durable apply

**Files:**

- Create: `apps/station/src/lib/box-serial-top-up.ts`
- Create: `apps/station/test/box-serial-top-up.test.ts`
- Modify: `apps/station/src/App.tsx`
- Modify: `apps/station/src/pages/WorkScreen.tsx`
- Modify: `apps/station/test/App.test.tsx` and/or `apps/station/test/WorkScreen.test.tsx` for the actual integration seam

**Interfaces:** Consumes `POST /shifts/:id/sscc/top-up` returning `{ blocks, revokedFrom, issuerProblem }`. Produces `createBoxSerialTopUp({ client, exec, isCurrent, generation, shiftId, issuerPrefix })` with `nudge(): void` and `stop(): void`; `WorkScreen` receives optional `onBoxClosed?: () => void`.

- [ ] **Step 1: Write failing tests.** Use the `node:sqlite` executor pattern from `sscc-pool.test.ts`. At 401, `nudge()` makes no POST; at 400/zero, concurrent nudges produce one POST. On temporary failure, retry only after bounded backoff; on 404, no further POST until a new entry. A late response after shift/credential/recovery change makes zero writes. Representative test assertion:

```ts
expect(post).toHaveBeenCalledTimes(1);
expect(await remaining(exec, activeIssuerPrefix, 0)).toBe(remainingBefore + 2000);
expect(await burnSerial(exec, activeIssuerPrefix, 0)).toBe(oldRangeNextSerial);
```

Also test coordinator recreation/restart with the same SQLite file, zero-pool open-box preservation, and outbox-empty entry checking.

- [ ] **Step 2: Run red.** `corepack pnpm --filter @markiro/station exec vitest run test/box-serial-top-up.test.ts` must fail because the coordinator does not exist.
- [ ] **Step 3: Implement the coordinator.** Validate the exact response shape and integer/bounds/digit/prefix values before a write. Use `remaining(exec, issuerPrefix, 0) <= 400`, a single in-flight promise, and a bounded retry timer. Under `credentialGenerationIsCurrent(generation) && isCurrent()`, exclude _every_ returned live `fromSerial` from revocations, then call `dropRanges` before `addRange` for each block. `StationApiError.status === 404` suspends requests for this controller instance. Never mutate the shift mirror or pallet pool.
- [ ] **Step 4: Wire entry and closure.** Create/replace the controller when `App.tsx` has an active shift context; call `nudge()` on entry and through `WorkScreen.onBoxClosed` after `result.status === "closed"`. Call `stop()` on pause, exit, shift change, credential replacement and sealing. The callback must not be awaited by close/print. A late grant must not retry a failed close, auto-print, or dismiss the no-serials overlay.
- [ ] **Step 5: Run green.** Run the focused commands below; inspect the worktree diff of the listed Station files.

**Commands:**

```bash
corepack pnpm turbo run build --filter='@markiro/station^...'
corepack pnpm --filter @markiro/station exec vitest run test/box-serial-top-up.test.ts test/sscc-pool.test.ts test/shift-bundle.test.ts test/close-box.test.ts test/App.test.tsx
```

## Task 4: Handheld background check and Room apply

**Files:**

- Modify: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/network/StationApi.kt`
- Modify: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/network/ShiftDtos.kt`
- Create: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/feature/shift/BoxSerialTopUp.kt`
- Modify: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/feature/work/WorkViewModel.kt`
- Modify: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/pallets/SsccBlockApplier.kt` only if needed to apply a list safely
- Create: `apps/handheld/app/src/test/kotlin/app/markiro/handheld/feature/shift/BoxSerialTopUpTest.kt`
- Extend: `apps/handheld/app/src/test/kotlin/app/markiro/handheld/feature/work/WorkViewModelTest.kt`

**Interfaces:** Consumes the same top-up JSON as Task 3. Produces a `@Serializable data class BoxSsccTopUpDto(val blocks: List<BundleSsccDto>, val revokedFrom: List<Long>, val issuerProblem: String?)` and a `BoxSerialTopUp` coordinator with `nudge()` and lifecycle cancellation owned by `WorkViewModel`.

- [ ] **Step 1: Write failing tests.** In `BoxSerialTopUpTest.kt`, decode exact JSON, assert 401 makes no API call, 400/zero make one, concurrent nudges single-flight, 404 does not spin, network retry is bounded, and stale generation/shift change makes no Room write. With `SsccPoolTest` fixtures, assert revocation-before-grant, old-range-first burn, offline restart, interrupted apply recovery, and no pallet mutation. Extend `WorkViewModelTest` for entry and post-close nudges.
- [ ] **Step 2: Run red.** From `apps/handheld`, run `./gradlew :app:testDebugUnitTest --tests '*BoxSerialTopUpTest'`; it must fail because the class is missing.
- [ ] **Step 3: Add the network contract and coordinator.** Add this Retrofit method and DTO to the named files:

```kotlin
@POST("shifts/{id}/sscc/top-up")
suspend fun topUpBoxSscc(@Path("id") id: String): BoxSsccTopUpDto

@Serializable
data class BoxSsccTopUpDto(
    val blocks: List<BundleSsccDto>,
    val revokedFrom: List<Long>,
    val issuerProblem: String?,
)
```

In `BoxSerialTopUp`, use `SsccPool.remaining(issuerPrefix, 0) <= 400`, validate block bounds/digit/issuer, filter all live block starts from revocations, and call the existing `dropRanges` then `addRange` inside the recovery generation ownership boundary and durable commit. No serial-burning algorithm, box close, or print is added to this callback.

- [ ] **Step 4: Wire lifecycle.** Start at active-work entry in `WorkViewModel`, nudge after `CloseResult.Closed` next to `sync.nudge()`, and use a child coroutine job with bounded retry. Cancel on leave/ViewModel clear and prevent writes if credential generation or active shift changed. Failure never blocks `closeAndPrint`, pause, or exit; 404 leaves bundle/re-entry recovery intact.
- [ ] **Step 5: Run green.** Run the targeted and Android gates below; ensure the JSON fixture agrees with the Station response and inspect the Kotlin diff.

**Commands:**

```bash
cd apps/handheld
./gradlew :app:testDebugUnitTest --tests '*BoxSerialTopUpTest' --tests '*WorkViewModelTest' --tests '*SsccPoolTest'
./gradlew :app:testDebugUnitTest :app:lintDebug :app:assembleDebug
```

## Task 5: Cross-surface regression, rollout and final diff review

**Files:**

- Extend: `apps/api/test/sscc-box-top-up.e2e.test.ts` if a cross-device case is missing
- Update: `docs/superpowers/specs/2026-09-25-sscc-box-top-up-design.md` status only after implementation is verified
- Do not edit generated output or migration files unless a test proves it necessary

- [ ] Run API, Station and handheld focused tests together against the finalized response fixture. Confirm two devices receive disjoint serial ranges, repeat requests are idempotent, `GET bundle` remains compatible, and existing scan-batch payload/digest tests are unchanged.
- [ ] Run `git diff --check`, inspect the complete diff against the verified base, and check no unrelated checkout files or generated `dist`/`node_modules` are included. Run `graphify update .` only if this worktree has a local graph.
- [ ] Run API and Station package `test`, `typecheck`, `lint`, `build`; Android `testDebugUnitTest`, `lintDebug`, `assembleDebug`. For broader cross-package changes run `corepack pnpm turbo lint typecheck test build --concurrency=1 --force` and `corepack pnpm format:check` if local infrastructure is available. Document any DB-backed skips instead of treating them as passes.
- [ ] Report separately: code/test proof, browser/UI proof, Android emulator proof, actual TSD/scanner proof, Station printer/hardware proof, and production rollout proof. Do not say this is factory-verified merely because automated gates pass. Production API publication must precede Station/handheld client publication, but deployment is a separate user-authorized step.
