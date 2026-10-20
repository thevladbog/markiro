# Multi-station shift: handheld (ТСД) implementation plan (milestone 2b, part 5 of 5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the Android handheld (`apps/handheld`, host mode) work one shift of one line together with
stations and other handhelds on the host of «Markiro Автоном»: join an open shift while the line has a free
slot (and say so when it has none), show «Моя смена: N · Всего в смене: K из M» with a stale mark offline,
leave a shared shift as a pause that frees the slot, and close only its own part with the reason asked from
the last closer only.

**Architecture:** The handheld stays a protocol-6 client and adds one capability name, `multi-station-v1`,
to its entry into a shift (the host's contract, `docs/superpowers/plans/2026-10-20-multi-station-host.md`
«Host contract for the other plans»). Everything the host now says about a shared shift (`maxStations`,
`participants`, `myState`, `totals`, `byDevice`) is decoded by `HostDtos.kt`, reduced to one small JSON
snapshot per shift in the existing `meta` table (`ShiftParticipationStore`; no Room migration, version
stays 22), and refreshed by the host heartbeat while a shift is worked. Pure rules in `SharedShiftRules`
(shift-wide total, strip model, reason need) are pinned by the host's own fixture
`shift-close-reason-shared.json`. The enter, leave and close flows of the existing shift feature read the
snapshot; the cloud path, sign-in, grants, scanning and warehouse pallets are not touched.

**Tech Stack:** Kotlin, Jetpack Compose, Room 2.x (no schema change), kotlinx.serialization, Hilt, JUnit 4,
Robolectric, Compose UI tests, shared JSON fixtures from `apps/standalone/proto/fixtures`.

**Spec:** `docs/superpowers/specs/2026-10-20-standalone-multi-station-shift-design.md` §6 (handheld), §4 (what
the host sends), §12.7. Sibling plans: host (`…-multi-station-host.md`, released first), station, office,
load/soak.

**Commands.** `$WT` is the absolute path of the executor's worktree (`/tmp/claude/wt/<NAME>`). Never `cd`.
Gradle runs as `"$WT/apps/handheld/gradlew" -p "$WT/apps/handheld" --no-daemon …` (shortened below to
`GRADLE …`). A focused run is `GRADLE :app:testDebugUnitTest --tests "<fully.qualified.Class>"`. The Android
SDK path lives in the ignored `local.properties`; never commit it. Robolectric tests run under `ru-RU`.

## Global Constraints

From the spec (owner decisions of 2026-10-20, §1, §4, §6, §12.7):

- A handheld is a full participant, equal to a station; one product, each device has its own boxes and pallets.
- Entry is free while the line's limit (`maxStations`) has a free slot; a full line is `409 shift_line_full`; an old host says `shift_busy` and the handheld shows the same «занято» as before, in words.
- Counter: «Моя смена: N · Всего в смене: K из M»; the plan is reached by the shift-wide total; offline the last known figure with «данные на ЧЧ:ММ».
- Leave stays a pause (`left`) and frees the slot; the shift is closed per part: every participant closes its own part, the shift closes with the last one; the reason for an unmet plan is asked from the last closer only; an offline device closes without one.
- The handheld's warehouse pallet events (`pallet-events`, no shift) do not change.

From `apps/handheld/AGENTS.md` and the root `AGENTS.md`:

- Android is verified only by `./gradlew --no-daemon testDebugUnitTest lintDebug assembleDebug` from `apps/handheld`; a green pnpm/Turbo run proves nothing here. Emulator/Robolectric tests do not prove vendor scanner support or production-device acceptance.
- Host DTOs and shared wire fixtures are read from `apps/standalone/proto/fixtures` (test resources); never hand-edit expected values to conceal a parity failure. A rule that the host, the webview and this app share is a fixture read by all three.
- The KM parsing, inventory classification and batch digest fixtures (`fixtures:km`, `fixtures:inventory`, `fixtures:product-labels`) are not affected and are not regenerated.
- Handheld uses station-device authentication with kind `handheld`; do not infer permission because a station route exists. The new `leave` route is listed for handhelds by the host contract (`station`, `handheld`).
- Accepted scans, outbox events, device sequence and receipts are durable facts: retries resend the same frozen bytes; only receipts remove `host_outbox` rows. This plan adds no new fact kind and no new receipt code (the pinned list stays 23 codes).
- Android persistence lives under `core/storage/`; a Room migration is numbered after the current version (22 today: `MIGRATION_21_22`). This plan adds none (D2); if an executor finds it needs one, it is `MIGRATION_22_23` and every migration test list changes with it.
- Host mode: HTTPS only, pinned fingerprint, no proxy, no redirects; never add cleartext or debug-HTTP; never log keys, codes, claim bodies or fingerprints. The new calls go through `HostApi`/`HostTransport`/`HostCalls` like every other.
- Preserve restart/resume and offline behaviour: disconnect, reconnect, process recreation and leave with pending work must keep working (Tasks 7, 9, 11 test them).
- Ship Russian and English strings together (`res/values/strings.xml`, `res/values-en/strings.xml`); lint treats a missing translation as an error; `EnglishRenderTest` asserts no Cyrillic leaks under `en`.
- The sign-in feature (`feature/signin`) and the offline operator roster are not touched; the recent handheld-login rules (PIN/badge verified against the synced roster, host key never shown) stay as they are.
- Keep debug controls debug-only; do not loosen the release configuration.
- Commits are scoped, stage explicit paths and end with exactly one trailer line `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- TDD: a failing test first, then the code; never weaken an existing assertion; a pre-existing test changed because a product decision changed is named in the report (here: one assertion of `HostApiTest`, Task 3).

---

## Decisions taken by this plan (with reasons)

- **D1. The handheld stays at protocol 6; the capability is the whole wire change.** The host plan (Task 14)
  moves the host to protocol 7 and writes «no Kotlin change», but its own contract says a handheld must name
  `multi-station-v1` on every entry to be allowed in as a second participant: that is the Kotlin change. The
  protocol constant is a different matter. `HostCompat.PROTOCOL` is sent as `x-markiro-protocol` and decides
  `host_too_old`; raising it to 7 would make a protocol-7 handheld refuse a host of 6, for no gain: against a
  host of 6 the capability is an unknown name the host ignores (`validate::shift_supports` only checks length),
  that host never admits a second device, every shift has one participant, and `shift_closed` closes that one
  part which is the whole shift. Against a host of 7 a protocol-6 handheld is `compatible`
  (`compatibility.json`: client 6 / host 7 / min 1). So `HostCompat.PROTOCOL` stays 6 and
  `HostFixturesTest` keeps pinning it; the client-7 rows of the extended `compatibility.json` are evaluated by
  the same pure `decide`, unchanged.
- **D2. Participation is one JSON value per shift in `meta`, not a Room table.** `meta` is already classified
  as business data in `HOST_DATASET_BUSINESS_TABLES` (a dataset reset clears it), has `observe(key)` and
  `withPrefix`, and needs no migration, so Room stays at version 22 and none of the ten migration test lists
  changes. The value is derived from the host's last answer and never a source of truth: losing it only
  costs a refresh. Keys: `shift_participation:<shiftId>`, `shift_leave_pending:<shiftId>`,
  `shift_close_note:<shiftId>`.
- **D3. The strip appears only when the line allows more than one device** (`maxStations >= 2`) or the host
  already lists two participants. With `maxStations = 1` the work screen is byte-for-byte the screen of today
  (spec: «при max_stations = 1 клиенты не видят изменений»).
- **D4. Shift-wide total = what the host counted from the others + this device's own count.** The host's
  `byDevice` row of this device lags the device's unsent scans, so the total is
  `totals.accepted − byDevice[me].accepted + localAccepted`, never below the local count. The plan-reached
  prompt of `WorkViewModel` (a crossing of `total` over `plan`) then judges the shift-wide total without
  another line of code.
- **D5. Totals are polled, not pushed.** A scan takes no host revision (host D11), so the host heartbeat
  (every 15 s, `SyncEngine.HEARTBEAT_MS`) reads `GET /v1/device/shifts` while a shift is the device's active
  one. A beat that does not reach the host marks the stored figures `stale`; the strip then shows
  «данные на ЧЧ:ММ» (the host's `asOf`). The existing `WorkUi.reachable` is deliberately not used: it reads the
  cloud reachability tracker, which never moves on a host device (a pre-existing gap, listed in the report).
- **D6. A closed part is a closed shift for this device.** The host reads a closed participant back with
  `myState: "closed"` (host D2). `toShiftDto` maps that to `status = "closed"`, so the list, the hub card and
  the scan gate (`handleScan` ignores a closed shift) follow with no new branch; an `enter` that comes back
  closed is `EnterResult.PartClosed`, shown as «Ваша часть закрыта» and never downloads a bundle (this is how
  a device that lost its database is stopped from working a part it already closed).
- **D7. The reason rule is the host's rule as a client can know it** (`SharedShiftRules.reasonRequired`,
  pinned by `shift-close-reason-shared.json`): a device that is alone in the shift (host `participantsEver ≤ 1`,
  or an older host, or no snapshot) keeps stage 2a's rule and its hard refusal; in a shared shift the reason
  is asked only when the figures are fresh, no other participant is still `active` or `left`, and the plan
  differs from the shift-wide total. A stale snapshot or a device that cannot reach the host closes
  **without** a reason (spec §12.9); the host then closes the shift with `reasonMissing` and the office supplies
  the code. `ShiftCloser.close` therefore never throws for a shared shift, and a participant count that grew
  after the snapshot can only make a reason that was given unnecessary, never make a close fail.
- **D8. Leave is a local mark first and a best-effort host call second.** The operator sees the leave at
  once (as today). The host call (`POST /v1/device/shifts/{id}/leave`, host D5, online-only) frees the slot; when
  it cannot be made, `shift_leave_pending:<id>` is written in the same commit as the local mark, and the
  heartbeat sends it later only while the local row is still `leftAt != null`: a re-entry (online or offline)
  cancels it, so a late leave never undoes a re-entry (host D5 asks the same of the station). A residual
  race of one in-flight request is listed in the report.
- **D9. «Занято» in words for the old host (spec §12.7).** Today a `shift_busy` conflict travels
  `HostApi → HostFailure.Constraint → HostCalls (HttpException 409 {"code":"shift_busy"}) → ShiftRepository.refusal`
  and ends as `EnterResult.Refused(ENTER, 409, "shift_busy")`, which `ShiftDialogScreen` renders as the generic
  «Сервер отказал · вход в смену · HTTP 409 · shift_busy … Покажите эту строку администратору» (no dedicated text).
  This plan gives it its own `EnterResult.Busy` / `ShiftDialog.Busy` («Смена занята»). The handheld is already
  a participant like any device for the close rule: the host counts it by `shift_participants` and closes
  its part on the `shift_closed` fact.
- **D10. Receipts of a close are read, not new.** `accepted {partClosed:true}` and `accepted {reasonMissing:true}`
  (host D8) are noted in `meta` by `HostAckMapper` (the source row still leaves the queue on `accepted`); the
  close summary reads the note once the queue is drained. No new column, no new receipt code.
- **D11. The handheld names `["handheld-host-v1","validation-v1","multi-station-v1"]`.** The host contract's
  fixture `shift-enter-handheld-multi.json` lists `["handheld-host-v1","multi-station-v1"]`; the host checks that
  what a shift needs is a subset of what the device names, and a validation shift needs `validation-v1`, which the
  handheld has always named. The parity test pins «the fixture's names are a subset of the app's, and the new
  one is in it», not equality.
- **D12. Wording.** The spec says «Моя станция» for the station; a handheld is not a station, so the strip says
  «Моя смена» as the delegating brief asks (owner may rename). The long form of the menu item is «Закрыть свою
  часть» only while the strip is shown.
- **D13. Out of scope here:** a participants sheet on the handheld (the team sheet of the cloud stays cloud-only),
  push of totals, a timeout for `left` participants (host D18), recalculating `plannedQty` of the mirror from
  the beat (the list refresh owns it).

## File structure

| File (under `apps/handheld/app/src/main/kotlin/app/markiro/handheld/` unless noted)                                                                 | Responsibility                                                | Tasks      |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ---------- |
| `core/network/host/HostDtos.kt`                                                                                                                     | participant, totals and per-device DTOs on `DeviceShiftDto`   | 2          |
| `core/network/host/HostApi.kt`, `HostFailure.kt`                                                                                                    | `flag`/`int` readers, `leave`, capability, constraint details | 2, 3       |
| `core/host/HostCalls.kt`, `core/network/Dtos.kt`                                                                                                    | refusal details reach the loaders (`ErrorBody`)               | 3          |
| `core/host/ShiftParticipation.kt` (new)                                                                                                             | snapshot model, mapper, store, owed leaves, close notes       | 4          |
| `feature/shift/SharedShiftRules.kt` (new)                                                                                                           | total, strip, freshness, reason need                          | 5          |
| `core/backend/StationBackend.kt`, `HostBackend.kt`, `core/host/HostShiftMapping.kt`                                                                 | seam `leave`, persistence on list/enter/leave, closed part    | 6          |
| `core/host/HostParticipation.kt` (new), `HostHeartbeat.kt`, `HostModule.kt`                                                                         | beat: owed leaves and totals                                  | 7          |
| `feature/shift/ShiftRepository.kt`, `ShiftListViewModel.kt`, `ShiftDialogScreen.kt`, `feature/hub/HubViewModel.kt`                                  | enter results and dialogs                                     | 8          |
| `feature/shift/ShiftRepository.kt`                                                                                                                  | leave                                                         | 9          |
| `feature/work/WorkViewModel.kt`, `WorkScreen.kt`, `SharedShiftStrip.kt` (new)                                                                       | strip                                                         | 10         |
| `feature/shift/ShiftCloser.kt`, `CloseViewModel.kt`, `CloseScreens.kt`, `ShiftModule.kt`, `core/host/HostAckMapper.kt`, `core/storage/ShiftDaos.kt` | close                                                         | 11         |
| `res/values/strings.xml`, `res/values-en/strings.xml`                                                                                               | strings                                                       | 8, 10, 11  |
| tests under `apps/handheld/app/src/test/kotlin/app/markiro/handheld/`                                                                               | JVM, Robolectric, Compose                                     | every task |
| `apps/handheld/README.md`, `AGENTS.md`, `CHANGELOG.md`, `docs/runbooks/standalone-handheld-checklist.md`                                            | docs and the device checklist                                 | 12         |

---

### Task 1: Preflight — the host contract is in the tree, and the baseline is green

This task writes no code and makes no commit.

**Files:**

- Read: `apps/standalone/proto/fixtures/` (the fixtures named below), `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/storage/HandheldDatabase.kt:111`

**Interfaces:**

- Consumes: the host plan's Tasks 2, 3 and 14 merged (fixtures, protocol 7 on the host).
- Produces: a verified starting point; nothing else.

- [ ] **Step 1: The host's shared fixtures exist.** Run:

```bash
for f in device-shifts-participants error-shift-line-full error-shift-busy shift-enter-handheld-multi \
         facts-response-part-close shift-close-reason-shared compatibility device-shifts device-shift-entered; do
  test -f "$WT/apps/standalone/proto/fixtures/$f.json" && echo "ok  $f" || echo "MISSING $f"
done
```

Expected: ten `ok` lines, no `MISSING`. If any is missing the host plan has not landed: stop and report; do not create the fixture here (the host owns it, and a handheld-local copy would hide a parity failure).

- [ ] **Step 2: Room is at 22 and this plan needs no migration.** Run `grep -n "HANDHELD_DATABASE_VERSION = " "$WT/apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/storage/HandheldDatabase.kt"`. Expected: `const val HANDHELD_DATABASE_VERSION = 22`. If it is higher, another migration landed; this plan is unaffected (it adds none) but record the number in the report.

- [ ] **Step 3: The protocol pin.** Run `grep -n "const val PROTOCOL" "$WT/apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/network/host/HostCompat.kt"`. Expected: `const val PROTOCOL = 6` (D1: it stays).

- [ ] **Step 4: Baseline.** Run:

```bash
"$WT/apps/handheld/gradlew" -p "$WT/apps/handheld" --no-daemon :app:testDebugUnitTest \
  --tests "app.markiro.handheld.core.network.host.*" --tests "app.markiro.handheld.core.host.*" \
  --tests "app.markiro.handheld.core.backend.*" --tests "app.markiro.handheld.feature.shift.*" \
  --tests "app.markiro.handheld.feature.work.*" --tests "app.markiro.handheld.feature.hub.*"
```

Expected: PASS. If the baseline is red, stop and report which test; do not start on a red tree.

---

### Task 2: Wire DTOs of a shared shift and their parity with the host's fixtures

**Files:**

- Modify: `core/network/host/HostDtos.kt:54-78` (`DeviceShiftDto`; add three DTOs before it)
- Modify: `core/network/host/HostApi.kt:1-15` (imports and the `text` helper)
- Modify test: `app/src/test/kotlin/app/markiro/handheld/core/network/host/HostFixturesTest.kt` (append tests; add imports)

**Interfaces:**

- Consumes: host fixtures `device-shifts-participants.json`, `device-shifts.json`, `facts-response-part-close.json`.
- Produces: `ShiftParticipantDto`, `DeviceTotalsDto`, `DeviceShiftTotalsDto`; `DeviceShiftDto.{maxStations, participants, myState, totals, byDevice}` (all nullable, default `null`: an older host sends none); `fun JsonObject?.int(key: String): Int?`, `fun JsonObject?.flag(key: String): Boolean`.

- [ ] **Step 1: Write the failing tests.** In `HostFixturesTest.kt` add `import org.junit.Assert.assertNotNull` if absent, then append inside the class:

```kotlin
    @Test
    fun aSharedShiftsParticipantsTotalsAndEachDevicesPartAreReadAndAddUp() {
        val json = Json { ignoreUnknownKeys = true }
        val shift = json.decodeFromJsonElement(DeviceShiftsDto.serializer(), fixture("device-shifts-participants.json")).shifts.single()
        assertEquals(2, shift.maxStations)
        assertEquals("active", shift.myState)
        val participants = checkNotNull(shift.participants)
        val byDevice = checkNotNull(shift.byDevice)
        val totals = checkNotNull(shift.totals)
        assertEquals(listOf("active", "closed"), participants.map { it.state })
        assertEquals(listOf("station", "handheld"), participants.map { it.deviceKind })
        assertEquals("device", participants[1].closedBy)
        assertEquals(120, participants[1].closedActualQty)
        assertEquals("2026-10-08T09:05:00Z", participants[1].lateDataAt)
        // byDevice lists every participant in participants order and adds up to the shift's total.
        assertEquals(participants.map { it.deviceId }, byDevice.map { it.deviceId })
        assertEquals(totals.accepted, byDevice.sumOf { it.accepted })
        assertEquals(45, totals.boxesClosed)
        assertEquals("2026-10-08T09:41:07Z", totals.asOf)
    }

    @Test
    fun aHostBeforeProtocolSevenNamesNoParticipantsAndItsListStillReads() {
        val json = Json { ignoreUnknownKeys = true }
        val shifts = json.decodeFromJsonElement(DeviceShiftsDto.serializer(), fixture("device-shifts.json")).shifts
        assertTrue(shifts.isNotEmpty())
        assertTrue(
            shifts.all { it.participants == null && it.totals == null && it.byDevice == null && it.myState == null && it.maxStations == null },
        )
    }

    @Test
    fun theReceiptOfAPartCloseCarriesItsFlagsAndTheOtherFlagIsAbsent() {
        val json = Json { ignoreUnknownKeys = true }
        val receipts = json.decodeFromJsonElement(FactReceiptsDto.serializer(), fixture("facts-response-part-close.json")).receipts
        assertEquals(listOf("accepted", "accepted"), receipts.map { it.outcome })
        assertTrue(receipts[0].details.flag("partClosed"))
        assertFalse(receipts[0].details.flag("reasonMissing"))
        assertTrue(receipts[1].details.flag("reasonMissing"))
        // A flag that is not a JSON boolean, or a missing detail object, is `false`, never a crash.
        assertFalse(null.flag("partClosed"))
        assertFalse(Json.parseToJsonElement("""{"partClosed":"true"}""").jsonObject.flag("partClosed"))
        assertEquals(2, Json.parseToJsonElement("""{"active":2}""").jsonObject.int("active"))
        assertNull(Json.parseToJsonElement("""{"active":"2"}""").jsonObject.int("active"))
    }
```

- [ ] **Step 2: Run them to verify they fail.**
      Run: `GRADLE :app:testDebugUnitTest --tests "app.markiro.handheld.core.network.host.HostFixturesTest"`
      Expected: FAIL to compile (`Unresolved reference: maxStations`, `flag`, `int`).

- [ ] **Step 3: Add the DTOs.** In `HostDtos.kt` replace the block `@Serializable data class DeviceShiftDto( … )` (`:54-75`) with the three new DTOs followed by the extended shift:

```kotlin
/** A device's part in a shift (host protocol 7, `ShiftParticipant`): the strings are the host's, read as they come (`active|left|closed`). */
@Serializable
data class ShiftParticipantDto(
    val deviceId: String,
    val deviceKind: String,
    val deviceName: String,
    val state: String,
    val firstEnteredAt: String? = null,
    val joinedAt: String? = null,
    val leftAt: String? = null,
    val closedAt: String? = null,
    val closedBy: String? = null,
    val closedActualQty: Int? = null,
    val closedReasonCode: String? = null,
    val lateDataAt: String? = null,
    val lastSeenAt: String? = null,
)

/** One device's accepted units, closed boxes and closed pallets in a shift, counted by the host from the facts it holds. */
@Serializable
data class DeviceTotalsDto(val deviceId: String, val accepted: Long, val boxesClosed: Int = 0, val pallets: Int = 0)

/** The shift-wide totals and the host's clock at the moment it counted them (`asOf`, a host instant: whole seconds, `Z`). */
@Serializable
data class DeviceShiftTotalsDto(val accepted: Long, val boxesClosed: Int = 0, val pallets: Int = 0, val asOf: String)

@Serializable
data class DeviceShiftDto(
    val id: String,
    val number: String,
    val status: String,
    val mode: String,
    val palletsEnabled: Boolean = false,
    val lineId: String,
    val productId: String,
    val productName: String,
    val productGtin14: String,
    val counterpartyName: String? = null,
    val productionDate: String,
    val plannedDate: String? = null,
    val plannedQty: Int? = null,
    val boxCapacity: Int,
    val palletBoxCapacity: Int? = null,
    val ownerDeviceId: String? = null,
    val openedAt: String? = null,
    val closedAt: String? = null,
    val snapshot: ShiftSnapshotDto? = null,
    /** Protocol 7, open or closed shifts only; every one is absent from an older host and from a planned shift. */
    val maxStations: Int? = null,
    val participants: List<ShiftParticipantDto>? = null,
    /** This device's own state; absent when it never entered. */
    val myState: String? = null,
    val totals: DeviceShiftTotalsDto? = null,
    val byDevice: List<DeviceTotalsDto>? = null,
)
```

- [ ] **Step 4: Add the readers.** In `HostApi.kt` add to the imports `import kotlinx.serialization.json.booleanOrNull` and `import kotlinx.serialization.json.intOrNull`, and directly under the existing `JsonObject?.text` helper add:

```kotlin
/** A detail that is a JSON number read as an `Int`, or `null` for anything else (a string, an object, a missing key). */
fun JsonObject?.int(key: String): Int? = (this?.get(key) as? JsonPrimitive)?.takeIf { !it.isString }?.intOrNull

/** A detail that is the JSON boolean `true`; a missing key, a string `"true"` or anything else is `false`. */
fun JsonObject?.flag(key: String): Boolean = (this?.get(key) as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull == true
```

- [ ] **Step 5: Run the tests to verify they pass.**
      Run: `GRADLE :app:testDebugUnitTest --tests "app.markiro.handheld.core.network.host.HostFixturesTest" --tests "app.markiro.handheld.core.network.host.HostApiTest"`
      Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git -C "$WT" add apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/network/host/HostDtos.kt \
  apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/network/host/HostApi.kt \
  apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/network/host/HostFixturesTest.kt
git -C "$WT" commit -m "feat(handheld): read the participants, totals and own state of a shared shift (host protocol 7 shapes)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The capability, the leave call and the details of a refusal

**Files:**

- Modify: `core/network/host/HostApi.kt:78-83` (`enter`; add `leave`), `:145-151` (companion), `:23-38` (`failureOf`)
- Modify: `core/network/host/HostFailure.kt:21-22`
- Modify: `core/host/HostCalls.kt:34-41`, `:54-57`, imports
- Modify: `core/network/Dtos.kt:127-128` (`ErrorBody`)
- Modify tests: `core/network/host/HostApiTest.kt` (one changed assertion, new tests), `core/backend/HostBackendShiftsTest.kt:137-150`, `core/network/host/HostFixturesTest.kt`

**Interfaces:**

- Consumes: Task 2 (`int`, `DeviceShiftDto`); host fixtures `error-shift-line-full.json`, `error-shift-busy.json`, `shift-enter-handheld-multi.json`.
- Produces: `HostApi.CAPABILITY_MULTI_STATION = "multi-station-v1"`; `internal val HostApi.ENTER_SUPPORTS`; `suspend fun HostApi.leave(shiftId): Result<DeviceShiftDto>`; `HostFailure.Constraint(name, maxStations: Int? = null, active: Int? = null)`; a `409` of a full line reaches the loaders as `HttpException` with body `{"code":"shift_line_full","maxStations":N,"active":M}`; `ErrorBody(code, maxStations, active)`.

- [ ] **Step 1: Write the failing tests.** In `HostApiTest.kt` add imports `kotlinx.serialization.json.Json`, `kotlinx.serialization.json.jsonArray`, `kotlinx.serialization.json.jsonObject`, a private helper inside the class, and the tests; **change** the existing `anEntryNamesTheValidationCapabilityButNotTheDuplicate` expectation (a product decision changed: the entry names a third capability) and rename it:

```kotlin
    private fun fixture(name: String) = checkNotNull(javaClass.classLoader?.getResource(name)) { "$name is not in the test resources" }.readText()
    private val shiftId = "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b"

    @Test
    fun anEntryNamesTheValidationAndTheMultiStationCapabilitiesButNotTheDuplicate() = runTest {
        val (transport, host) = api(error(409, "conflict", """{"constraint":"station_update"}"""))
        host.enter("1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d")
        val body = transport.sent.single().third.orEmpty()
        assertTrue(body, body.contains("\"supports\":[\"handheld-host-v1\",\"validation-v1\",\"multi-station-v1\"]"))
        assertTrue(!body.contains("duplicate"))
    }

    @Test
    fun aFullLineKeepsItsNumbersAndAnOldHostsBusyKeepsNone() = runTest {
        val (_, full) = api(HostResult.Ok(409, fixture("error-shift-line-full.json"), null))
        assertEquals(
            HostFailure.Constraint("shift_line_full", maxStations = 2, active = 2),
            (full.enter(shiftId).exceptionOrNull() as HostApiError).failure,
        )
        val (_, busy) = api(HostResult.Ok(409, fixture("error-shift-busy.json"), null))
        assertEquals(HostFailure.Constraint("shift_busy"), (busy.enter(shiftId).exceptionOrNull() as HostApiError).failure)
        // A number that is not a number is no number: the refusal still is a shift_line_full.
        val (_, odd) = api(error(409, "conflict", """{"constraint":"shift_line_full","maxStations":"2","active":{"n":2}}"""))
        assertEquals(HostFailure.Constraint("shift_line_full"), (odd.enter(shiftId).exceptionOrNull() as HostApiError).failure)
    }

    @Test
    fun aLeavePostsNothingButItsPathAndReadsTheShiftBack() = runTest {
        val shift = Json.parseToJsonElement(fixture("device-shifts-participants.json")).jsonObject.getValue("shifts").jsonArray[0].toString()
        val (transport, host) = api(ok(shift))
        val left = host.leave(shiftId).getOrThrow()
        assertEquals(Triple("POST", "/v1/device/shifts/$shiftId/leave", ""), transport.sent.single())
        assertEquals(2, left.maxStations)
        assertEquals("active", left.myState)
        val (_, refused) = api(error(409, "conflict", """{"constraint":"shift_not_entered"}"""))
        assertEquals(HostFailure.Constraint("shift_not_entered"), (refused.leave(shiftId).exceptionOrNull() as HostApiError).failure)
    }
```

(Delete the old `anEntryNamesTheValidationCapabilityButNotTheDuplicate` method: it is replaced by the first test above.)

In `HostFixturesTest.kt` append:

```kotlin
    @Test
    fun theEntryNamesWhatTheHostsHandheldFixtureAsksAndTheMultiStationCapability() {
        val named = fixture("shift-enter-handheld-multi.json").getValue("supports").jsonArray.map { it.jsonPrimitive.content }
        assertTrue(named.contains(HostApi.CAPABILITY_MULTI_STATION))
        // The host checks that what a shift needs is a subset of what the device names, so more names are harmless;
        // fewer are not: every name of the host's fixture must be one of this app's.
        assertTrue(HostApi.ENTER_SUPPORTS.toString(), HostApi.ENTER_SUPPORTS.containsAll(named))
        assertEquals("multi-station-v1", HostApi.CAPABILITY_MULTI_STATION)
    }
```

In `HostBackendShiftsTest.kt` inside `theHostsRefusalsReachTheLoadersAsTheCodesTheyAlreadyRead` add after the `shift_line` assertion:

```kotlin
        // A full line keeps the two numbers the dialog says; an old host's busy keeps none.
        assertEquals(
            409 to """{"code":"shift_line_full","maxStations":2,"active":2}""",
            refused(refusal(409, "conflict", """{"constraint":"shift_line_full","maxStations":2,"active":2}""")),
        )
        assertEquals(409 to """{"code":"shift_not_entered"}""", refused(refusal(409, "conflict", """{"constraint":"shift_not_entered"}""")))
```

- [ ] **Step 2: Run them to verify they fail.**
      Run: `GRADLE :app:testDebugUnitTest --tests "app.markiro.handheld.core.network.host.HostApiTest" --tests "app.markiro.handheld.core.backend.HostBackendShiftsTest" --tests "app.markiro.handheld.core.network.host.HostFixturesTest"`
      Expected: FAIL to compile (`leave`, `CAPABILITY_MULTI_STATION`, `ENTER_SUPPORTS`, `maxStations =` unresolved).

- [ ] **Step 3: Implement.** `HostFailure.kt`: replace the `Constraint` line (`:22`) with

```kotlin
    data class Constraint(val name: String, val maxStations: Int? = null, val active: Int? = null) : HostFailure
```

and extend its doc comment with «`shift_line_full` also carries `maxStations` and `active`».

`HostApi.kt`: in `failureOf` replace `constraint != null -> HostFailure.Constraint(constraint)` with

```kotlin
            constraint != null -> HostFailure.Constraint(constraint, error.details.int("maxStations"), error.details.int("active"))
```

After `enter` (`:83`) add:

```kotlin
    /**
     * Frees this device's slot of a shared shift (`POST /v1/device/shifts/{id}/leave`, protocol 7): no body, answered with the shift as the device
     * sees it. State-idempotent on the host, so a retry after a lost answer is harmless; `shift_not_entered` means the host holds no slot of this device.
     */
    suspend fun leave(shiftId: String): Result<DeviceShiftDto> =
        parse(transport.post("/v1/device/shifts/$shiftId/leave", ""), DeviceShiftDto.serializer())
```

and replace the companion's `ENTER_SUPPORTS` line and add the constant:

```kotlin
        /** Several devices in one shift (protocol 7): named on every entry, so a free slot of the line takes this device; an older host ignores the name. */
        const val CAPABILITY_MULTI_STATION = "multi-station-v1"
        internal val ENTER_SUPPORTS = listOf(CAPABILITY, CAPABILITY_VALIDATION, CAPABILITY_MULTI_STATION)
```

`Dtos.kt`: replace `data class ErrorBody(val code: String? = null)` with

```kotlin
data class ErrorBody(val code: String? = null, val maxStations: Int? = null, val active: Int? = null)
```

(the annotation `@Serializable` above it stays; the two numbers are the host's `shift_line_full` details and absent from every cloud body).

`HostCalls.kt`: add imports `kotlinx.serialization.json.buildJsonObject` and `kotlinx.serialization.json.put`; replace the `is HostFailure.Constraint` branch (`:34-41`) with

```kotlin
            is HostFailure.Constraint -> http(
                409,
                when (failure.name) {
                    "station_update" -> "STATION_UPDATE_REQUIRED"
                    "shift_status" -> null // the cloud's closed shift is a `409` with no code
                    else -> failure.name
                },
                mapOf("maxStations" to failure.maxStations, "active" to failure.active),
            )
```

and replace `http` (`:54-57`) with

```kotlin
    private fun http(status: Int, code: String?, numbers: Map<String, Int?> = emptyMap()): HttpException {
        val json = if (code == null) {
            "{}"
        } else {
            buildJsonObject {
                put("code", code)
                for ((key, value) in numbers) if (value != null) put(key, value)
            }.toString()
        }
        return HttpException(Response.error<Any>(status, json.toResponseBody("application/json".toMediaType())))
    }
```

- [ ] **Step 4: Run the tests to verify they pass.**
      Run: the Step 2 command, plus `--tests "app.markiro.handheld.core.host.HostCallsTest"`.
      Expected: PASS (the pre-existing `{"code":"shift_busy"}` body is byte-identical to what `buildJsonObject` produces).

- [ ] **Step 5: Commit.**

```bash
git -C "$WT" add apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/network/host/HostApi.kt \
  apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/network/host/HostFailure.kt \
  apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/network/Dtos.kt \
  apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/host/HostCalls.kt \
  apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/network/host/HostApiTest.kt \
  apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/network/host/HostFixturesTest.kt \
  apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/backend/HostBackendShiftsTest.kt
git -C "$WT" commit -m "feat(handheld): name multi-station-v1 on entry, add the leave call, keep the numbers of a full line

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The participation snapshot, its store, owed leaves and close notes

**Files:**

- Create: `core/host/ShiftParticipation.kt`
- Create test: `app/src/test/kotlin/app/markiro/handheld/core/host/ShiftParticipationStoreTest.kt`

**Interfaces:**

- Consumes: Task 2 (`DeviceShiftDto`, `ShiftParticipantDto`); `MetaDao.{get,put,remove,withPrefix,observe}` (`core/storage/ShiftDaos.kt:173-193`); `db.recovery.commit`.
- Produces:
  - `@Serializable data class ShiftParticipation(shiftId, maxStations: Int?, myState: String?, participantsEver: Int, active: Int, othersOpen: Int, accepted: Long?, boxesClosed: Int?, pallets: Int?, myAccepted: Long?, asOf: String?, fetchedAt: Long, stale: Boolean)`
  - `fun DeviceShiftDto.toParticipation(myDeviceId: String?, now: Long): ShiftParticipation?` (`null` for a shift that carries none of the protocol-7 fields)
  - `class ShiftParticipationStore(db, myDeviceId: suspend () -> String?, clock)` with `get`, `observe`, `save(List)`, `save(one)`, `markStale`, `markLeavePending`, `pendingLeaves`, `clearLeavePending`, `noteClose`, `closeNote`, and companion `PREFIX`, `LEAVE_PREFIX`, `key`, `leaveKey`, `closeNoteKey`, `NOTE_PART_CLOSED`, `NOTE_REASON_MISSING`.

- [ ] **Step 1: Write the failing test** `ShiftParticipationStoreTest.kt`:

```kotlin
package app.markiro.handheld.core.host

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.network.host.DeviceShiftDto
import app.markiro.handheld.core.network.host.DeviceShiftsDto
import app.markiro.handheld.core.network.host.ShiftParticipantDto
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.initializeRecoveryForTest
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ShiftParticipationStoreTest {
    private lateinit var db: HandheldDatabase
    private val json = Json { ignoreUnknownKeys = true }
    /** The first participant of the host's fixture: the device that reads the fixture as its own (`myState` is `active`). */
    private val me = "7c9e6679-7425-40de-944b-e07fc1f90ae7"
    private val shiftId = "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b"
    private var now = 1_760_000_000_000L

    @Before
    fun open() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java).allowMainThreadQueries().build()
        db.initializeRecoveryForTest()
    }

    @After
    fun close() = db.close()

    private fun store() = ShiftParticipationStore(db, myDeviceId = { me }, clock = { now })

    private fun shifts(file: String = "device-shifts-participants.json"): List<DeviceShiftDto> =
        json.decodeFromString(
            DeviceShiftsDto.serializer(),
            checkNotNull(javaClass.classLoader?.getResource(file)) { "$file is not in the test resources" }.readText(),
        ).shifts

    private fun part(id: String, state: String) = ShiftParticipantDto(deviceId = id, deviceKind = "station", deviceName = "n", state = state)

    @Test
    fun aSharedShiftIsKeptWithTheFiguresTheStripAndTheCloseNeed() = runTest {
        store().save(shifts())
        val p = checkNotNull(store().get(shiftId))
        assertEquals(2, p.maxStations)
        assertEquals("active", p.myState)
        assertEquals(2, p.participantsEver)
        assertEquals(1, p.active)
        // The other participant closed its part: nobody else keeps the shift open.
        assertEquals(0, p.othersOpen)
        assertEquals(547L, p.accepted)
        assertEquals(427L, p.myAccepted)
        assertEquals(45, p.boxesClosed)
        assertEquals("2026-10-08T09:41:07Z", p.asOf)
        assertEquals(now, p.fetchedAt)
        assertFalse(p.stale)
    }

    @Test
    fun othersOpenCountsTheActiveAndLeftParticipantsOtherThanThisDevice() = runTest {
        val base = shifts().single()
        store().save(base.copy(participants = listOf(part(me, "active"), part("x", "left"), part("y", "closed"))))
        assertEquals(1, store().get(shiftId)!!.othersOpen)
        store().save(base.copy(participants = listOf(part(me, "active"), part("x", "left"), part("z", "active"))))
        assertEquals(2, store().get(shiftId)!!.othersOpen)
        assertEquals(2, store().get(shiftId)!!.active)
    }

    @Test
    fun aShiftTheHostNoLongerListsLosesItsFigures() = runTest {
        store().save(shifts())
        assertNotNull(store().get(shiftId))
        store().save(emptyList())
        assertNull(store().get(shiftId))
    }

    @Test
    fun aListOfAnOlderHostStoresNothing() = runTest {
        store().save(shifts("device-shifts.json"))
        assertTrue(db.metaDao().withPrefix(ShiftParticipationStore.PREFIX).isEmpty())
    }

    @Test
    fun anUnreachableHostMarksTheFiguresStaleUntilTheNextAnswer() = runTest {
        store().save(shifts())
        store().markStale(shiftId)
        assertTrue(store().get(shiftId)!!.stale)
        // Nothing is invented for a shift that has no figures.
        store().markStale("no-such-shift")
        assertNull(store().get("no-such-shift"))
        now += 15_000
        store().save(shifts())
        val p = store().get(shiftId)!!
        assertFalse(p.stale)
        assertEquals(now, p.fetchedAt)
    }

    @Test
    fun anOwedLeaveIsRememberedUntilItIsCleared() = runTest {
        assertEquals(emptyList<String>(), store().pendingLeaves())
        store().markLeavePending(shiftId)
        store().markLeavePending("other")
        assertEquals(setOf(shiftId, "other"), store().pendingLeaves().toSet())
        store().clearLeavePending(shiftId)
        assertEquals(listOf("other"), store().pendingLeaves())
    }

    @Test
    fun aCloseNoteIsKeptPerShift() = runTest {
        assertNull(store().closeNote(shiftId))
        store().noteClose(shiftId, ShiftParticipationStore.NOTE_PART_CLOSED)
        assertEquals("part_closed", store().closeNote(shiftId))
        assertNull(store().closeNote("other"))
    }

    @Test
    fun aDamagedValueReadsAsNoFiguresNotACrash() = runTest {
        db.recovery.commit { db.metaDao().put(app.markiro.handheld.core.storage.MetaEntity(ShiftParticipationStore.key(shiftId), "{not json")) }
        assertNull(store().get(shiftId))
    }
}
```

- [ ] **Step 2: Run it to verify it fails.**
      Run: `GRADLE :app:testDebugUnitTest --tests "app.markiro.handheld.core.host.ShiftParticipationStoreTest"`
      Expected: FAIL to compile (`ShiftParticipationStore`, `ShiftParticipation` unresolved).

- [ ] **Step 3: Implement** `core/host/ShiftParticipation.kt`:

```kotlin
package app.markiro.handheld.core.host

import app.markiro.handheld.core.network.host.DeviceShiftDto
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.MetaEntity
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * What the host last said of a shift that several devices may work, reduced to what this device needs (plan 2b): the strip's figures and the
 * close rule. Derived, never a source of truth: it is rewritten from every answer of the host and losing it costs a refresh.
 */
@Serializable
data class ShiftParticipation(
    val shiftId: String,
    /** The line's limit of devices in one shift; `null` from a host that does not say. */
    val maxStations: Int? = null,
    /** This device's state at the host (`active|left|closed`); `null` when it never entered. */
    val myState: String? = null,
    /** Every device the shift ever had, this one included: only ever grows, so a stale value can only be too small. */
    val participantsEver: Int = 0,
    val active: Int = 0,
    /** Other devices whose part is still open (`active` or `left`): they keep the shift open after this device closes its part. */
    val othersOpen: Int = 0,
    /** The shift-wide accepted units as the host counted them at [asOf]. */
    val accepted: Long? = null,
    val boxesClosed: Int? = null,
    val pallets: Int? = null,
    /** What this device had delivered to the host at [asOf] (its `byDevice` row): the part of [accepted] that is its own. */
    val myAccepted: Long? = null,
    /** The host's clock when it counted, as it wrote it. */
    val asOf: String? = null,
    /** This device's clock when the answer was read: the freshness test of the close rule. */
    val fetchedAt: Long,
    /** The host did not answer the last beat: the figures are the last known ones. */
    val stale: Boolean = false,
)

/** `null` for a shift that carries none of the protocol-7 fields (a planned shift, or an older host): there is nothing to remember. */
fun DeviceShiftDto.toParticipation(myDeviceId: String?, now: Long): ShiftParticipation? {
    if (maxStations == null && participants == null && totals == null && myState == null) return null
    val all = participants.orEmpty()
    return ShiftParticipation(
        shiftId = id,
        maxStations = maxStations,
        myState = myState,
        participantsEver = all.size,
        active = all.count { it.state == "active" },
        othersOpen = all.count { it.deviceId != myDeviceId && (it.state == "active" || it.state == "left") },
        accepted = totals?.accepted,
        boxesClosed = totals?.boxesClosed,
        pallets = totals?.pallets,
        myAccepted = byDevice?.firstOrNull { it.deviceId == myDeviceId }?.accepted,
        asOf = totals?.asOf,
        fetchedAt = now,
    )
}

/**
 * The participation of each shift, the leaves still owed to the host and the host's remark on this device's close, as rows of `meta`
 * (a business table: a dataset reset clears it; no Room migration). Reads are cheap and tolerate a damaged value.
 */
class ShiftParticipationStore(
    private val db: HandheldDatabase,
    private val myDeviceId: suspend () -> String? = { db.deviceConfigDao().get()?.deviceId },
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    private fun decode(value: String?): ShiftParticipation? =
        value?.let { runCatching { json.decodeFromString(ShiftParticipation.serializer(), it) }.getOrNull() }

    private fun encode(row: ShiftParticipation) = json.encodeToString(ShiftParticipation.serializer(), row)

    suspend fun get(shiftId: String): ShiftParticipation? = decode(db.metaDao().get(key(shiftId)))

    fun observe(shiftId: String): Flow<ShiftParticipation?> = db.metaDao().observe(key(shiftId)).map { decode(it) }.distinctUntilChanged()

    /** One answer of the list: every shift that carries figures is rewritten, every stored shift the host no longer lists is forgotten. */
    suspend fun save(shifts: List<DeviceShiftDto>) {
        val me = myDeviceId()
        val now = clock()
        db.recovery.commit {
            val keep = mutableSetOf<String>()
            for (shift in shifts) {
                val row = shift.toParticipation(me, now) ?: continue
                db.metaDao().put(MetaEntity(key(shift.id), encode(row)))
                keep += shift.id
            }
            for (stored in db.metaDao().withPrefix(PREFIX)) {
                if (stored.key.removePrefix(PREFIX) !in keep) db.metaDao().remove(stored.key)
            }
        }
    }

    /** The answer of one call (an entry or a leave). */
    suspend fun save(shift: DeviceShiftDto) {
        val row = shift.toParticipation(myDeviceId(), clock()) ?: return
        db.recovery.commit { db.metaDao().put(MetaEntity(key(shift.id), encode(row))) }
    }

    /** The host did not answer: the stored figures stay, marked as the last known ones. A shift with no figures stays without. */
    suspend fun markStale(shiftId: String) {
        db.recovery.commit {
            val current = decode(db.metaDao().get(key(shiftId))) ?: return@commit
            if (!current.stale) db.metaDao().put(MetaEntity(key(shiftId), encode(current.copy(stale = true))))
        }
    }

    suspend fun markLeavePending(shiftId: String) =
        db.recovery.commit { db.metaDao().put(MetaEntity(leaveKey(shiftId), clock().toString())) }

    suspend fun pendingLeaves(): List<String> = db.metaDao().withPrefix(LEAVE_PREFIX).map { it.key.removePrefix(LEAVE_PREFIX) }

    suspend fun clearLeavePending(shiftId: String) = db.recovery.commit { db.metaDao().remove(leaveKey(shiftId)) }

    /** What the host answered to this device's close beyond «accepted» (`NOTE_*`); read by the close summary. */
    suspend fun noteClose(shiftId: String, note: String) = db.recovery.commit { db.metaDao().put(MetaEntity(closeNoteKey(shiftId), note)) }

    suspend fun closeNote(shiftId: String): String? = db.metaDao().get(closeNoteKey(shiftId))

    companion object {
        const val PREFIX = "shift_participation:"
        const val LEAVE_PREFIX = "shift_leave_pending:"
        private const val NOTE_PREFIX = "shift_close_note:"

        /** The part closed and the shift stays open for the others (`accepted {partClosed:true}`). */
        const val NOTE_PART_CLOSED = "part_closed"

        /** The shift closed with this close but without the reason its plan needed (`accepted {reasonMissing:true}`): the office supplies it. */
        const val NOTE_REASON_MISSING = "reason_missing"

        fun key(shiftId: String) = PREFIX + shiftId
        fun leaveKey(shiftId: String) = LEAVE_PREFIX + shiftId
        fun closeNoteKey(shiftId: String) = NOTE_PREFIX + shiftId
    }
}
```

- [ ] **Step 4: Run the test to verify it passes.**
      Run: `GRADLE :app:testDebugUnitTest --tests "app.markiro.handheld.core.host.ShiftParticipationStoreTest"`
      Expected: PASS (8 tests). Also run `--tests "app.markiro.handheld.core.storage.HostDatasetResetTest"` — it asserts every table is classified; `meta` already is, nothing changes. Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git -C "$WT" add apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/host/ShiftParticipation.kt \
  apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/host/ShiftParticipationStoreTest.kt
git -C "$WT" commit -m "feat(handheld): remember the participation of a shared shift, owed leaves and close notes in meta

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The shared-shift rules (total, strip, freshness, reason need) pinned by the host's fixture

**Files:**

- Create: `feature/shift/SharedShiftRules.kt`
- Create test: `app/src/test/kotlin/app/markiro/handheld/feature/shift/SharedShiftRulesTest.kt`

**Interfaces:**

- Consumes: Task 4 (`ShiftParticipation`); `ShiftCloser.reasonRequired(plannedQty, actualQty)` (`feature/shift/ShiftCloser.kt:131`); `Iso.parse`; host fixture `shift-close-reason-shared.json`.
- Produces:
  - `object SharedShiftRules { const val FRESH_MS = 90_000L; fun isShared(p): Boolean; fun isFresh(p, now): Boolean; fun shiftTotal(p, localAccepted: Int): Int; fun reasonRequired(plan: Int?, localAccepted: Int, p, now: Long): Boolean; fun strip(p, localAccepted: Int, plan: Int?): SharedStrip? }`
  - `data class SharedStrip(mine: Int, total: Int, plan: Int?, active: Int, maxStations: Int, staleAtMillis: Long?)`

- [ ] **Step 1: Write the failing test** `SharedShiftRulesTest.kt`:

```kotlin
package app.markiro.handheld.feature.shift

import app.markiro.handheld.core.host.ShiftParticipation
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SharedShiftRulesTest {
    private val now = 1_760_000_000_000L

    private fun fixture(name: String) = Json.parseToJsonElement(
        checkNotNull(javaClass.classLoader?.getResource(name)) { "$name is not in the test resources" }.readText(),
    ).jsonObject

    private fun shared(
        accepted: Long? = 547,
        mine: Long? = 427,
        ever: Int = 2,
        othersOpen: Int = 0,
        max: Int? = 2,
        fetchedAt: Long = now,
        stale: Boolean = false,
    ) = ShiftParticipation(
        shiftId = "s1", maxStations = max, myState = "active", participantsEver = ever, active = 1, othersOpen = othersOpen,
        accepted = accepted, myAccepted = mine, asOf = "2026-10-08T09:41:07Z", fetchedAt = fetchedAt, stale = stale,
    )

    /** The host's own cases (`shift_participants::reason_need`): this client says «ask for a reason» exactly where the host says `required` or `shared`. */
    @Test
    fun theReasonRuleIsTheHostsSharedFixture() {
        val cases = fixture("shift-close-reason-shared.json").getValue("cases").jsonArray
        assertTrue(cases.size >= 8)
        for (case in cases) {
            val o = case.jsonObject
            fun int(key: String): Int? = (o.getValue(key) as? JsonPrimitive)?.takeIf { it !is JsonNull }?.int
            val ever = int("participantsEver")!!
            val actual = int("actualQty")!!
            val closesShift = o.getValue("closesShift").jsonPrimitive.boolean
            // One device ever: the plan the device saw (the shift row it holds); a shared shift: the host's plan now (the same row, freshly listed).
            val plan = if (ever <= 1) int("factPlanned") else int("hostPlanned")
            val snapshot = shared(
                accepted = o.getValue("shiftAccepted").jsonPrimitive.long, mine = actual.toLong(), ever = ever, othersOpen = if (closesShift) 0 else 1,
            )
            val expected = o.getValue("need").jsonPrimitive.content != "none"
            assertEquals(case.toString(), expected, SharedShiftRules.reasonRequired(plan, actual, snapshot, now))
        }
    }

    @Test
    fun aDeviceAloneInItsShiftKeepsStageTwoAsRule() {
        // No snapshot, an older host (no figures) and a shift only this device ever had all judge by the device's own count.
        assertTrue(SharedShiftRules.reasonRequired(100, 99, null, now))
        assertFalse(SharedShiftRules.reasonRequired(100, 100, null, now))
        assertFalse(SharedShiftRules.reasonRequired(null, 5, null, now))
        assertTrue(SharedShiftRules.reasonRequired(100, 99, shared(ever = 1, accepted = 99, mine = 99), now))
        assertTrue(SharedShiftRules.reasonRequired(100, 99, shared(ever = 0, accepted = null, mine = null), now))
    }

    @Test
    fun aSharedShiftAsksOnlyTheLastCloserAndOnlyWithFreshFigures() {
        // Others still hold their parts: no reason from this one, whatever the plan says.
        assertFalse(SharedShiftRules.reasonRequired(1200, 427, shared(othersOpen = 1), now))
        // The last closer, fresh figures, the total (547) misses the plan (1200): a reason.
        assertTrue(SharedShiftRules.reasonRequired(1200, 427, shared(), now))
        // The total meets the plan: none.
        assertFalse(SharedShiftRules.reasonRequired(547, 427, shared(), now))
        // The host could not be reached (stale) or the answer is old: this device cannot know it is the last, it closes without a reason (spec 12.9).
        assertFalse(SharedShiftRules.reasonRequired(1200, 427, shared(stale = true), now))
        assertFalse(SharedShiftRules.reasonRequired(1200, 427, shared(fetchedAt = now - SharedShiftRules.FRESH_MS - 1), now))
        assertTrue(SharedShiftRules.reasonRequired(1200, 427, shared(fetchedAt = now - SharedShiftRules.FRESH_MS), now))
        // No plan: nothing to miss.
        assertFalse(SharedShiftRules.reasonRequired(null, 427, shared(), now))
    }

    @Test
    fun theShiftWideTotalIsTheOthersAsTheHostCountedThemPlusThisDevicesOwnCount() {
        // The host holds 547 of which 427 are this device's; the device has since scanned 30 more that it has not delivered.
        assertEquals(120 + 457, SharedShiftRules.shiftTotal(shared(), 457))
        // Never below the device's own count (a host answer older than the scans).
        assertEquals(500, SharedShiftRules.shiftTotal(shared(accepted = 10, mine = 400), 500))
        // No figures: the device's own count.
        assertEquals(42, SharedShiftRules.shiftTotal(null, 42))
        assertEquals(42, SharedShiftRules.shiftTotal(shared(accepted = null, mine = null), 42))
        // This device is not in the host's per-device list: the host's total is all someone else's.
        assertEquals(547 + 3, SharedShiftRules.shiftTotal(shared(mine = null), 3))
    }

    @Test
    fun theStripAppearsOnlyWhenTheLineAllowsSeveralDevicesOrSeveralWork() {
        assertNull(SharedShiftRules.strip(null, 10, 100))
        // maxStations 1 and only this device: today's screen, unchanged.
        assertNull(SharedShiftRules.strip(shared(max = 1, ever = 1, accepted = 10, mine = 10), 10, 100))
        // A host that says no limit but lists two participants.
        assertNotNull(SharedShiftRules.strip(shared(max = null, ever = 2), 10, 100))
        val strip = checkNotNull(SharedShiftRules.strip(shared(), 457, 1200))
        assertEquals(457, strip.mine)
        assertEquals(577, strip.total)
        assertEquals(1200, strip.plan)
        assertEquals(1, strip.active)
        assertEquals(2, strip.maxStations)
        assertNull("fresh figures carry no stale mark", strip.staleAtMillis)
        // Stale: the stamp is the host's own asOf.
        val stale = checkNotNull(SharedShiftRules.strip(shared(stale = true), 457, 1200))
        assertEquals(java.time.Instant.parse("2026-10-08T09:41:07Z").toEpochMilli(), stale.staleAtMillis)
    }
}
```

- [ ] **Step 2: Run it to verify it fails.**
      Run: `GRADLE :app:testDebugUnitTest --tests "app.markiro.handheld.feature.shift.SharedShiftRulesTest"`
      Expected: FAIL to compile (`SharedShiftRules` unresolved).

- [ ] **Step 3: Implement** `feature/shift/SharedShiftRules.kt`:

```kotlin
package app.markiro.handheld.feature.shift

import app.markiro.handheld.core.host.ShiftParticipation
import app.markiro.handheld.core.util.Iso

/** What the work screen's strip shows of a shared shift (plan 2b). `staleAtMillis` is non-null while the figures are the last known ones. */
data class SharedStrip(
    val mine: Int,
    val total: Int,
    val plan: Int?,
    val active: Int,
    val maxStations: Int,
    val staleAtMillis: Long?,
)

/**
 * The rules of a shift several devices work, as a handheld can apply them from the host's last answer. Pure and deterministic: the clock is an
 * argument. The reason rule mirrors `shift_participants::reason_need` of the host and is pinned by `shift-close-reason-shared.json`.
 */
object SharedShiftRules {
    /** How old the host's answer may be for this device to still believe it knows who else keeps the shift open (the beat is 15 s). */
    const val FRESH_MS = 90_000L

    /** The line allows several devices, or several have worked this shift. With one device and a limit of one nothing is shown or changed. */
    fun isShared(p: ShiftParticipation?): Boolean = p != null && ((p.maxStations ?: 1) >= 2 || p.participantsEver >= 2)

    fun isFresh(p: ShiftParticipation?, now: Long): Boolean = p != null && !p.stale && now - p.fetchedAt <= FRESH_MS

    /**
     * What the others delivered (the host's total less this device's own delivered share) plus everything this device has counted, delivered or not;
     * never below the device's own count.
     */
    fun shiftTotal(p: ShiftParticipation?, localAccepted: Int): Int {
        val accepted = p?.accepted ?: return localAccepted
        val others = (accepted - (p.myAccepted ?: 0L)).coerceAtLeast(0L)
        return (others + localAccepted).coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
    }

    /**
     * Whether this close should ask for a reason now. One device ever in the shift (or no figures, or an older host): stage 2a's rule on its own
     * count. A shared shift: only the last closer, only with fresh figures, by the shift-wide total against the plan; every other case closes
     * without a reason and the host marks a shared shift's missing one for the office.
     */
    fun reasonRequired(plan: Int?, localAccepted: Int, p: ShiftParticipation?, now: Long): Boolean {
        if (p == null || p.participantsEver <= 1) return ShiftCloser.reasonRequired(plan, localAccepted)
        if (p.othersOpen > 0) return false
        if (!isFresh(p, now)) return false
        return plan != null && plan != shiftTotal(p, localAccepted)
    }

    fun strip(p: ShiftParticipation?, localAccepted: Int, plan: Int?): SharedStrip? {
        if (p == null || !isShared(p)) return null
        return SharedStrip(
            mine = localAccepted,
            total = shiftTotal(p, localAccepted),
            plan = plan,
            active = p.active,
            maxStations = p.maxStations ?: p.participantsEver.coerceAtLeast(1),
            staleAtMillis = if (p.stale) p.asOf?.let(Iso::parse) ?: p.fetchedAt else null,
        )
    }
}
```

- [ ] **Step 4: Run the test to verify it passes.**
      Run: `GRADLE :app:testDebugUnitTest --tests "app.markiro.handheld.feature.shift.SharedShiftRulesTest"`
      Expected: PASS (5 tests). If `theReasonRuleIsTheHostsSharedFixture` fails on one case, the host's rule and this one differ: fix the rule, never the fixture.

- [ ] **Step 5: Commit.**

```bash
git -C "$WT" add apps/handheld/app/src/main/kotlin/app/markiro/handheld/feature/shift/SharedShiftRules.kt \
  apps/handheld/app/src/test/kotlin/app/markiro/handheld/feature/shift/SharedShiftRulesTest.kt
git -C "$WT" commit -m "feat(handheld): shift-wide total, strip model and reason need of a shared shift, pinned by the host fixture

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The backend seam keeps the participation, frees the slot and hides a closed part

**Files:**

- Modify: `core/backend/StationBackend.kt:23-37`
- Modify: `core/backend/HostBackend.kt:38-72` (constructor, `shifts`, `enter`; add `leave`), imports
- Modify: `core/host/HostShiftMapping.kt:21-41` (`toShiftDto`)
- Modify test: `app/src/test/kotlin/app/markiro/handheld/core/backend/HostBackendShiftsTest.kt` (helper `backend`, new tests)

**Interfaces:**

- Consumes: Tasks 2, 3, 4.
- Produces: `StationBackend.leave(shiftId)` (default no-op; the cloud has no slots); `HostBackend(… registry, participation: ShiftParticipationStore? = null, clock)`; after `shifts()`/`enter()`/`leave()` the store holds the host's figures; `DeviceShiftDto.toShiftDto` gives `status = "closed"` when `myState == "closed"`; `HostBackend.enter` does not cache the entry of a closed part for the bundle.

- [ ] **Step 1: Write the failing tests.** In `HostBackendShiftsTest.kt` add imports `app.markiro.handheld.core.host.ShiftParticipationStore`, `kotlinx.serialization.json.JsonArray`, `kotlinx.serialization.json.JsonObject`, `kotlinx.serialization.json.JsonPrimitive`, `kotlinx.serialization.json.Json`, `kotlinx.serialization.json.jsonArray`; **replace** the helper `backend` (`:85-93`) with

```kotlin
    private fun backend(routes: Routes, revoked: () -> Unit = {}, participation: ShiftParticipationStore? = null): HostBackend {
        val api = HostApi(routes)
        val pool = SsccPool(db)
        val supplier = HostBlockSupplier(db, MetaStore(db), api, pool, SsccBlockApplier(pool), requestId = { "req-${routes.posts.size}" })
        return HostBackend(
            api = { api }, config = db.deviceConfigDao(), db = db, supplier = supplier,
            calls = HostCalls { revoked() }, reference = null, operators = db.operatorDao(), participation = participation,
        )
    }

    private val participants = "device-shifts-participants.json"

    /** The host's shared-shift list with this device's own state replaced (the fixture is written from the station's side). */
    private fun listWithMyState(state: String): String {
        val shift = Json.parseToJsonElement(fixture(participants)).jsonObject.getValue("shifts").jsonArray[0].jsonObject
        return JsonObject(mapOf("shifts" to JsonArray(listOf(JsonObject(shift + ("myState" to JsonPrimitive(state))))))).toString()
    }

    private fun oneShift(): String = Json.parseToJsonElement(fixture(participants)).jsonObject.getValue("shifts").jsonArray[0].toString()
```

and append the tests:

```kotlin
    @Test
    fun theListKeepsEachSharedShiftsParticipationForTheStripAndTheCloseRule() = runTest {
        val store = ShiftParticipationStore(db)
        val routes = Routes(mutableMapOf("/v1/device/shifts" to ArrayDeque(listOf(ok(fixture(participants))))))
        val items = backend(routes, participation = store).shifts().items
        assertEquals("active", items.single().status)
        val p = checkNotNull(store.get(id))
        assertEquals(2, p.maxStations)
        assertEquals(547L, p.accepted)
    }

    @Test
    fun aPartThisDeviceClosedIsAClosedShiftForTheLoadersWhileTheShiftStaysOpenForTheOthers() = runTest {
        val store = ShiftParticipationStore(db)
        val routes = Routes(mutableMapOf("/v1/device/shifts" to ArrayDeque(listOf(ok(listWithMyState("closed"))))))
        val shift = backend(routes, participation = store).shifts().items.single()
        assertEquals("closed", shift.status)
        assertEquals("closed", store.get(id)!!.myState)
    }

    @Test
    fun aListOfAnOlderHostLeavesNothingBehind() = runTest {
        val store = ShiftParticipationStore(db)
        val routes = Routes(mutableMapOf("/v1/device/shifts" to ArrayDeque(listOf(ok(fixture("device-shifts.json"))))))
        backend(routes, participation = store).shifts()
        assertTrue(db.metaDao().withPrefix(ShiftParticipationStore.PREFIX).isEmpty())
    }

    @Test
    fun anEntryKeepsWhatTheHostSaidOfTheShiftAndAClosedPartGivesNoBundle() = runTest {
        val store = ShiftParticipationStore(db)
        val entered = Json.parseToJsonElement(fixture("device-shift-entered.json")).jsonObject
        val open = JsonObject(entered + ("maxStations" to JsonPrimitive(2)) + ("myState" to JsonPrimitive("active")))
        val closed = JsonObject(entered + ("maxStations" to JsonPrimitive(2)) + ("myState" to JsonPrimitive("closed")))
        val routes = Routes(mutableMapOf(shiftPath to ArrayDeque(listOf(ok(open.toString()), ok(closed.toString())))))
        val backend = backend(routes, participation = store)
        assertEquals("active", backend.enter(id, ShiftEntryRequest("list")).status)
        assertEquals("active", store.get(id)!!.myState)
        // The host read a closed part back: the shift is closed for this device and its snapshot is not kept for a bundle.
        assertEquals("closed", backend.enter(id, ShiftEntryRequest("list")).status)
        assertEquals("closed", store.get(id)!!.myState)
    }

    @Test
    fun aLeaveAsksTheHostAndKeepsWhatItAnswered() = runTest {
        val store = ShiftParticipationStore(db)
        val leavePath = "/v1/device/shifts/$id/leave"
        val routes = Routes(mutableMapOf(leavePath to ArrayDeque(listOf(ok(oneShift())))))
        backend(routes, participation = store).leave(id)
        assertEquals(listOf(leavePath to ""), routes.posts)
        assertEquals(2, store.get(id)!!.maxStations)
        // A host that holds no slot of this device is a refusal the caller reads; nothing is kept.
        val refused = Routes(mutableMapOf(leavePath to ArrayDeque(listOf(refusal(409, "conflict", """{"constraint":"shift_not_entered"}""")))))
        val error = runCatching { backend(refused).leave(id) }.exceptionOrNull() as HttpException
        assertEquals(409, error.code())
    }
```

- [ ] **Step 2: Run them to verify they fail.**
      Run: `GRADLE :app:testDebugUnitTest --tests "app.markiro.handheld.core.backend.HostBackendShiftsTest"`
      Expected: FAIL to compile (`participation =`, `leave` unresolved).

- [ ] **Step 3: Implement.** `StationBackend.kt`: add inside the interface, after `hubCounts`:

```kotlin
    /**
     * Frees this device's slot of a shift several devices may work (plan 2b). The cloud has no slots, so the default does nothing; the host
     * answers `POST /v1/device/shifts/{id}/leave`. Throws what the other calls throw (`IOException`, `HttpException`).
     */
    suspend fun leave(shiftId: String) = Unit
```

`HostShiftMapping.kt`: in `toShiftDto` replace the line `status = status,` with

```kotlin
    // This device closed its part: for it the shift is closed (it must not be worked, and the list and the hub card drop it), whatever the others do.
    status = if (myState == "closed") "closed" else status,
```

`HostBackend.kt`: add import `app.markiro.handheld.core.host.ShiftParticipationStore`; replace the constructor tail `    private val registry: HostBoxRegistry? = null,\n    private val clock: () -> Long = System::currentTimeMillis,\n) : StationBackend by NoBackend {` with

```kotlin
    private val registry: HostBoxRegistry? = null,
    /** Where the host's figures of shared shifts are kept (plan 2b); `null` in the tests of the older flows. */
    private val participation: ShiftParticipationStore? = null,
    private val clock: () -> Long = System::currentTimeMillis,
) : StationBackend by NoBackend {
```

and replace `shifts()` and `enter()` (`:61-72`) with

```kotlin
    override suspend fun shifts(): ShiftListResponse {
        // The office may have assigned (or changed) this device's line since it was paired: the list is of the line the host knows now.
        reference?.refreshDevice()
        val line = config.get()?.lineName
        val listed = calls.run { api().shifts() }.shifts
        participation?.save(listed)
        return ShiftListResponse(listed.map { it.toShiftDto(line) })
    }

    override suspend fun enter(shiftId: String, body: ShiftEntryRequest): ShiftDto {
        val entered = calls.run { api().enter(shiftId) }
        participation?.save(entered)
        // A closed part is read back without a bundle to work: nothing to keep for `bundle`.
        if (entered.myState != "closed") entries[shiftId] = entered
        return entered.toShiftDto(config.get()?.lineName)
    }

    override suspend fun leave(shiftId: String) {
        participation?.save(calls.run { api().leave(shiftId) })
    }
```

- [ ] **Step 4: Run the tests to verify they pass.**
      Run: `GRADLE :app:testDebugUnitTest --tests "app.markiro.handheld.core.backend.*" --tests "app.markiro.handheld.core.host.HostBackendPalletsTest" --tests "app.markiro.handheld.feature.shift.ShiftRepositoryHostTest"`
      Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git -C "$WT" add apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/backend/StationBackend.kt \
  apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/backend/HostBackend.kt \
  apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/host/HostShiftMapping.kt \
  apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/backend/HostBackendShiftsTest.kt
git -C "$WT" commit -m "feat(handheld): keep the host's figures of a shared shift, free the slot on leave, treat a closed part as closed

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The heartbeat reads the totals and sends owed leaves

**Files:**

- Create: `core/host/HostParticipation.kt`
- Modify: `core/host/HostHeartbeat.kt:16-42`
- Modify: `core/host/HostModule.kt:104-114`, `:120-132`, add providers
- Create tests: `app/src/test/kotlin/app/markiro/handheld/core/host/HostParticipationTest.kt`; modify `HostHeartbeatTest.kt` (one new test)

**Interfaces:**

- Consumes: Tasks 3, 4, 6; `HostCalls`, `DeviceConfigDao`, `ShiftDao.get`.
- Produces: `class HostParticipation(db, api: () -> HostApi, calls, store, config)` with `suspend fun beat()`, `suspend fun refresh(): Boolean`, `suspend fun markStale()`; `HostHeartbeat(… meta, participation: suspend () -> Unit = {}, participationStale: suspend () -> Unit = {}, device: suspend () -> Unit = {})` (new parameters sit before `device`, so the existing trailing-lambda call stays valid); Hilt providers `ShiftParticipationStore`, `HostParticipation`.

- [ ] **Step 1: Write the failing tests.** Create `HostParticipationTest.kt`:

```kotlin
package app.markiro.handheld.core.host

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.network.host.HostApi
import app.markiro.handheld.core.network.host.HostResult
import app.markiro.handheld.core.network.host.HostTransport
import app.markiro.handheld.core.network.host.TransportFailure
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.initializeRecoveryForTest
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class HostParticipationTest {
    private lateinit var db: HandheldDatabase
    private val shift = HostFactsFixtures.SHIFT
    private val me = "00000000-0000-4000-8000-000000000001"
    private val listPath = "/v1/device/shifts"
    private val leavePath = "/v1/device/shifts/$shift/leave"

    /** Exact paths, answers in order; a path with nothing scripted fails the test. */
    private class Exact(val answers: MutableMap<String, ArrayDeque<HostResult>>) : HostTransport {
        val requests = mutableListOf<String>()
        override suspend fun get(path: String): HostResult = next("GET", path)
        override suspend fun post(path: String, body: String): HostResult = next("POST", path)
        private fun next(method: String, path: String): HostResult {
            requests += "$method $path"
            return (answers[path] ?: error("nothing scripted for $method $path")).removeFirst()
        }
    }

    @Before
    fun open() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java).allowMainThreadQueries().build()
        kotlinx.coroutines.runBlocking { db.deviceConfigDao().upsert(HostFactsFixtures.config(db).copy(activeShiftId = shift)) }
        db.initializeRecoveryForTest()
    }

    @After
    fun close() = db.close()

    private fun fixture(name: String) = checkNotNull(javaClass.classLoader?.getResource(name)) { name }.readText()
    private fun ok(body: String) = HostResult.Ok(200, body, null)
    private fun listBody() = fixture("device-shifts-participants.json")
    private fun oneShift() = Json.parseToJsonElement(listBody()).jsonObject.getValue("shifts").jsonArray[0].toString()
    private fun store() = ShiftParticipationStore(db, myDeviceId = { me })

    private fun participation(transport: Exact) =
        HostParticipation(db, { HostApi(transport) }, HostCalls { }, store(), db.deviceConfigDao())

    @Test
    fun aBeatWhileAShiftIsWorkedReadsTheListAndKeepsItsFigures() = runTest {
        val transport = Exact(mutableMapOf(listPath to ArrayDeque(listOf(ok(listBody())))))
        participation(transport).beat()
        assertEquals(listOf("GET $listPath"), transport.requests)
        assertEquals(547L, store().get(shift)!!.accepted)
    }

    @Test
    fun aBeatWithNoShiftBeingWorkedAsksNothing() = runTest {
        db.deviceConfigDao().get()!!.let { db.deviceConfigDao().upsert(it.copy(activeShiftId = null)) }
        val transport = Exact(mutableMapOf())
        participation(transport).beat()
        assertEquals(emptyList<String>(), transport.requests)
    }

    @Test
    fun aCloudDeviceIsNeverAskedAnything() = runTest {
        db.deviceConfigDao().get()!!.let { db.deviceConfigDao().upsert(it.copy(backend = "cloud")) }
        val transport = Exact(mutableMapOf())
        val p = participation(transport)
        p.beat()
        assertFalse(p.refresh())
        assertEquals(emptyList<String>(), transport.requests)
    }

    @Test
    fun aHostThatDoesNotAnswerMarksTheWorkedShiftsFiguresStale() = runTest {
        store().save(Json { ignoreUnknownKeys = true }.decodeFromString(app.markiro.handheld.core.network.host.DeviceShiftsDto.serializer(), listBody()).shifts)
        val transport = Exact(mutableMapOf(listPath to ArrayDeque(listOf(HostResult.Failed(TransportFailure.UNREACHABLE)))))
        val p = participation(transport)
        assertFalse(p.refresh())
        assertTrue(store().get(shift)!!.stale)
        // The next answer clears it.
        transport.answers[listPath] = ArrayDeque(listOf(ok(listBody())))
        assertTrue(p.refresh())
        assertFalse(store().get(shift)!!.stale)
    }

    @Test
    fun markStaleIsWhatABeatThatNeverReachedTheHostDoes() = runTest {
        store().save(Json { ignoreUnknownKeys = true }.decodeFromString(app.markiro.handheld.core.network.host.DeviceShiftsDto.serializer(), listBody()).shifts)
        participation(Exact(mutableMapOf())).markStale()
        assertTrue(store().get(shift)!!.stale)
    }

    @Test
    fun anOwedLeaveIsSentWhileTheDeviceIsStillOutAndThenForgotten() = runTest {
        db.shiftDao().upsert(HostFactsFixtures.shift().copy(leftAt = 5L))
        store().markLeavePending(shift)
        val transport = Exact(mutableMapOf(leavePath to ArrayDeque(listOf(ok(oneShift()))), listPath to ArrayDeque(listOf(ok(listBody())))))
        participation(transport).beat()
        assertEquals(listOf("POST $leavePath", "GET $listPath"), transport.requests)
        assertEquals(emptyList<String>(), store().pendingLeaves())
        assertNotNull(store().get(shift))
    }

    @Test
    fun anOwedLeaveOfAShiftTheDeviceEnteredAgainIsDroppedNotSent() = runTest {
        db.shiftDao().upsert(HostFactsFixtures.shift().copy(leftAt = null))
        store().markLeavePending(shift)
        val transport = Exact(mutableMapOf(listPath to ArrayDeque(listOf(ok(listBody())))))
        participation(transport).beat()
        assertEquals(listOf("GET $listPath"), transport.requests)
        assertEquals(emptyList<String>(), store().pendingLeaves())
    }

    @Test
    fun anOwedLeaveStaysOwedWhileTheHostIsNotReachedAndIsDroppedWhenTheHostHoldsNoSlot() = runTest {
        db.shiftDao().upsert(HostFactsFixtures.shift().copy(leftAt = 5L))
        store().markLeavePending(shift)
        val down = Exact(mutableMapOf(leavePath to ArrayDeque(listOf(HostResult.Failed(TransportFailure.TIMEOUT))), listPath to ArrayDeque(listOf(HostResult.Failed(TransportFailure.TIMEOUT)))))
        participation(down).beat()
        assertEquals(listOf(shift), store().pendingLeaves())
        val refused = HostResult.Ok(409, """{"error":{"code":"conflict","message":"m","details":{"constraint":"shift_not_entered"}}}""", null)
        val held = Exact(mutableMapOf(leavePath to ArrayDeque(listOf(refused)), listPath to ArrayDeque(listOf(ok(listBody())))))
        participation(held).beat()
        assertEquals(emptyList<String>(), store().pendingLeaves())
        assertNull(db.metaDao().get(ShiftParticipationStore.leaveKey(shift)))
    }
}
```

In `HostHeartbeatTest.kt` append inside the class:

```kotlin
    @Test
    fun aBeatThatReachedTheHostReadsParticipationAndOneThatDidNotMarksItStale() = runTest {
        var read = 0
        var stale = 0
        fun beat(transport: HostPalletFixtures.Routes) {
            val api = HostApi(transport)
            val pool = SsccPool(db)
            runBlocking {
                HostHeartbeat(
                    db, monitor, { api }, db.deviceConfigDao(), HostBlockSupplier(db, meta, api, pool, SsccBlockApplier(pool)), meta,
                    participation = { read++ }, participationStale = { stale++ },
                ).beat()
            }
        }
        beat(routes("/v1/hello" to listOf(hello("e1"))))
        assertEquals(1 to 0, read to stale)
        beat(routes("/v1/hello" to listOf(HostResult.Failed(TransportFailure.UNREACHABLE))))
        assertEquals(1 to 1, read to stale)
    }
```

- [ ] **Step 2: Run them to verify they fail.**
      Run: `GRADLE :app:testDebugUnitTest --tests "app.markiro.handheld.core.host.HostParticipationTest" --tests "app.markiro.handheld.core.host.HostHeartbeatTest"`
      Expected: FAIL to compile (`HostParticipation`, `participation =` unresolved).

- [ ] **Step 3: Implement** `core/host/HostParticipation.kt`:

```kotlin
package app.markiro.handheld.core.host

import app.markiro.handheld.core.network.host.HostApi
import app.markiro.handheld.core.storage.DeviceConfigDao
import app.markiro.handheld.core.storage.HandheldDatabase
import retrofit2.HttpException
import java.io.IOException

/**
 * What the heartbeat does for shifts several devices work (plan 2b): sends the leaves still owed to the host, and, while a shift is this device's
 * active one, reads the host's list again so the strip's shift-wide figures follow the others' scans (a scan takes no host revision, so there is nothing
 * to wait for: the beat is the poll, every 15 s). Nothing here runs for a cloud device.
 */
class HostParticipation(
    private val db: HandheldDatabase,
    private val api: () -> HostApi,
    private val calls: HostCalls,
    private val store: ShiftParticipationStore = ShiftParticipationStore(db),
    private val config: DeviceConfigDao = db.deviceConfigDao(),
) {
    /** One beat that reached the host. A failure of either part is that part's: the next beat repeats it. */
    suspend fun beat() {
        val cfg = config.get() ?: return
        if (cfg.backend != "host") return
        flushLeaves()
        if (cfg.activeShiftId != null) refresh()
    }

    /** One beat that did not reach the host: the figures of the shift being worked are the last known ones. */
    suspend fun markStale() {
        val cfg = config.get() ?: return
        if (cfg.backend != "host") return
        cfg.activeShiftId?.let { store.markStale(it) }
    }

    /** Reads the host's shift list into the store. `true` when the host answered; `false` marks the worked shift's figures stale. */
    suspend fun refresh(): Boolean {
        val cfg = config.get() ?: return false
        if (cfg.backend != "host") return false
        return try {
            store.save(calls.run { api().shifts() }.shifts)
            true
        } catch (_: IOException) {
            cfg.activeShiftId?.let { store.markStale(it) }
            false
        } catch (_: HttpException) {
            false
        }
    }

    /**
     * A leave is sent only while the local row still says the device is out: an entry since (online or offline) writes `leftAt = null` and the owed leave
     * is dropped, so a late leave never undoes a re-entry. The host refusing (`shift_not_entered`, a closed or unknown shift) means it holds no slot of this
     * device: nothing is owed. No answer keeps it owed; the pass stops there (the host is not reached).
     */
    private suspend fun flushLeaves() {
        for (shiftId in store.pendingLeaves()) {
            val row = db.shiftDao().get(shiftId)
            if (row == null || row.leftAt == null) {
                store.clearLeavePending(shiftId)
                continue
            }
            try {
                store.save(calls.run { api().leave(shiftId) })
                store.clearLeavePending(shiftId)
            } catch (_: HttpException) {
                store.clearLeavePending(shiftId)
            } catch (_: IOException) {
                return
            }
        }
    }
}
```

`HostHeartbeat.kt`: replace the class declaration header and `beat()` (`:16-42`) with

```kotlin
class HostHeartbeat(
    private val db: HandheldDatabase,
    private val monitor: HostLinkMonitor,
    private val api: () -> HostApi,
    private val config: DeviceConfigDao,
    private val blocks: HostBlockSupplier,
    private val meta: MetaStore,
    /** What a beat that reached the host also does for shared shifts: sends the leaves still owed and reads the worked shift's figures (plan 2b). */
    private val participation: suspend () -> Unit = {},
    /** What a beat that did not reach the host does: marks those figures stale. */
    private val participationStale: suspend () -> Unit = {},
    /** What a beat that reached the host also does: reads the device's own record again (its line may have been assigned or changed). */
    private val device: suspend () -> Unit = {},
) {
    suspend fun beat() {
        if (config.get()?.backend != "host") return
        try {
            db.recovery.work {
                monitor.heartbeat(api(), config, beforeRestore = { hello ->
                    if (db.recovery.observeHostDataset(hello.hostId, hello.datasetEpoch)) throw RecoveryBlocked()
                }) { blocks.registerKnown() }.onSuccess { observation ->
                    if (observation.restored) meta.remove(MetaStore.BOX_REGISTRY_UNTIL)
                    // A failure of either read is not the link's: the shift list asks again.
                    runCatching { device() }.onFailure { if (it is kotlinx.coroutines.CancellationException) throw it }
                    runCatching { participation() }.onFailure { if (it is kotlinx.coroutines.CancellationException) throw it }
                }.onFailure {
                    runCatching { participationStale() }.onFailure { e -> if (e is kotlinx.coroutines.CancellationException) throw e }
                }
            }
        } catch (_: RecoveryBlocked) {
            // The device is being paired again: the next beat finds its owner.
        }
    }
}
```

(keep the file's class doc comment above the class as it is, and append «Plan 2b: it also sends owed leaves and refreshes the shared-shift figures, or marks them stale when the host did not answer.»)

`HostModule.kt`: add imports `app.markiro.handheld.core.network.host.HostApi` (present) and nothing else new except the two classes (same package). Add providers before `hostHeartbeat`:

```kotlin
    @Provides
    @Singleton
    fun shiftParticipationStore(db: HandheldDatabase): ShiftParticipationStore = ShiftParticipationStore(db)

    @Provides
    @Singleton
    fun hostParticipation(db: HandheldDatabase, api: HostApi, revocation: HostRevocation, config: DeviceConfigDao, store: ShiftParticipationStore): HostParticipation =
        HostParticipation(db, { api }, HostCalls(revocation::current) { revocation.reject(it) }, store, config)
```

replace the `hostHeartbeat` provider (`:104-114`) with

```kotlin
    @Provides
    @Singleton
    fun hostHeartbeat(
        db: HandheldDatabase,
        monitor: HostLinkMonitor,
        api: HostApi,
        config: DeviceConfigDao,
        blocks: HostBlockSupplier,
        meta: MetaStore,
        reference: HostReferenceSync,
        participation: HostParticipation,
    ): HostHeartbeat = HostHeartbeat(
        db, monitor, { api }, config, blocks, meta,
        participation = participation::beat, participationStale = participation::markStale,
    ) { reference.refreshDevice() }
```

and add `store: ShiftParticipationStore` as the last parameter of `hostBackend` with `participation = store` appended to the `HostBackend(...)` call:

```kotlin
        registry: HostBoxRegistry,
        store: ShiftParticipationStore,
    ): HostBackend = HostBackend({ api }, config, db, supplier, HostCalls(revocation::current) { revocation.reject(it) }, reference, operators, orgPrint, registry, store)
```

- [ ] **Step 4: Run the tests to verify they pass.**
      Run: `GRADLE :app:testDebugUnitTest --tests "app.markiro.handheld.core.host.*" --tests "app.markiro.handheld.core.storage.HostDatasetResetTest"`
      Expected: PASS. Then compile the Hilt graph: `GRADLE :app:compileDebugKotlin :app:kaptDebugKotlin` (or `:app:kspDebugKotlin` if the module uses KSP; use whichever task `GRADLE :app:tasks --all | grep -i "kapt\|ksp"` lists). Expected: BUILD SUCCESSFUL (a missing provider is a Dagger error here).

- [ ] **Step 5: Commit.**

```bash
git -C "$WT" add apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/host/HostParticipation.kt \
  apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/host/HostHeartbeat.kt \
  apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/host/HostModule.kt \
  apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/host/HostParticipationTest.kt \
  apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/host/HostHeartbeatTest.kt
git -C "$WT" commit -m "feat(handheld): the heartbeat reads the shared shift's totals and sends owed leaves

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Entering a shared shift: a full line, an old host's busy, a closed part

**Files:**

- Modify: `feature/shift/ShiftRepository.kt:26-40` (`EnterResult`), `:205-224` (`enterOwned`), `:268-276` (`refusal`), `:330-331` (`errorCode`), top-level constants
- Modify: `feature/shift/ShiftListViewModel.kt:33-46`, `:286-307`
- Modify: `feature/shift/ShiftDialogScreen.kt:30-125`
- Modify: `feature/hub/HubViewModel.kt:344-362`
- Modify: `res/values/strings.xml`, `res/values-en/strings.xml`
- Modify tests: `feature/shift/ShiftRepositoryHostTest.kt`, `feature/shift/ShiftListScreenTest.kt`, `feature/hub/HubViewModelTest.kt`; `app/src/test/kotlin/app/markiro/handheld/EnglishRenderTest.kt`

**Interfaces:**

- Consumes: Task 3 (`ErrorBody` numbers, refusal codes), Task 6 (closed part is `status == "closed"`).
- Produces: `EnterResult.LineFull(active: Int, maxStations: Int)`, `EnterResult.Busy`, `EnterResult.PartClosed`; the same three as `ShiftDialog`; strings `shifts_line_full_title/_text`, `shifts_busy_title/_text`, `shifts_part_closed_title/_text`.

- [ ] **Step 1: Write the failing tests.** In `ShiftRepositoryHostTest.kt` add imports `kotlinx.serialization.json.JsonObject`, `kotlinx.serialization.json.JsonPrimitive`, `kotlinx.serialization.json.jsonObject`, `kotlinx.serialization.json.Json` (present), and append:

```kotlin
    private fun refusal(body: String) = HostResult.Ok(409, body, null)
    private fun enterPath() = "/v1/device/shifts/$id/enter"

    @Test
    fun aFullLineIsReportedWithItsNumbersAndNothingIsEntered() = runTest {
        val script = Script(emptyMap(), mutableMapOf(enterPath() to ArrayDeque(listOf(refusal(fixture("error-shift-line-full.json"))))))
        assertEquals(EnterResult.LineFull(active = 2, maxStations = 2), repository(script).enter(id))
        assertEquals(null, db.deviceConfigDao().get()!!.activeShiftId)
    }

    @Test
    fun anOldHostsBusyIsSaidInWordsAndIsNotAGenericRefusal() = runTest {
        val script = Script(emptyMap(), mutableMapOf(enterPath() to ArrayDeque(listOf(refusal(fixture("error-shift-busy.json"))))))
        assertEquals(EnterResult.Busy, repository(script).enter(id))
    }

    @Test
    fun aFullLineWhoseNumbersAreMissingFallsBackToBusy() = runTest {
        val body = """{"error":{"code":"conflict","message":"m","details":{"constraint":"shift_line_full"}}}"""
        assertEquals(EnterResult.Busy, repository(Script(emptyMap(), mutableMapOf(enterPath() to ArrayDeque(listOf(refusal(body)))))).enter(id))
    }

    @Test
    fun aClosedPartIsNeverEnteredAndItsShiftIsClosedOnThisDevice() = runTest {
        db.shiftDao().upsert(app.markiro.handheld.feature.shift.ShiftEntityFixtures.bundled(id))
        db.deviceConfigDao().get()!!.let { db.deviceConfigDao().upsert(it.copy(activeShiftId = id)) }
        val entered = Json.parseToJsonElement(fixture("device-shift-entered.json")).jsonObject
        val closedPart = JsonObject(entered + ("myState" to JsonPrimitive("closed")) + ("maxStations" to JsonPrimitive(2)))
        // Only the entry is scripted: a request for the bundle's blocks would fail the test.
        val script = Script(emptyMap(), mutableMapOf(enterPath() to ArrayDeque(listOf(ok(closedPart.toString())))))
        assertEquals(EnterResult.PartClosed, repository(script).enter(id))
        assertEquals("closed", db.shiftDao().get(id)!!.status)
        assertEquals(null, db.deviceConfigDao().get()!!.activeShiftId)
    }
```

In `ShiftListScreenTest.kt` add imports `androidx.compose.ui.test.assertDoesNotExist` and append:

```kotlin
    private fun dialogUi(dialog: ShiftDialog) = ShiftListUi(
        loading = false, continueShift = null, mine = emptyList(), others = emptyList(), othersExpanded = false, othersLoading = false,
        listFetchedAt = 0L, reachable = true, ownLineName = "Линия 2", dialog = dialog,
    )

    @Test
    fun aFullLineSaysHowManyDevicesWorkItAndOffersNoWayIn() {
        var dismissed = false
        compose.setContent { MarkiroTheme { ShiftListScreen(dialogUi(ShiftDialog.LineFull(active = 2, maxStations = 2)), ShiftListCallbacks(onDismiss = { dismissed = true })) } }
        compose.onNodeWithText("Линия занята").assertIsDisplayed()
        compose.onNodeWithText("На линии уже работают 2 из 2 устройств", substring = true).assertIsDisplayed()
        compose.onNodeWithText("Войти").assertDoesNotExist()
        compose.onNodeWithText("Понятно").performClick()
        assertEquals(true, dismissed)
    }

    @Test
    fun anOldHostsBusyAndAClosedPartAreSaidInWords() {
        compose.setContent { MarkiroTheme { ShiftListScreen(dialogUi(ShiftDialog.Busy), ShiftListCallbacks()) } }
        compose.onNodeWithText("Смена занята").assertIsDisplayed()
        compose.onNodeWithText("Сервер отказал").assertDoesNotExist()
    }

    @Test
    fun aClosedPartSaysYouAlreadyClosedIt() {
        compose.setContent { MarkiroTheme { ShiftListScreen(dialogUi(ShiftDialog.PartClosed), ShiftListCallbacks()) } }
        compose.onNodeWithText("Ваша часть закрыта").assertIsDisplayed()
    }
```

In `HubViewModelTest.kt`, after `aRefusedContinueShowsTheSameDialogAsTheList`, add:

```kotlin
    @Test
    fun aFullLineOnContinueShowsTheLineFullDialog() = runTest {
        db.shiftDao().upsert(ShiftEntityFixtures.bundled("s1"))
        db.deviceConfigDao().upsert(paired.copy(activeShiftId = "s1"))
        val api = api(enter = {
            throw retrofit2.HttpException(
                retrofit2.Response.error<ShiftDto>(
                    409, okhttp3.ResponseBody.create(null, """{"code":"shift_line_full","maxStations":2,"active":2}"""),
                ),
            )
        })
        val model = vm(api, repository = repository(api))
        model.state.first { it.activeShiftId == "s1" }
        model.continueShift()
        assertEquals(
            app.markiro.handheld.feature.shift.ShiftDialog.LineFull(active = 2, maxStations = 2),
            model.state.first { it.dialog != null && it.dialog != app.markiro.handheld.feature.shift.ShiftDialog.Entering }.dialog,
        )
    }
```

In `EnglishRenderTest.kt` add imports `app.markiro.handheld.feature.shift.ShiftDialog`, `app.markiro.handheld.feature.shift.ShiftDialogScreen` and append:

```kotlin
    @Test
    fun theSharedShiftEntryDialogsRenderInEnglish() {
        for (dialog in listOf(ShiftDialog.LineFull(active = 2, maxStations = 2), ShiftDialog.Busy, ShiftDialog.PartClosed)) {
            compose.setContent { MarkiroTheme { ShiftDialogScreen(dialog, "Line 2", onDismiss = {}, onRetry = {}) } }
            assertNoCyrillic()
        }
    }
```

- [ ] **Step 2: Run them to verify they fail.**
      Run: `GRADLE :app:testDebugUnitTest --tests "app.markiro.handheld.feature.shift.ShiftRepositoryHostTest" --tests "app.markiro.handheld.feature.shift.ShiftListScreenTest" --tests "app.markiro.handheld.feature.hub.HubViewModelTest" --tests "app.markiro.handheld.EnglishRenderTest"`
      Expected: FAIL to compile (`EnterResult.LineFull`, `ShiftDialog.LineFull` unresolved).

- [ ] **Step 3: Strings.** In `res/values/strings.xml` replace `    <string name="host_dataset_reset_close">Закрыть приложение</string>\n</resources>` with

```xml
    <string name="host_dataset_reset_close">Закрыть приложение</string>
    <string name="shifts_line_full_title">Линия занята</string>
    <string name="shifts_line_full_text">На линии уже работают %1$d из %2$d устройств. Войти можно, когда одно из них выйдет из смены.</string>
    <string name="shifts_busy_title">Смена занята</string>
    <string name="shifts_busy_text">Эту смену ведёт другое устройство, а эта версия сервера не пускает второе. Обновите сервер на площадке или дождитесь закрытия смены.</string>
    <string name="shifts_part_closed_title">Ваша часть закрыта</string>
    <string name="shifts_part_closed_text">Это устройство уже закрыло свою часть смены, продолжать работу в ней нельзя. Смена закроется, когда закроют остальные.</string>
</resources>
```

and in `res/values-en/strings.xml` replace `    <string name="host_dataset_reset_close">Close application</string>\n</resources>` with

```xml
    <string name="host_dataset_reset_close">Close application</string>
    <string name="shifts_line_full_title">The line is full</string>
    <string name="shifts_line_full_text">%1$d of %2$d devices are already working on this line. You can join when one of them leaves the shift.</string>
    <string name="shifts_busy_title">The shift is taken</string>
    <string name="shifts_busy_text">Another device works this shift, and this server version does not admit a second one. Update the server on the site or wait for the shift to close.</string>
    <string name="shifts_part_closed_title">Your part is closed</string>
    <string name="shifts_part_closed_text">This device has already closed its part of the shift and cannot work in it any more. The shift closes when the others close theirs.</string>
</resources>
```

- [ ] **Step 4: Implement the enter results.** `ShiftRepository.kt`:

Add `import app.markiro.handheld.core.network.ErrorBody` (already imported) and replace the `EnterResult` interface body's tail — after `data object Unavailable : EnterResult` add:

```kotlin
    /** Every slot of the line is held by another device (`409 shift_line_full`, host protocol 7): the two numbers are the host's. */
    data class LineFull(val active: Int, val maxStations: Int) : EnterResult

    /** An older host (before several devices in one shift) says another device works this shift (`409 shift_busy`). */
    data object Busy : EnterResult

    /** This device closed its part of the shift: the host reads it back, nothing is entered and no bundle is fetched. */
    data object PartClosed : EnterResult
```

Add near the top of the file (below imports):

```kotlin
private const val LINE_FULL_CODE = "shift_line_full"
private const val BUSY_CODE = "shift_busy"
```

In `enterOwned`, after the `val entered = try { … } catch … ` block (before `val bundle = try {`) insert:

```kotlin
        // A host that read a closed part back (`myState: closed`) answers the shift as closed for this device: working it again would only make late facts.
        if (entered.status == "closed") {
            db.recovery.commit {
                db.shiftDao().setStatus(shiftId, "closed")
                db.deviceConfigDao().get()?.let { if (it.activeShiftId == shiftId) db.deviceConfigDao().upsert(it.copy(activeShiftId = null)) }
            }
            return EnterResult.PartClosed
        }
```

Replace `refusal` and `errorCode` (`:268-276` and `:330-331`) with

```kotlin
    private fun refusal(step: EnterStep, e: HttpException): EnterResult {
        val body = errorBody(e)
        val code = body?.code
        return when {
            e.code() == 409 && code == UPDATE_REQUIRED_CODE -> EnterResult.UpdateRequired
            e.code() == 409 && code == LINE_FULL_CODE -> {
                val active = body?.active
                val max = body?.maxStations
                // A host that names the refusal but not its numbers is still saying the shift cannot be joined now.
                if (active != null && max != null) EnterResult.LineFull(active, max) else EnterResult.Busy
            }
            e.code() == 409 && code == BUSY_CODE -> EnterResult.Busy
            e.code() == 409 && code == null -> EnterResult.Closed
            e.code() in 400..499 -> EnterResult.Refused(step, e.code(), code)
            else -> EnterResult.Unavailable
        }
    }
```

and at the old `errorCode` position

```kotlin
    /** The body is read once (a response body can be consumed only once): the code and, for a full line, its two numbers. */
    private fun errorBody(e: HttpException): ErrorBody? =
        runCatching { json.decodeFromString(ErrorBody.serializer(), e.response()?.errorBody()?.string().orEmpty()) }.getOrNull()
```

(keep the `refusal` doc comment above it; delete the old `errorCode` function.)

`ShiftListViewModel.kt`: add to `ShiftDialog` after `data object Unavailable : ShiftDialog`:

```kotlin
    data class LineFull(val active: Int, val maxStations: Int) : ShiftDialog
    data object Busy : ShiftDialog
    data object PartClosed : ShiftDialog
```

and in `enter` (`:289-305`) add before `is EnterResult.Refused -> {`:

```kotlin
                // All three are also refreshed: the host's answer says the list is behind (a slot taken, a part closed elsewhere).
                is EnterResult.LineFull -> {
                    dialog.value = ShiftDialog.LineFull(result.active, result.maxStations)
                    repository.refreshList()
                }
                EnterResult.Busy -> {
                    dialog.value = ShiftDialog.Busy
                    repository.refreshList()
                }
                EnterResult.PartClosed -> {
                    dialog.value = ShiftDialog.PartClosed
                    repository.refreshList()
                }
```

`HubViewModel.kt` `continueShift` (`:358`): before `is app.markiro.handheld.feature.shift.EnterResult.Refused -> {` add

```kotlin
                    is app.markiro.handheld.feature.shift.EnterResult.LineFull -> {
                        dialog.value = app.markiro.handheld.feature.shift.ShiftDialog.LineFull(result.active, result.maxStations)
                        recovery.work { repository.refreshList() }
                    }
                    app.markiro.handheld.feature.shift.EnterResult.Busy -> {
                        dialog.value = app.markiro.handheld.feature.shift.ShiftDialog.Busy
                        recovery.work { repository.refreshList() }
                    }
                    app.markiro.handheld.feature.shift.EnterResult.PartClosed -> {
                        dialog.value = app.markiro.handheld.feature.shift.ShiftDialog.PartClosed
                        recovery.work { repository.refreshList() }
                    }
```

`ShiftDialogScreen.kt`: add before `ShiftDialog.BarcodeUnknown -> {`:

```kotlin
        is ShiftDialog.LineFull -> {
            AppBar(stringResource(R.string.shifts_title), onDismiss)
            FullScreenState(
                Icons.Outlined.Factory,
                stringResource(R.string.shifts_line_full_title),
                stringResource(R.string.shifts_line_full_text, dialog.active, dialog.maxStations),
                primary = StateAction(stringResource(R.string.common_got_it), onDismiss),
                tone = Tone.Warn,
                primaryIsAccent = false,
            )
        }
        ShiftDialog.Busy -> {
            AppBar(stringResource(R.string.shifts_title), onDismiss)
            FullScreenState(
                Icons.Outlined.Factory,
                stringResource(R.string.shifts_busy_title),
                stringResource(R.string.shifts_busy_text),
                primary = StateAction(stringResource(R.string.common_got_it), onDismiss),
                tone = Tone.Warn,
                primaryIsAccent = false,
            )
        }
        ShiftDialog.PartClosed -> {
            AppBar(stringResource(R.string.shifts_title), onDismiss)
            FullScreenState(
                Icons.Outlined.Factory,
                stringResource(R.string.shifts_part_closed_title),
                stringResource(R.string.shifts_part_closed_text),
                primary = StateAction(stringResource(R.string.common_got_it), onDismiss),
                primaryIsAccent = false,
            )
        }
```

and extend the doc comment of `ShiftDialogScreen` («…and the four refusals») with «, a full line, an old host's busy and a closed part».

- [ ] **Step 5: Run the tests to verify they pass.**
      Run: the Step 2 command plus `--tests "app.markiro.handheld.feature.shift.*"` (the existing `ShiftRepositoryTest`, `ShiftListScanTest` exercise `refusal` for the cloud's `STATION_UPDATE_REQUIRED`, codeless 409 and 4xx; they must stay green) and `--tests "app.markiro.handheld.feature.hub.*"`.
      Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git -C "$WT" add apps/handheld/app/src/main/kotlin/app/markiro/handheld/feature/shift/ShiftRepository.kt \
  apps/handheld/app/src/main/kotlin/app/markiro/handheld/feature/shift/ShiftListViewModel.kt \
  apps/handheld/app/src/main/kotlin/app/markiro/handheld/feature/shift/ShiftDialogScreen.kt \
  apps/handheld/app/src/main/kotlin/app/markiro/handheld/feature/hub/HubViewModel.kt \
  apps/handheld/app/src/main/res/values/strings.xml apps/handheld/app/src/main/res/values-en/strings.xml \
  apps/handheld/app/src/test/kotlin/app/markiro/handheld/feature/shift/ShiftRepositoryHostTest.kt \
  apps/handheld/app/src/test/kotlin/app/markiro/handheld/feature/shift/ShiftListScreenTest.kt \
  apps/handheld/app/src/test/kotlin/app/markiro/handheld/feature/hub/HubViewModelTest.kt \
  apps/handheld/app/src/test/kotlin/app/markiro/handheld/EnglishRenderTest.kt
git -C "$WT" commit -m "feat(handheld): say a full line, an old host's busy and a closed part in words when entering a shift

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Leave frees the slot (pause), online or owed

**Files:**

- Modify: `feature/shift/ShiftRepository.kt:128-143` (constructor), `:317-328` (`leave`)
- Modify test: `feature/shift/ShiftRepositoryHostTest.kt`

**Interfaces:**

- Consumes: Tasks 4, 6, 7 (`ShiftParticipationStore`, `StationBackend.leave`, the beat that flushes owed leaves).
- Produces: `ShiftRepository(backend, db, json, pool, blocks, participation, clock)` (the new parameter sits before `clock`, so every `ShiftRepository(…) { clock }` call keeps compiling); `leave` writes the local mark, and for a host device the owed-leave marker, in one commit and then asks the host.

- [ ] **Step 1: Write the failing tests.** In `ShiftRepositoryHostTest.kt` add imports `app.markiro.handheld.core.host.ShiftParticipationStore`, `app.markiro.handheld.core.network.host.TransportFailure`, `kotlinx.serialization.json.jsonArray`, `kotlinx.serialization.json.jsonObject` (present), and append (the existing `Script.post` returns the scripted `HostResult`, a `Failed` included):

```kotlin
    private fun leavePath() = "/v1/device/shifts/$id/leave"
    private fun participationOneShift() =
        Json.parseToJsonElement(fixture("device-shifts-participants.json")).jsonObject.getValue("shifts").jsonArray[0].toString()

    private suspend fun workingIn() {
        db.shiftDao().upsert(ShiftEntityFixtures.bundled(id))
        db.deviceConfigDao().get()!!.let { db.deviceConfigDao().upsert(it.copy(activeShiftId = id)) }
    }

    @Test
    fun leavingMarksTheShiftLeftAtOnceAndFreesTheHostsSlot() = runTest {
        workingIn()
        val script = Script(emptyMap(), mutableMapOf(leavePath() to ArrayDeque(listOf(ok(participationOneShift())))))
        repository(script).leave(id)
        assertNotNull(db.shiftDao().get(id)!!.leftAt)
        assertEquals(null, db.deviceConfigDao().get()!!.activeShiftId)
        assertEquals(emptyList<String>(), ShiftParticipationStore(db).pendingLeaves())
        assertNotNull("what the host answered is kept", ShiftParticipationStore(db).get(id))
    }

    @Test
    fun aLeaveTheHostDidNotHearStaysOwedAndTheOperatorIsNotBlocked() = runTest {
        workingIn()
        val script = Script(emptyMap(), mutableMapOf(leavePath() to ArrayDeque(listOf(HostResult.Failed(TransportFailure.UNREACHABLE)))))
        repository(script).leave(id)
        assertNotNull(db.shiftDao().get(id)!!.leftAt)
        assertEquals(listOf(id), ShiftParticipationStore(db).pendingLeaves())
    }

    @Test
    fun aHostThatHoldsNoSlotOfTheDeviceOwesNothing() = runTest {
        workingIn()
        val refused = HostResult.Ok(409, """{"error":{"code":"conflict","message":"m","details":{"constraint":"shift_not_entered"}}}""", null)
        repository(Script(emptyMap(), mutableMapOf(leavePath() to ArrayDeque(listOf(refused))))).leave(id)
        assertEquals(emptyList<String>(), ShiftParticipationStore(db).pendingLeaves())
        assertNotNull(db.shiftDao().get(id)!!.leftAt)
    }
```

Add to `ShiftRepositoryTest.kt` (cloud) a one-line guard test next to the existing leave tests, to prove the cloud path owes nothing: find the existing test that calls `repository.leave(` and append in that class

```kotlin
    @Test
    fun aCloudDeviceLeavingOwesTheHostNothing() = runTest {
        db.shiftDao().upsert(ShiftEntityFixtures.bundled("s1"))
        repository().leave("s1")
        assertEquals(emptyList<String>(), app.markiro.handheld.core.host.ShiftParticipationStore(db).pendingLeaves())
    }
```

(use the class's own repository factory name; if it is not `repository()`, use the existing helper the neighbouring leave test uses.)

- [ ] **Step 2: Run them to verify they fail.**
      Run: `GRADLE :app:testDebugUnitTest --tests "app.markiro.handheld.feature.shift.ShiftRepositoryHostTest" --tests "app.markiro.handheld.feature.shift.ShiftRepositoryTest"`
      Expected: the host tests FAIL (`pendingLeaves` stays empty after an unreachable host; the leave never POSTs).

- [ ] **Step 3: Implement.** `ShiftRepository.kt`: add imports `app.markiro.handheld.core.host.ShiftParticipationStore` and `app.markiro.handheld.core.storage.RecoveryBlocked`; replace the constructors (`:128-143`) with

```kotlin
class ShiftRepository(
    private val backend: StationBackend,
    private val db: HandheldDatabase,
    private val json: Json,
    private val pool: SsccPool,
    private val blocks: SsccBlockApplier = SsccBlockApplier(pool),
    /** The leaves still owed to a host live here (plan 2b); a cloud device never writes one. */
    private val participation: ShiftParticipationStore = ShiftParticipationStore(db),
    private val clock: () -> Long = System::currentTimeMillis,
) {
    constructor(
        api: StationApi,
        db: HandheldDatabase,
        json: Json,
        pool: SsccPool,
        blocks: SsccBlockApplier = SsccBlockApplier(pool),
        clock: () -> Long = System::currentTimeMillis,
    ) : this(CloudBackend(api), db, json, pool, blocks, ShiftParticipationStore(db), clock)
```

and replace `leave` (`:317`) with

```kotlin
    suspend fun leave(shiftId: String) {
        // A cloud backend answers `cloudApi()`; the host does not. Only a host has a slot to free.
        val owesHost = backend.cloudApi() == null
        db.recovery.commit {
            leaveOwned(shiftId)
            // Written with the local mark, so a crash or a blocked recovery between the two never loses a leave the host is owed.
            if (owesHost) participation.markLeavePending(shiftId)
        }
        if (owesHost) releaseSlot(shiftId)
    }

    /**
     * Best effort and after the local mark, which is what the operator sees. The host frees the slot when it hears of the leave; when it cannot be
     * reached the marker stays and the heartbeat sends the leave later, only while this device is still out (`HostParticipation`). A refusal means
     * the host holds no slot of this device (`shift_not_entered`, a closed or unknown shift): nothing is owed.
     */
    private suspend fun releaseSlot(shiftId: String) {
        try {
            db.recovery.work { backend.leave(shiftId) }
            participation.clearLeavePending(shiftId)
        } catch (_: HttpException) {
            participation.clearLeavePending(shiftId)
        } catch (_: IOException) {
            // Stays owed.
        } catch (_: RecoveryBlocked) {
            // The device is being paired again; the marker is cleared with the dataset if that replaces it.
        }
    }
```

- [ ] **Step 4: Run the tests to verify they pass.**
      Run: `GRADLE :app:testDebugUnitTest --tests "app.markiro.handheld.feature.shift.*" --tests "app.markiro.handheld.feature.work.WorkViewModelTest" --tests "app.markiro.handheld.feature.hub.*"`
      Expected: PASS (`WorkViewModel.leave` and the hub tests call `repository.leave` through the cloud constructor; the owed-leave path is not taken).

- [ ] **Step 5: Commit.**

```bash
git -C "$WT" add apps/handheld/app/src/main/kotlin/app/markiro/handheld/feature/shift/ShiftRepository.kt \
  apps/handheld/app/src/test/kotlin/app/markiro/handheld/feature/shift/ShiftRepositoryHostTest.kt \
  apps/handheld/app/src/test/kotlin/app/markiro/handheld/feature/shift/ShiftRepositoryTest.kt
git -C "$WT" commit -m "feat(handheld): leaving a shift frees the host's slot, and an unheard leave stays owed

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 10: The strip «Моя смена: N · Всего в смене: K из M» on the work screen

**Files:**

- Create: `feature/work/SharedShiftStrip.kt`
- Modify: `feature/work/WorkViewModel.kt:167-196` (`WorkUi`), `:355-420` (`state` combine), imports
- Modify: `feature/work/WorkScreen.kt:239-259` (counters), `:262` (caption insertion), `:197` (menu item), `:462` (`Counter` visibility)
- Modify: `res/values/strings.xml`, `res/values-en/strings.xml`
- Modify tests: `feature/work/WorkViewModelTest.kt`, `feature/work/WorkScreenTest.kt`, `EnglishRenderTest.kt`

**Interfaces:**

- Consumes: Task 4 (`ShiftParticipationStore.observe`), Task 5 (`SharedShiftRules.strip`, `SharedStrip`).
- Produces: `WorkUi.strip: SharedStrip? = null` (the last constructor parameter, defaulted); `WorkUi.total` is the shift-wide total while `strip != null`; strings `work_shift_total`, `work_shift_total_of`, `work_my_part`, `work_shared_devices`, `work_close_part`; `@Composable fun SharedShiftCaption(strip: SharedStrip)`.

- [ ] **Step 1: Write the failing tests.** In `WorkViewModelTest.kt` add imports `app.markiro.handheld.core.host.ShiftParticipationStore`, `app.markiro.handheld.core.network.host.DeviceShiftsDto`, `kotlinx.serialization.json.Json` (if absent), and append:

```kotlin
    /** The host's shared-shift fixture, as shift `s1` of this test, read as its first participant would read it. */
    private suspend fun storeSharedShift(plan: Int? = 100) {
        val shift = Json { ignoreUnknownKeys = true }.decodeFromString(
            DeviceShiftsDto.serializer(),
            checkNotNull(javaClass.classLoader?.getResource("device-shifts-participants.json")).readText(),
        ).shifts.single().copy(id = "s1", plannedQty = plan)
        ShiftParticipationStore(db, myDeviceId = { "7c9e6679-7425-40de-944b-e07fc1f90ae7" }).save(shift)
    }

    @Test
    fun aSharedShiftShowsTheShiftWideTotalAndTheDevicesOwnCount() = runTest {
        storeSharedShift()
        val vm = vm()
        advanceUntilIdle()
        // The host holds 547 of which 427 are this device's: the others' 120, and nothing of this device's own yet.
        val first = vm.state.first { it.strip != null }
        assertEquals(120, first.total)
        assertEquals(0, first.strip!!.mine)
        assertEquals(2, first.strip!!.maxStations)
        scans.tryEmit(ScanEvent("010460068200001321abc${gs}93AAAA", null, "debug", 0))
        advanceUntilIdle()
        val after = vm.state.first { it.thisTerminal == 1 }
        assertEquals(121, after.total)
        assertEquals(1, after.strip!!.mine)
    }

    @Test
    fun aShiftOfALineThatAllowsOneDeviceKeepsTheScreenOfToday() = runTest {
        val vm = vm()
        advanceUntilIdle()
        assertNull(vm.state.value.strip)
        scans.tryEmit(ScanEvent("010460068200001321abc${gs}93AAAA", null, "debug", 0))
        advanceUntilIdle()
        assertNull(vm.state.first { it.thisTerminal == 1 }.strip)
    }

    @Test
    fun theStripGoesStaleWhenTheHeartbeatSaysTheHostDidNotAnswer() = runTest {
        storeSharedShift()
        val vm = vm()
        advanceUntilIdle()
        assertNull(vm.state.first { it.strip != null }.strip!!.staleAtMillis)
        ShiftParticipationStore(db).markStale("s1")
        assertNotNull(vm.state.first { it.strip?.staleAtMillis != null }.strip!!.staleAtMillis)
    }

    @Test
    fun thePlanPromptJudgesTheShiftWideTotal() = runTest {
        // Plan 130: the others already delivered 120; this device's tenth unit crosses it.
        storeSharedShift(plan = 130)
        val vm = vm()
        advanceUntilIdle()
        vm.state.first { it.strip != null }
        assertFalse(vm.planPrompt.value)
        repeat(10) { n ->
            scans.tryEmit(ScanEvent("010460068200001321u$n${gs}93AAAA", null, "debug", 0))
            advanceUntilIdle()
        }
        assertTrue(vm.planPrompt.first { it })
    }
```

(The file already imports `assertNull`, `assertNotNull`, `assertFalse`, `assertTrue`; add any that is missing.)

In `WorkScreenTest.kt` append (add imports `app.markiro.handheld.feature.shift.SharedStrip`, `app.markiro.handheld.core.util.TimeText`):

```kotlin
    @Test
    fun aSharedShiftShowsTheShiftTotalOutOfThePlanAndTheDevicesOwnPart() {
        val numbers = NumberFormat.getIntegerInstance()
        compose.setContent {
            MarkiroTheme {
                WorkScreen(
                    ui.copy(total = 547, plan = 1200, thisTerminal = 427, strip = SharedStrip(mine = 427, total = 547, plan = 1200, active = 2, maxStations = 3, staleAtMillis = null)),
                    WorkCallbacks(),
                )
            }
        }
        compose.onNodeWithText("Всего в смене").assertIsDisplayed()
        compose.onNodeWithText("${numbers.format(547)} из ${numbers.format(1200)}").assertIsDisplayed()
        compose.onNodeWithText("Моя смена").assertIsDisplayed()
        compose.onNodeWithText("427").assertIsDisplayed()
        compose.onNodeWithText("Работают: 2 из 3").assertIsDisplayed()
        compose.onNodeWithText("данные на", substring = true).assertDoesNotExist()
    }

    @Test
    fun anOfflineStripCarriesTheTimeOfItsLastFigures() {
        val at = java.time.Instant.parse("2026-10-08T09:41:07Z").toEpochMilli()
        compose.setContent {
            MarkiroTheme {
                WorkScreen(
                    ui.copy(strip = SharedStrip(mine = 427, total = 547, plan = null, active = 1, maxStations = 2, staleAtMillis = at)),
                    WorkCallbacks(),
                )
            }
        }
        compose.onNodeWithText("данные на ${TimeText.hhmm(at)}").assertIsDisplayed()
    }

    @Test
    fun aNonSharedShiftKeepsItsOwnLabelsAndTheOldCloseEntry() {
        var closed = false
        compose.setContent { MarkiroTheme { WorkScreen(ui, WorkCallbacks(onClose = { closed = true })) } }
        compose.onNodeWithText("Всего").assertIsDisplayed()
        compose.onNodeWithText("Этот ТСД").assertIsDisplayed()
        compose.onNodeWithText("Всего в смене").assertDoesNotExist()
    }
```

(Add `androidx.compose.ui.test.assertDoesNotExist` import if absent.) In `EnglishRenderTest.kt` append:

```kotlin
    @Test
    fun theSharedShiftStripRendersInEnglish() {
        compose.setContent {
            MarkiroTheme {
                app.markiro.handheld.feature.work.WorkScreen(
                    app.markiro.handheld.feature.work.WorkUi(
                        shift = app.markiro.handheld.feature.shift.ShiftEntityFixtures.bundled("s1"), last = null, total = 547, plan = 1200, thisTerminal = 427,
                        errors = 0, duplicates = 0, feed = emptyList(), sync = app.markiro.handheld.core.sync.SyncState(), reachable = false, team = null,
                        strip = app.markiro.handheld.feature.shift.SharedStrip(427, 547, 1200, 2, 3, staleAtMillis = 1_760_000_000_000L),
                    ),
                    app.markiro.handheld.feature.work.WorkCallbacks(),
                )
            }
        }
        assertNoCyrillic()
    }
```

- [ ] **Step 2: Run them to verify they fail.**
      Run: `GRADLE :app:testDebugUnitTest --tests "app.markiro.handheld.feature.work.WorkViewModelTest" --tests "app.markiro.handheld.feature.work.WorkScreenTest" --tests "app.markiro.handheld.EnglishRenderTest"`
      Expected: FAIL to compile (`strip` unresolved).

- [ ] **Step 3: Strings.** In `strings.xml` (RU) after the `shifts_part_closed_text` line added in Task 8 add

```xml
    <string name="work_shift_total">Всего в смене</string>
    <string name="work_shift_total_of">%1$s из %2$s</string>
    <string name="work_my_part">Моя смена</string>
    <string name="work_shared_devices">Работают: %1$d из %2$d</string>
    <string name="work_close_part">Закрыть свою часть</string>
```

and in `values-en/strings.xml` after the matching `shifts_part_closed_text` line

```xml
    <string name="work_shift_total">In the shift total</string>
    <string name="work_shift_total_of">%1$s of %2$s</string>
    <string name="work_my_part">My shift</string>
    <string name="work_shared_devices">Working: %1$d of %2$d</string>
    <string name="work_close_part">Close my part</string>
```

- [ ] **Step 4: Implement.** `SharedShiftStrip.kt` (new, package `app.markiro.handheld.feature.work`):

```kotlin
package app.markiro.handheld.feature.work

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import app.markiro.handheld.R
import app.markiro.handheld.core.design.MarkiroSizes
import app.markiro.handheld.core.design.MarkiroTheme
import app.markiro.handheld.core.util.TimeText
import app.markiro.handheld.feature.shift.SharedStrip

/**
 * The two lines under the counters of a shift several devices work (plan 2b): how many devices are working it, and, while the host's figures are
 * the last known ones, the time they are from. The counters themselves are the work screen's own two cells, relabelled by the same `strip`.
 */
@Composable
fun SharedShiftCaption(strip: SharedStrip, modifier: Modifier = Modifier) {
    val c = MarkiroTheme.colors
    val t = MarkiroTheme.type
    Column(modifier.fillMaxWidth().padding(horizontal = MarkiroSizes.sp4)) {
        Text(stringResource(R.string.work_shared_devices, strip.active, strip.maxStations), style = t.caption, color = c.fg3)
        strip.staleAtMillis?.let { Text(stringResource(R.string.common_data_as_of, TimeText.hhmm(it)), style = t.caption, color = c.warnFg) }
    }
}
```

`WorkViewModel.kt`: add imports `app.markiro.handheld.core.host.ShiftParticipation`, `app.markiro.handheld.core.host.ShiftParticipationStore`, `app.markiro.handheld.feature.shift.SharedShiftRules`, `app.markiro.handheld.feature.shift.SharedStrip`. In `WorkUi` add as the **last** property (after `boxRefusal`):

```kotlin
    /**
     * Present only while the line allows several devices (or several have worked this shift): the shift-wide figures of plan 2b. While it is set,
     * [total] is the shift-wide total and the two counters read «Всего в смене» and «Моя смена».
     */
    val strip: SharedStrip? = null,
```

Add above `val state`:

```kotlin
    /** The host's last figures of this shift (plan 2b): refreshed by the heartbeat while the shift is worked, kept for the strip's offline stamp. */
    private val participation: Flow<ShiftParticipation?> = ShiftParticipationStore(db).observe(shiftId)
```

and in the `combine(` list append `participation,` after `db.deviceConfigDao().observe(),`; in the lambda, after `val operator = …` add

```kotlin
        val strip = SharedShiftRules.strip(values[16] as ShiftParticipation?, c.mine, shift?.plannedQty)
```

and change `total = maxOf(teamNow?.acceptedUnits ?: 0, c.mine),` to

```kotlin
            total = strip?.total ?: maxOf(teamNow?.acceptedUnits ?: 0, c.mine),
```

and add `strip = strip,` as the last named argument of the `WorkUi(` call (after `hostMode = …`).
`WorkScreen.kt`: change `private fun Counter(` (`:462`) to `internal fun Counter(` only if the new file needs it (it does not; leave it private). In both counter layouts replace the label/value expressions. In the validation layout (`:239-242`):

```kotlin
                        val total = state.plan?.let {
                            stringResource(if (state.strip != null) R.string.work_shift_total_of else R.string.work_plan_of, numbers.format(state.total), numbers.format(it))
                        } ?: numbers.format(state.total)
                        Box(Modifier.weight(1f)) { Counter(stringResource(if (state.strip != null) R.string.work_shift_total else R.string.work_total), total) }
                        Box(Modifier.weight(1f)) {
                            Counter(stringResource(if (state.strip != null) R.string.work_my_part else R.string.work_this_terminal), numbers.format(state.thisTerminal))
                        }
```

and in the plain layout (`:254-257`):

```kotlin
                val total = state.plan?.let {
                    stringResource(if (state.strip != null) R.string.work_shift_total_of else R.string.work_plan_of, numbers.format(state.total), numbers.format(it))
                } ?: numbers.format(state.total)
                Counter(stringResource(if (state.strip != null) R.string.work_shift_total else R.string.work_total), total, modifier = Modifier.weight(1f))
                Counter(
                    stringResource(if (state.strip != null) R.string.work_my_part else R.string.work_this_terminal),
                    numbers.format(state.thisTerminal),
                    modifier = Modifier.weight(1f),
                )
```

Insert the caption between the counters block and the feed (immediately before the line `Column((if (state.validation != null) Modifier else Modifier.weight(if (box != null) 0.38f else 0.6f)).fillMaxWidth().padding(horizontal = MarkiroSizes.sp4)) {`, `:262`):

```kotlin
            state.strip?.let { SharedShiftCaption(it) }
```

and the overflow menu item (`:197`): `text = { Text(stringResource(R.string.work_close)) },` becomes

```kotlin
                        text = { Text(stringResource(if (state.strip != null) R.string.work_close_part else R.string.work_close)) },
```

- [ ] **Step 5: Run the tests to verify they pass.**
      Run: `GRADLE :app:testDebugUnitTest --tests "app.markiro.handheld.feature.work.*" --tests "app.markiro.handheld.EnglishRenderTest"`
      Expected: PASS. The existing `rendersVerdictCountersBannerAndOverflowActions` (which asserts «1 240 / 3 000», «Этот ТСД» and the «Закрыть смену» menu item) must still pass unchanged: a `WorkUi` without `strip` renders as before.

- [ ] **Step 6: Commit.**

```bash
git -C "$WT" add apps/handheld/app/src/main/kotlin/app/markiro/handheld/feature/work/SharedShiftStrip.kt \
  apps/handheld/app/src/main/kotlin/app/markiro/handheld/feature/work/WorkViewModel.kt \
  apps/handheld/app/src/main/kotlin/app/markiro/handheld/feature/work/WorkScreen.kt \
  apps/handheld/app/src/main/res/values/strings.xml apps/handheld/app/src/main/res/values-en/strings.xml \
  apps/handheld/app/src/test/kotlin/app/markiro/handheld/feature/work/WorkViewModelTest.kt \
  apps/handheld/app/src/test/kotlin/app/markiro/handheld/feature/work/WorkScreenTest.kt \
  apps/handheld/app/src/test/kotlin/app/markiro/handheld/EnglishRenderTest.kt
git -C "$WT" commit -m "feat(handheld): the work strip shows my part and the shift-wide total of a shared shift, stale offline

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Closing the device's own part: wording, reason rule, receipts

**Files:**

- Modify: `feature/shift/ShiftCloser.kt:12-58` (constructor, `Preview`, `preview`), `:59-67` (`closeOwned`)
- Modify: `feature/shift/CloseViewModel.kt:16-33`, `:73-97`
- Modify: `feature/shift/CloseScreens.kt:64-123`
- Modify: `feature/shift/ShiftModule.kt:27-28`
- Modify: `core/host/HostAckMapper.kt:35-37`, add `noteCloseReceipt`
- Modify: `core/storage/ShiftDaos.kt:151-152` (`forEvent`)
- Modify: `res/values/strings.xml`, `res/values-en/strings.xml`
- Modify tests: `feature/shift/ShiftCloserTest.kt`, `feature/shift/CloseScreensTest.kt`, `feature/shift/CloseViewModelTest.kt`, `core/host/HostSyncEngineTest.kt` (or a new `HostAckMapperCloseNoteTest.kt`), `EnglishRenderTest.kt`

**Interfaces:**

- Consumes: Tasks 4, 5, 7 (`ShiftParticipationStore`, `SharedShiftRules`, `HostParticipation.refresh`).
- Produces:
  - `ShiftCloser(db, refresh: suspend () -> Boolean = { false }, participation: ShiftParticipationStore = ShiftParticipationStore(db), clock)` (new parameters before `clock`);
  - `ShiftCloser.Preview` gains `shared: Boolean = false`, `othersOpen: Int? = null`, `reasonBasis: Int? = null` (all after the existing defaults);
  - `CloseOutcome.PART_CLOSED`, `CloseOutcome.REASON_MISSING`; `CloseStep.Summary(…, part: Boolean = false)`;
  - `ShiftCloseDao.forEvent(eventId)`; `HostAckMapper` writes `ShiftParticipationStore.closeNoteKey(shiftId)` for `partClosed` / `reasonMissing` receipts;
  - strings `close_part_confirm_title`, `close_part_confirm_text_others/_last/_unknown`, `close_summary_part_title`, `close_summary_part_closed`, `close_summary_reason_missing`.

- [ ] **Step 1: Write the failing tests.** In `ShiftCloserTest.kt` add imports `app.markiro.handheld.core.host.ShiftParticipation`, `app.markiro.handheld.core.host.ShiftParticipationStore`, `app.markiro.handheld.core.storage.MetaEntity`, and append (the class's `setUp` leaves shift `s1` with plan 3 and two accepted codes; `now` for freshness comes from the closer's clock):

```kotlin
    private val t0 = 1_757_500_000_000L

    private suspend fun keep(p: ShiftParticipation) = db.recovery.commit {
        db.metaDao().put(MetaEntity(ShiftParticipationStore.key("s1"), kotlinx.serialization.json.Json.encodeToString(ShiftParticipation.serializer(), p)))
    }

    private fun shared(
        accepted: Long = 120,
        mine: Long = 0,
        ever: Int = 2,
        othersOpen: Int = 0,
        fetchedAt: Long = t0,
        stale: Boolean = false,
    ) = ShiftParticipation(
        shiftId = "s1", maxStations = 2, myState = "active", participantsEver = ever, active = 1, othersOpen = othersOpen,
        accepted = accepted, myAccepted = mine, asOf = "2026-09-10T10:00:00Z", fetchedAt = fetchedAt, stale = stale,
    )

    @Test
    fun aSharedShiftsLastCloserIsAskedForAReasonByTheShiftWideTotal() = runTest {
        // Plan 3; the others delivered 120 and this device has 2: the shift has 122, the plan is missed.
        keep(shared())
        val p = ShiftCloser(db) { t0 }.preview("s1")!!
        assertTrue(p.reasonRequired)
        assertTrue(p.shared)
        assertEquals(0, p.othersOpen)
        assertEquals(122, p.reasonBasis)
    }

    @Test
    fun aDeviceThatIsNotTheLastToCloseIsNotAskedAndSaysHowManyAreStillOpen() = runTest {
        keep(shared(othersOpen = 2))
        val p = ShiftCloser(db) { t0 }.preview("s1")!!
        assertFalse(p.reasonRequired)
        assertEquals(2, p.othersOpen)
    }

    @Test
    fun withoutFreshFiguresADeviceClosesItsPartWithoutAReasonAndDoesNotKnowWhoIsLast() = runTest {
        keep(shared(stale = true))
        val p = ShiftCloser(db) { t0 }.preview("s1")!!
        assertFalse(p.reasonRequired)
        assertTrue(p.shared)
        assertEquals(null, p.othersOpen)
        // The close itself does not refuse: the host marks the missing reason and the office supplies it.
        val row = ShiftCloser(db) { t0 }.close("s1", "op-1", null)
        assertEquals(null, row.reasonCode)
        assertEquals("closed", db.shiftDao().get("s1")!!.status)
    }

    @Test
    fun theCloseRefreshesTheFiguresBeforeItJudgesAndUsesTheAnswer() = runTest {
        keep(shared(othersOpen = 1, fetchedAt = t0 - 10 * SharedShiftRules.FRESH_MS))
        var refreshed = 0
        val closer = ShiftCloser(
            db,
            refresh = {
                refreshed++
                // The host answered: the other device closed its part meanwhile.
                keep(shared(othersOpen = 0))
                true
            },
        ) { t0 }
        val p = closer.preview("s1")!!
        assertEquals(1, refreshed)
        assertTrue(p.reasonRequired)
        assertEquals(0, p.othersOpen)
    }

    @Test
    fun aRefreshThatFailsIsNotAFailureOfThePreview() = runTest {
        val p = ShiftCloser(db, refresh = { throw java.io.IOException("no host") }) { t0 }.preview("s1")!!
        assertTrue("one device, no figures: stage 2a's rule", p.reasonRequired)
        assertFalse(p.shared)
    }

    @Test
    fun aDeviceAloneInItsShiftStillCannotCloseWithoutTheReasonItsPlanNeeds() = runTest {
        keep(shared(ever = 1, accepted = 2, mine = 2))
        val result = runCatching { ShiftCloser(db) { t0 }.close("s1", null, null) }
        assertTrue(result.exceptionOrNull() is IllegalArgumentException)
    }
```

In `CloseScreensTest.kt` append:

```kotlin
    private val sharedPreview = { others: Int? ->
        ShiftCloser.Preview(120, 1, 0, 1200, reasonRequired = false, alreadyClosed = false, shared = true, othersOpen = others)
    }

    @Test
    fun aSharedCloseNamesThePartAndHowManyOthersAreStillOpen() {
        compose.setContent { MarkiroTheme { CloseScreen(CloseStep.Confirm(sharedPreview(2)), CloseCallbacks()) } }
        compose.onNodeWithText("Закрыть свою часть?").assertIsDisplayed()
        compose.onNodeWithText("Смена закроется, когда закроют остальные: 2", substring = true).assertIsDisplayed()
    }

    @Test
    fun theLastCloserIsToldTheShiftClosesWithIt() {
        compose.setContent { MarkiroTheme { CloseScreen(CloseStep.Confirm(sharedPreview(0)), CloseCallbacks()) } }
        compose.onNodeWithText("Вы закрываете последним: смена закроется", substring = true).assertIsDisplayed()
    }

    @Test
    fun aDeviceThatCannotKnowSaysItClosesItsPartAndTheShiftClosesWhenTheOthersClose() {
        compose.setContent { MarkiroTheme { CloseScreen(CloseStep.Confirm(sharedPreview(null)), CloseCallbacks()) } }
        compose.onNodeWithText("Смена закроется, когда закроют остальные участники", substring = true).assertIsDisplayed()
    }

    @Test
    fun theReasonScreenComparesThePlanWithTheShiftWideTotal() {
        compose.setContent {
            MarkiroTheme {
                CloseScreen(
                    CloseStep.Reason(ShiftCloser.Preview(120, 1, 0, 1200, reasonRequired = true, alreadyClosed = false, shared = true, othersOpen = 0, reasonBasis = 547), null),
                    CloseCallbacks(),
                )
            }
        }
        compose.onNodeWithText("План 1200, принято 547.").assertIsDisplayed()
    }

    @Test
    fun theSummaryOfAPartCloseAndOfAMissingReasonSaySoInsteadOfShiftClosed() {
        compose.setContent { MarkiroTheme { CloseScreen(CloseStep.Summary(120, 1, 0, 0, CloseOutcome.PART_CLOSED, part = true), CloseCallbacks()) } }
        compose.onNodeWithText("Ваша часть закрыта").assertIsDisplayed()
        compose.onNodeWithText("Смена закроется, когда закроют остальные", substring = true).assertIsDisplayed()
    }

    @Test
    fun aShiftClosedWithoutItsReasonSaysTheOfficeEntersIt() {
        compose.setContent { MarkiroTheme { CloseScreen(CloseStep.Summary(120, 1, 0, 0, CloseOutcome.REASON_MISSING, part = true), CloseCallbacks()) } }
        compose.onNodeWithText("Причину недовыполнения плана внесёт офис", substring = true).assertIsDisplayed()
    }
```

In `CloseViewModelTest.kt`, which drives a real `SyncEngine` over `MockWebServer` (a cloud device), append a test that proves the note decides the summary without a network round trip for the host (the note is what the mapper wrote):

```kotlin
    @Test
    fun aHostNotedPartCloseOrMissingReasonDecidesTheSummaryOutcome() = runTest {
        val store = app.markiro.handheld.core.host.ShiftParticipationStore(db)
        store.noteClose("s1", app.markiro.handheld.core.host.ShiftParticipationStore.NOTE_PART_CLOSED)
        assertEquals(CloseOutcome.PART_CLOSED, CloseViewModel.outcomeOf("accepted", store.closeNote("s1")))
        store.noteClose("s1", app.markiro.handheld.core.host.ShiftParticipationStore.NOTE_REASON_MISSING)
        assertEquals(CloseOutcome.REASON_MISSING, CloseViewModel.outcomeOf(null, store.closeNote("s1")))
        assertEquals(CloseOutcome.ACCEPTED, CloseViewModel.outcomeOf("accepted", null))
        assertEquals(CloseOutcome.CONFLICT, CloseViewModel.outcomeOf("conflict", "part_closed"))
        assertEquals(CloseOutcome.PENDING, CloseViewModel.outcomeOf("pending", "part_closed"))
    }
```

Create `app/src/test/kotlin/app/markiro/handheld/core/host/HostAckMapperCloseNoteTest.kt`:

```kotlin
package app.markiro.handheld.core.host

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.network.host.FactReceiptDto
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.HostOutboxEntity
import app.markiro.handheld.core.storage.ShiftCloseEntity
import app.markiro.handheld.core.storage.initializeRecoveryForTest
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class HostAckMapperCloseNoteTest {
    private lateinit var db: HandheldDatabase
    private val shift = HostFactsFixtures.SHIFT
    private val event = "00000000-0000-4000-8000-000000000002"

    @Before
    fun open() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java).allowMainThreadQueries().build()
        kotlinx.coroutines.runBlocking { db.deviceConfigDao().upsert(HostFactsFixtures.config(db)) }
        db.initializeRecoveryForTest()
    }

    @After
    fun close() = db.close()

    private suspend fun queuedClose(): HostOutboxEntity {
        db.shiftCloseDao().insert(
            ShiftCloseEntity(event, shift, "op-1", 1200, 427, 35, null, "2026-10-08T14:10:00.000Z", "pending", null, null),
        )
        val row = HostOutboxEntity(recordId = event, target = "facts", kind = "shift_closed", sourceKind = "shift_close", sourceKey = event, body = "{}", state = "queued", reason = null, createdAt = "2026-10-08T14:10:00.000Z")
        db.hostOutboxDao().insert(row)
        return row
    }

    private fun receipt(details: String?) = FactReceiptDto(
        id = event, outcome = "accepted", details = details?.let { Json.parseToJsonElement(it).jsonObject },
    )

    @Test
    fun aPartCloseReceiptIsAcceptedAndNotedForTheSummary() = runTest {
        val row = queuedClose()
        HostAckMapper(db).apply(listOf(row), listOf(receipt("""{"partClosed":true}""")))
        assertEquals("accepted", db.shiftCloseDao().forShift(shift)!!.state)
        assertEquals("part_closed", ShiftParticipationStore(db).closeNote(shift))
    }

    @Test
    fun aMissingReasonReceiptIsAcceptedAndNotedForTheSummary() = runTest {
        val row = queuedClose()
        HostAckMapper(db).apply(listOf(row), listOf(receipt("""{"reasonMissing":true}""")))
        assertEquals("reason_missing", ShiftParticipationStore(db).closeNote(shift))
    }

    @Test
    fun aPlainAcceptedCloseLeavesNoNote() = runTest {
        val row = queuedClose()
        HostAckMapper(db).apply(listOf(row), listOf(receipt(null)))
        assertEquals("accepted", db.shiftCloseDao().forShift(shift)!!.state)
        assertNull(ShiftParticipationStore(db).closeNote(shift))
    }

    @Test
    fun theReceiptOfAnythingButAClosePutsNoNote() = runTest {
        db.hostOutboxDao().insert(HostOutboxEntity(recordId = "r1", target = "facts", kind = "scan", sourceKind = "scan", sourceKey = "999", body = "{}", state = "queued", reason = null, createdAt = "2026-10-08T14:10:00.000Z"))
        val row = db.hostOutboxDao().queued(10).single()
        HostAckMapper(db).apply(listOf(row), listOf(FactReceiptDto(id = "r1", outcome = "accepted", details = Json.parseToJsonElement("""{"partClosed":true}""").jsonObject)))
        assertEquals(emptyList<String>(), db.metaDao().withPrefix("shift_close_note:").map { it.key })
    }
}
```

In `EnglishRenderTest.kt` append:

```kotlin
    @Test
    fun theSharedCloseRendersInEnglish() {
        val preview = ShiftCloser.Preview(120, 1, 0, 1200, reasonRequired = false, alreadyClosed = false, shared = true, othersOpen = 2)
        for (step in listOf(
            CloseStep.Confirm(preview),
            CloseStep.Confirm(preview.copy(othersOpen = 0)),
            CloseStep.Confirm(preview.copy(othersOpen = null)),
            CloseStep.Summary(120, 1, 0, 0, CloseOutcome.PART_CLOSED, part = true),
            CloseStep.Summary(120, 1, 0, 0, CloseOutcome.REASON_MISSING, part = true),
        )) {
            compose.setContent { MarkiroTheme { CloseScreen(step, CloseCallbacks()) } }
            assertNoCyrillic()
        }
    }
```

with imports `app.markiro.handheld.feature.shift.CloseCallbacks`, `CloseOutcome`, `CloseScreen`, `CloseStep`, `ShiftCloser`.

- [ ] **Step 2: Run them to verify they fail.**
      Run: `GRADLE :app:testDebugUnitTest --tests "app.markiro.handheld.feature.shift.ShiftCloserTest" --tests "app.markiro.handheld.feature.shift.CloseScreensTest" --tests "app.markiro.handheld.feature.shift.CloseViewModelTest" --tests "app.markiro.handheld.core.host.HostAckMapperCloseNoteTest" --tests "app.markiro.handheld.EnglishRenderTest"`
      Expected: FAIL to compile (`Preview.shared`, `CloseOutcome.PART_CLOSED`, `outcomeOf`, `forEvent` unresolved).

- [ ] **Step 3: Strings.** RU, after the `work_close_part` line of Task 10:

```xml
    <string name="close_part_confirm_title">Закрыть свою часть?</string>
    <string name="close_part_confirm_text_others">Принято %1$d, ошибок %2$d, дублей %3$d. Смена закроется, когда закроют остальные: %4$d.</string>
    <string name="close_part_confirm_text_last">Принято %1$d, ошибок %2$d, дублей %3$d. Вы закрываете последним: смена закроется.</string>
    <string name="close_part_confirm_text_unknown">Принято %1$d, ошибок %2$d, дублей %3$d. Смена закроется, когда закроют остальные участники.</string>
    <string name="close_summary_part_title">Ваша часть закрыта</string>
    <string name="close_summary_part_closed">Смена закроется, когда закроют остальные</string>
    <string name="close_summary_reason_missing">Смена закрыта. Причину недовыполнения плана внесёт офис</string>
```

EN, after its `work_close_part` line:

```xml
    <string name="close_part_confirm_title">Close your part?</string>
    <string name="close_part_confirm_text_others">Accepted %1$d, errors %2$d, duplicates %3$d. The shift closes when the others close theirs: %4$d.</string>
    <string name="close_part_confirm_text_last">Accepted %1$d, errors %2$d, duplicates %3$d. You are the last to close: the shift will close.</string>
    <string name="close_part_confirm_text_unknown">Accepted %1$d, errors %2$d, duplicates %3$d. The shift closes when the other participants close theirs.</string>
    <string name="close_summary_part_title">Your part is closed</string>
    <string name="close_summary_part_closed">The shift closes when the others close theirs</string>
    <string name="close_summary_reason_missing">The shift is closed. The office will enter the reason the plan was not met</string>
```

- [ ] **Step 4: Implement.** `ShiftDaos.kt`: in `ShiftCloseDao` after `forShift` add

```kotlin
    /** The close a host receipt names: the host knows it by this id (`HostOutboxEntity.sourceKey`). */
    @Query("SELECT * FROM shift_close_outbox WHERE eventId = :eventId")
    suspend fun forEvent(eventId: String): ShiftCloseEntity?
```

`HostAckMapper.kt`: add imports `app.markiro.handheld.core.host.ShiftParticipationStore` (same package: none needed) and `app.markiro.handheld.core.network.host.flag`; change `"accepted" -> acknowledge(row)` (`:36`) to

```kotlin
                    "accepted" -> {
                        acknowledge(row)
                        noteCloseReceipt(row, receipt)
                    }
```

and add after `acknowledge`:

```kotlin
    /**
     * What the host said of a close beyond «accepted» (plan 2b): the part closed while the shift stays open for the others, or the shift closed without
     * the reason its plan needed. Written with the acknowledgement, in the same commit; the close summary reads it once the queue is drained.
     */
    private suspend fun noteCloseReceipt(row: HostOutboxEntity, receipt: FactReceiptDto) {
        if (row.sourceKind != "shift_close") return
        val note = when {
            receipt.details.flag("partClosed") -> ShiftParticipationStore.NOTE_PART_CLOSED
            receipt.details.flag("reasonMissing") -> ShiftParticipationStore.NOTE_REASON_MISSING
            else -> return
        }
        val shiftId = db.shiftCloseDao().forEvent(row.sourceKey)?.shiftId ?: return
        db.metaDao().put(MetaEntity(ShiftParticipationStore.closeNoteKey(shiftId), note))
    }
```

`ShiftCloser.kt`: add imports `app.markiro.handheld.core.host.ShiftParticipationStore`, `kotlinx.coroutines.CancellationException`; replace the class header (`:12`) with

```kotlin
class ShiftCloser(
    private val db: HandheldDatabase,
    /**
     * Reads the host's participation once more before a close is judged (best effort; `true` when the host answered), so who else keeps the shift
     * open is as fresh as the link allows. A cloud device and a device that cannot reach the host leave the figures as they are.
     */
    private val refresh: suspend () -> Boolean = { false },
    private val participation: ShiftParticipationStore = ShiftParticipationStore(db),
    private val clock: () -> Long = System::currentTimeMillis,
) {
```

extend `Preview` after `closedPallets`:

```kotlin
        /** The line lets several devices work this shift, or several have: the close is of this device's part. */
        val shared: Boolean = false,
        /** Devices other than this one whose part is still open; `null` when it cannot be known now (offline, or the figures are old). */
        val othersOpen: Int? = null,
        /** The count the plan is judged against in the reason step: the shift-wide total in a shared shift, this device's own otherwise; `null` reads as [accepted]. */
        val reasonBasis: Int? = null,
```

and replace `preview` (`:37-54`) with

```kotlin
    suspend fun preview(shiftId: String): Preview? {
        val shift = db.shiftDao().get(shiftId) ?: return null
        // Best effort: it decides how the close is worded and whether a reason is asked now, never whether the close can be made.
        try {
            refresh()
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
        }
        val figures = participation.get(shiftId)
        val accepted = db.codeDao().countForShift(shiftId)
        val errors = db.scanEventDao().count(shiftId, Verdict.INVALID.wire) + db.scanEventDao().count(shiftId, Verdict.WRONG_GTIN.wire)
        val duplicates = db.scanEventDao().count(shiftId, Verdict.DUPLICATE.wire)
        val aggregation = shift.mode == "aggregation"
        val now = clock()
        val shared = SharedShiftRules.isShared(figures)
        val fresh = SharedShiftRules.isFresh(figures, now)
        return Preview(
            accepted = accepted,
            errors = errors,
            duplicates = duplicates,
            plan = shift.plannedQty,
            reasonRequired = SharedShiftRules.reasonRequired(shift.plannedQty, accepted, figures, now),
            alreadyClosed = db.shiftCloseDao().forShift(shiftId) != null,
            outstandingDuplicates = db.productLabelJobDao().outstandingCount(shiftId),
            closedBoxes = if (aggregation) db.boxDao().closedCount(shiftId) else null,
            closedPallets = if (aggregation && shift.palletsEnabled) db.palletDao().closedCount(shiftId) else null,
            shared = shared,
            othersOpen = if (shared && fresh) figures?.othersOpen else null,
            reasonBasis = if (figures != null && fresh && figures.participantsEver >= 2) SharedShiftRules.shiftTotal(figures, accepted) else accepted,
        )
    }
```

In `closeOwned` replace the `require` line (`:67`) with

```kotlin
        // Stage 2a's refusal holds where the host still holds the shift to it: this device is the only one that ever worked it. In a shared shift the
        // reason is asked when it is known to be needed (`preview`), and a close without it still closes the part: the host marks the shared shift
        // `reasonMissing` and the office supplies the code, so an offline device is never stopped at the end of its work.
        val figures = participation.get(shiftId)
        val aloneInTheShift = figures == null || figures.participantsEver <= 1
        require(!(aloneInTheShift && reasonRequired(shift.plannedQty, accepted)) || reason != null) { "A valid close reason is required" }
```

`ShiftModule.kt`: replace `shiftCloser` with

```kotlin
    @Provides
    fun shiftCloser(db: HandheldDatabase, participation: app.markiro.handheld.core.host.HostParticipation): ShiftCloser =
        ShiftCloser(db, refresh = participation::refresh)
```

`CloseViewModel.kt`: replace `enum class CloseOutcome` (`:16`) with

```kotlin
enum class CloseOutcome { ACCEPTED, CONFLICT, PENDING, PART_CLOSED, REASON_MISSING }
```

extend `Summary` with `val part: Boolean = false,` after `val pallets: Int? = null,` and add to the file's companion-less class a companion:

```kotlin
    companion object {
        /**
         * The outcome the summary reports from the close row's state and the host's note on it (plan 2b): a close the host accepted with
         * `partClosed` or `reasonMissing` says so; a conflict or a close still queued stays what it was.
         */
        fun outcomeOf(rowState: String?, note: String?): CloseOutcome = when (rowState) {
            null, "accepted" -> when (note) {
                ShiftParticipationStore.NOTE_PART_CLOSED -> CloseOutcome.PART_CLOSED
                ShiftParticipationStore.NOTE_REASON_MISSING -> CloseOutcome.REASON_MISSING
                else -> CloseOutcome.ACCEPTED
            }
            "conflict" -> CloseOutcome.CONFLICT
            else -> CloseOutcome.PENDING
        }
    }
```

(add `import app.markiro.handheld.core.host.ShiftParticipationStore`), and in `finish` replace the `val outcome = when (row?.state) { … }` block (`:86-90`) with

```kotlin
            val outcome = outcomeOf(row?.state, ShiftParticipationStore(db).closeNote(shiftId))
```

and the `Summary(` construction (`:92-95`) with

```kotlin
            _step.value = CloseStep.Summary(
                preview.accepted, preview.errors, preview.duplicates, conflicts, outcome,
                boxes = preview.closedBoxes, pallets = preview.closedPallets, part = preview.shared,
            )
```

`CloseScreens.kt`: replace the `is CloseStep.Confirm` branch (`:64-82`) with

```kotlin
            is CloseStep.Confirm -> {
                AppBar(stringResource(if (step.preview.shared) R.string.work_close_part else R.string.work_close), cb.onCancel)
                // An unresolved duplicate is said out loud and closes anyway.
                // Blocking a shift close on a printer would stop a line over a
                // sticker; the events still sync.
                val text = confirmText(step.preview) +
                    if (step.preview.outstandingDuplicates > 0) {
                        "\n\n" + stringResource(R.string.work_close_duplicates_outstanding, step.preview.outstandingDuplicates)
                    } else {
                        ""
                    }
                FullScreenState(
                    Icons.Outlined.Factory,
                    stringResource(if (step.preview.shared) R.string.close_part_confirm_title else R.string.close_confirm_title),
                    text,
                    primary = StateAction(stringResource(R.string.close_action), cb.onConfirm),
                    secondary = StateAction(stringResource(R.string.common_cancel), cb.onCancel),
                )
            }
```

in the `Reason` branch replace the plan line with

```kotlin
                    Text(stringResource(R.string.close_reason_text, step.preview.plan ?: 0, step.preview.reasonBasis ?: step.preview.accepted), style = t.caption, color = c.fg3)
```

in the `Summary` branch replace `AppBar(stringResource(R.string.close_summary_title))` with

```kotlin
                val partTitle = step.outcome == CloseOutcome.PART_CLOSED || (step.part && step.outcome == CloseOutcome.PENDING)
                AppBar(stringResource(if (partTitle) R.string.close_summary_part_title else R.string.close_summary_title))
```

and the `when (step.outcome)` (`:112-116`) with

```kotlin
                    val (note, noteTone) = when (step.outcome) {
                        CloseOutcome.ACCEPTED -> R.string.close_summary_title to Tone.Ok
                        CloseOutcome.CONFLICT -> R.string.close_summary_conflict to Tone.Warn
                        CloseOutcome.PENDING -> R.string.close_summary_pending to Tone.Info
                        CloseOutcome.PART_CLOSED -> R.string.close_summary_part_closed to Tone.Ok
                        CloseOutcome.REASON_MISSING -> R.string.close_summary_reason_missing to Tone.Warn
                    }
```

and add at the end of the file:

```kotlin
@Composable
private fun confirmText(p: ShiftCloser.Preview): String {
    val others = p.othersOpen
    return when {
        !p.shared -> stringResource(R.string.close_confirm_text, p.accepted, p.errors, p.duplicates)
        others == null -> stringResource(R.string.close_part_confirm_text_unknown, p.accepted, p.errors, p.duplicates)
        others > 0 -> stringResource(R.string.close_part_confirm_text_others, p.accepted, p.errors, p.duplicates, others)
        else -> stringResource(R.string.close_part_confirm_text_last, p.accepted, p.errors, p.duplicates)
    }
}
```

The close **blockers stay as they are**: the handheld has none beyond the unresolved-duplicate warning, which this step keeps verbatim; `CloseBox`/labels/pallet rules are not touched.

- [ ] **Step 5: Run the tests to verify they pass.**
      Run: `GRADLE :app:testDebugUnitTest --tests "app.markiro.handheld.feature.shift.*" --tests "app.markiro.handheld.core.host.*" --tests "app.markiro.handheld.EnglishRenderTest"`
      Expected: PASS; the unchanged single-device tests (`previewCountsAndRequiresAReasonWhenThePlanIsMissed`, `closeRefusesWithoutAReasonWhenThePlanIsMissed`-style tests, `summaryShowsTheConflictNote`) stay green. Then compile the Hilt graph again: `GRADLE :app:compileDebugKotlin` plus the kapt/ksp task of Task 7 Step 4.

- [ ] **Step 6: Commit.**

```bash
git -C "$WT" add apps/handheld/app/src/main/kotlin/app/markiro/handheld/feature/shift/ShiftCloser.kt \
  apps/handheld/app/src/main/kotlin/app/markiro/handheld/feature/shift/CloseViewModel.kt \
  apps/handheld/app/src/main/kotlin/app/markiro/handheld/feature/shift/CloseScreens.kt \
  apps/handheld/app/src/main/kotlin/app/markiro/handheld/feature/shift/ShiftModule.kt \
  apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/host/HostAckMapper.kt \
  apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/storage/ShiftDaos.kt \
  apps/handheld/app/src/main/res/values/strings.xml apps/handheld/app/src/main/res/values-en/strings.xml \
  apps/handheld/app/src/test/kotlin/app/markiro/handheld/feature/shift/ShiftCloserTest.kt \
  apps/handheld/app/src/test/kotlin/app/markiro/handheld/feature/shift/CloseScreensTest.kt \
  apps/handheld/app/src/test/kotlin/app/markiro/handheld/feature/shift/CloseViewModelTest.kt \
  apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/host/HostAckMapperCloseNoteTest.kt \
  apps/handheld/app/src/test/kotlin/app/markiro/handheld/EnglishRenderTest.kt
git -C "$WT" commit -m "feat(handheld): close only this device's part of a shared shift, ask the reason of the last closer only

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Documentation, the device checklist and the final gates

**Files:**

- Modify: `apps/handheld/README.md` («Shift walk-through against the local API», `:104-109`)
- Modify: `apps/handheld/AGENTS.md` («## Host mode», after the last bullet, `:88-90`)
- Modify: `apps/handheld/CHANGELOG.md` («## Не выпущено», `:8-10`)
- Modify: `docs/runbooks/standalone-handheld-checklist.md` (table rows 9–15, `:14`)

**Interfaces:**

- Consumes: Tasks 1–11.
- Produces: the scoped guide and the hardware checklist the owner runs on a real ТСД.

- [ ] **Step 1: README.** In the walk-through step 4 (`:106-108`) replace «If another device entered the same shift, the summary says the cabinet will close it.» with «On a host with several devices in one shift the item reads «Закрыть свою часть»: the device closes only its own part, the shift closes with the last one (or from the office), and only the last closer is asked for a reason.».

- [ ] **Step 2: AGENTS.md.** Append to «## Host mode»:

```markdown
- Several devices in one shift (plan 2b, host protocol 7; the handheld stays at protocol 6): every entry names
  `multi-station-v1` (`HostApi.ENTER_SUPPORTS`; an older host ignores the name and still answers `shift_busy`,
  shown as «Смена занята»). A full line is `409 shift_line_full {maxStations, active}` (`EnterResult.LineFull`);
  `HostCalls` carries the two numbers to the loaders. The host's `maxStations`, `participants`, `myState`,
  `totals` and `byDevice` are reduced to one JSON value per shift in `meta` (`shift_participation:<id>`,
  `ShiftParticipationStore`; no Room migration) and refreshed by the host heartbeat (`HostParticipation`, 15 s)
  while a shift is active; a beat that does not reach the host marks them stale, and the work strip says
  «данные на ЧЧ:ММ». `SharedShiftRules` is the only place of the shift-wide total and of the reason rule; the
  rule is pinned by `proto/fixtures/shift-close-reason-shared.json`, never re-derived. A closed part reads back as
  `myState: closed` and `toShiftDto` maps it to `status = "closed"`; leaving writes the local mark and an owed-leave
  marker in one commit, then asks the host, and the heartbeat sends it only while the local row is still out.
  Receipts `partClosed`/`reasonMissing` are noted in `meta` by `HostAckMapper`; a shared shift's close never throws
  for a missing reason (the host marks it, the office supplies it), a single-device shift keeps the hard refusal.
```

- [ ] **Step 3: CHANGELOG.** Under «## Не выпущено» append:

```markdown
- Режим «host»: на линии с несколькими устройствами в одной смене ТСД входит в смену, пока есть свободное место, а если линия занята — говорит об этом («На линии уже работают N из M устройств»). На экране работы показано «Всего в смене: K из M» и «Моя смена: N» (без связи — «данные на ЧЧ:ММ»). «Выйти из смены» освобождает место на линии. «Закрыть свою часть» закрывает только часть этого устройства; смена закроется, когда закроют остальные, а причину невыполнения плана спросят у закрывающего последним.
```

- [ ] **Step 4: The device checklist.** In `docs/runbooks/standalone-handheld-checklist.md` append these rows to the table after row 8 (keep the table's column layout; run prettier afterwards):

```markdown
| 9 | Две станции/ТСД в одной смене: линия с «Максимум станций» = 2, станция открыла смену, ТСД входит | ТСД входит; на экране работы «Всего в смене: K из M» и «Моя смена: N»; «Работают: 2 из 2» | |
| 10 | Третье устройство при лимите 2 | «Линия занята», «На линии уже работают 2 из 2 устройств», кнопки входа нет; после выхода одного из двух вход проходит | |
| 11 | Лимит 1 (по умолчанию) на новом хосте, второе устройство входит | Экран работы ТСД без полоски, как раньше; второму устройству «Линия занята» (не «Сервер отказал») | |
| 12 | Хост старой версии (до 1.1.0), второе устройство входит в чужую смену | «Смена занята» словами, не строка «HTTP 409 · shift_busy» | |
| 13 | «Выйти из смены» на ТСД, затем станция занимает место, затем ТСД пытается вернуться | Место освободилось сразу после выхода; ТСД получает «Линия занята», пока оно занято | |
| 14 | Выход из смены без связи с хостом, затем связь возвращается | Выход доходит до хоста сам (место освобождается); повторный вход до возвращения связи отменяет отложенный выход | |
| 15 | Закрыть свою часть: не последним; последним онлайн при невыполненном плане; офлайн | Не последний: причину не спрашивают, «Ваша часть закрыта»; последний онлайн: просят причину по сумме смены; офлайн: закрывает без причины, офис вносит её позже | |
```

(Use the table's own column widths; `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false exec prettier --write docs/runbooks/standalone-handheld-checklist.md` reflows them.) State in the file's intro paragraph nothing new: rows 9–15 are unverified until marked on a device.

- [ ] **Step 5: Check the docs.** Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false exec prettier --check apps/handheld/README.md apps/handheld/AGENTS.md apps/handheld/CHANGELOG.md docs/runbooks/standalone-handheld-checklist.md docs/superpowers/plans/2026-10-20-multi-station-handheld.md` and `git -C "$WT" diff --check`. Expected: clean (run `prettier --write` on a listed file if not).

- [ ] **Step 6: Commit.**

```bash
git -C "$WT" add apps/handheld/README.md apps/handheld/AGENTS.md apps/handheld/CHANGELOG.md docs/runbooks/standalone-handheld-checklist.md
git -C "$WT" commit -m "docs(handheld): several devices in one shift on the handheld, and the checklist rows for a real device

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 7: Final gates** (record every result in the report):
      `"$WT/apps/handheld/gradlew" -p "$WT/apps/handheld" --no-daemon testDebugUnitTest lintDebug assembleDebug`;
      `git -C "$WT" diff --check`;
      `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false format:check` only if a non-handheld file changed (none should);
      `graphify update .` if `graphify-out/graph.json` exists in the worktree.
      Confirm, by reading the diff, that `feature/signin/**`, `core/grants/**`, `core/pallets/**` events, `core/km/**` and the KM/inventory/product-label fixtures are untouched (`git -C "$WT" diff --stat origin/main -- apps/handheld/app/src/main/kotlin/app/markiro/handheld/feature/signin apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/grants apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/km` prints nothing).

  **Not verifiable here** (state it in the report): behaviour on a real ТСД and its vendor scanner service; Wi-Fi roaming and a real LAN to a real host; Android 9 TLS with the pinned certificate (rows 1–8 of the checklist); the host's `leave`, `shift_line_full` and receipt behaviour against a live host of 1.1.0 (this plan reads the host's fixtures, not a running host); the on-screen layout on the handheld's real panel (the added caption lines and the longer menu label are checked by Robolectric at `w360dp` only); the sixteen-device and multi-hour soak (the load plan).

---

## Emulator and device checklist (what this plan's automation does not prove)

Run on an emulator first (debug build), then on a real ТСД; the rows are also in the runbook (Task 12).

| What                                                                                                           | Emulator                                                                    | Real ТСД                            |
| -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------- |
| Join while a slot is free; strip «Всего в смене: K из M», «Моя смена: N», «Работают: A из M»                   | yes: a second client (the host's test harness or a station on the same LAN) | needed for layout on the real panel |
| `shift_line_full` dialog; old host «Смена занята»                                                              | yes, against a host of 1.1.0 with limit 1 and a host of 1.0.0               | no                                  |
| Totals follow the other device's scans within about 15 s; «данные на ЧЧ:ММ» after `adb shell svc wifi disable` | yes                                                                         | needed (real Wi-Fi roaming drops)   |
| Leave frees the slot; leave offline is owed and sent after reconnect; re-enter offline cancels it              | yes                                                                         | no                                  |
| Close own part (not last / last online with a missed plan / offline) and the office's reason entry afterwards  | yes, with the office app                                                    | no                                  |
| Process recreation in the middle of a close and of an owed leave (`adb shell am kill`)                         | yes                                                                         | no                                  |
| Vendor scanner intent and keyboard wedge while the strip refreshes                                             | not provable                                                                | needed                              |
| Printer: label queue and box close unaffected by the heartbeat's extra read                                    | partly (TCP stub)                                                           | needed                              |

---

## Self-Review

**1. Spec coverage** (§6 handheld, §4 host contract as the handheld consumes it, §12.7)

| Spec item                                                                                     | Where                                                                                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §6 «Вход без `busy` при свободном месте»                                                      | Task 3 (capability on every entry), Task 8 (flows), D1, D11                                                                                                                                                                            |
| §6 «общий счётчик по `totals`»                                                                | Tasks 2, 4, 5, 6, 7 (data), Task 10 (strip, stale mark, plan prompt by the shift-wide total)                                                                                                                                           |
| §6 «закрытие своей части»                                                                     | Task 11 (wording, reason rule, receipts, summary), Task 5 (rule + host fixture)                                                                                                                                                        |
| §6 «отображение `shift_line_full`»                                                            | Task 3 (numbers survive `HostCalls`), Task 8 (`LineFull` dialog)                                                                                                                                                                       |
| §6 «Общие фикстуры протокола обновляются в паре с TS»                                         | Tasks 2, 3, 5 read `device-shifts-participants`, `error-shift-line-full`, `error-shift-busy`, `shift-enter-handheld-multi`, `facts-response-part-close`, `shift-close-reason-shared`; Task 1 checks they exist; no handheld-local copy |
| §6 «Склад паллет ТСД (`pallet-events`) не меняется»                                           | untouched; Task 12 Step 7 gate runs the pallet suites and the `git diff --stat` check                                                                                                                                                  |
| §4.2 Вход: re-entry, `left → active`, `shift_line_full`, `shift_busy` for old behaviour       | Tasks 3, 8; D9                                                                                                                                                                                                                         |
| §4.2 Выход → `left`, освобождает место                                                        | Task 3 (`leave`), Task 6 (seam), Task 9 (local mark, owed leave), Task 7 (beat sends it)                                                                                                                                               |
| §4.2 Закрытие своей части; `closed` участник читает смену назад                               | Task 11; Task 6/8 (`myState: closed` → closed on this device, `PartClosed`)                                                                                                                                                            |
| §4.2 План и причина по общему числу, только у закрывающего последним                          | Task 5 (`reasonRequired`, fixture), Task 11 (`preview`, `closeOwned`, screens)                                                                                                                                                         |
| §4.2 Итоги станциям `totals`, `byDevice`, `asOf`                                              | Tasks 2, 4, 7, 10                                                                                                                                                                                                                      |
| §4.3 протокол 7, возможность `multi-station-v1`, handheld остаётся на 6                       | D1; Task 3; Task 1 Step 3; `HostFixturesTest.theHelloEnvelopeDecidesWhoMustUpdate` unchanged                                                                                                                                           |
| §5-parity «Моя станция: N · Всего в смене: K из M» (device-neutral wording)                   | Task 10; D12                                                                                                                                                                                                                           |
| §5 «Офлайн: закрытие своей части в очередь, идемпотентно»                                     | the frozen `shift_closed` record is unchanged (`HostRecordFreezer`); Task 11 receipts; offline close without a reason (D7)                                                                                                             |
| §12.7 «как ТСД сейчас обрабатывает `busy`; считается ли ТСД устройством для правила закрытия» | D9 (answer: generic «Сервер отказал … shift_busy» today; the handheld is a participant of kind `handheld`), Task 8                                                                                                                     |
| §12.9 офлайн-станция не знает, что закрывает последней                                        | D7, Task 5, Task 11 (`reasonMissing` receipt → summary)                                                                                                                                                                                |
| Global: Room migration numbered                                                               | none needed (D2); Task 1 Step 2 records the current number (22)                                                                                                                                                                        |
| Global: sign-in untouched                                                                     | Task 12 Step 7 `git diff --stat` check                                                                                                                                                                                                 |
| RU/EN strings, Compose + JVM + Robolectric tests                                              | every task; `EnglishRenderTest` in Tasks 8, 10, 11                                                                                                                                                                                     |
| Emulator/device checklist and what cannot be tested                                           | the checklist table above and Task 12 Step 4/7                                                                                                                                                                                         |

**2. Placeholder scan.** Searched for «TBD», «TODO», «similar to», «add appropriate», «handle edge cases», «fill in»: none. Every step names exact paths with line ranges, shows the real Kotlin it adds or the exact text it replaces, and the exact Gradle command. Two steps depend on a repository fact the executor must read rather than guess, and say so where they occur: the Hilt annotation-processing task name in Tasks 7 and 11 (`kapt` or `ksp`, listed by `GRADLE :app:tasks --all`), and the name of the repository factory in `ShiftRepositoryTest` in Task 9 (the neighbouring leave test already uses it).

**3. Type consistency.** `ShiftParticipantDto`, `DeviceTotalsDto`, `DeviceShiftTotalsDto` (Task 2) are the only decoders of the host's shapes and feed `toParticipation` (Task 4); `ShiftParticipation` fields (`participantsEver`, `active`, `othersOpen`, `accepted`, `myAccepted`, `asOf`, `fetchedAt`, `stale`) are the ones `SharedShiftRules` (Task 5), `WorkViewModel` (Task 10) and `ShiftCloser` (Task 11) read; `SharedStrip(mine, total, plan, active, maxStations, staleAtMillis)` is built in Task 5 and read in Tasks 10 (screen) and its tests; `ShiftParticipationStore` members (`get`, `observe`, `save`, `markStale`, `markLeavePending`, `pendingLeaves`, `clearLeavePending`, `noteClose`, `closeNote`, `key`, `leaveKey`, `closeNoteKey`, `NOTE_PART_CLOSED`, `NOTE_REASON_MISSING`) match their callers in Tasks 6, 7, 9, 11; `StationBackend.leave` (Task 6) is called by `ShiftRepository.releaseSlot` (Task 9) and overridden by `HostBackend`; `HostFailure.Constraint(name, maxStations, active)` (Task 3) is built by `HostApi.failureOf` and read by `HostCalls`; `ErrorBody(code, maxStations, active)` is read by `ShiftRepository.refusal` (Task 8); `EnterResult.{LineFull, Busy, PartClosed}` map one to one to `ShiftDialog.{LineFull, Busy, PartClosed}` in both `ShiftListViewModel.enter` and `HubViewModel.continueShift` and in `ShiftDialogScreen`'s exhaustive `when`; constructor parameter order keeps every trailing-lambda call valid (`ShiftCloser(db) { clock }`, `ShiftRepository(api, db, json, pool) { clock }`, `HostHeartbeat(…) { refresh }`); JSON names (`maxStations`, `participants`, `myState`, `totals`, `byDevice`, `boxesClosed`, `asOf`, `partClosed`, `reasonMissing`) are identical in the DTOs, the fixtures and the contract.

**Gaps found (for the owner and the host plan):** (1) The host plan says «no Kotlin change … the handheld pins PROTOCOL = 6»; the handheld must in fact change code to name `multi-station-v1`, even though the protocol constant stays 6 (D1). (2) The host contract lists a handheld's names as `["handheld-host-v1","multi-station-v1"]`; the real handheld also names `validation-v1`, which a validation shift needs (D11): the contract text should say «at least». (3) `HostCalls` dropped every refusal detail, so `shift_line_full`'s numbers could not reach the dialog; fixed here. (4) `WorkUi.reachable` reads the cloud reachability tracker, which never moves on a host device: the work screen's network chip is «Офлайн» for a host device whatever the link is. Pre-existing and not fixed here (the strip uses the heartbeat's stale flag instead); worth its own change (`ShiftListViewModel` already takes the host link as an input). (5) No host fixture exists for an `enter` answer that carries `participants`/`myState`; the handheld derives its cases from `device-shift-entered.json` plus the fields. A host fixture `device-shift-entered-participants.json` (and one with `myState: closed`) would remove that derivation. (6) The late `leave` race: a leave request already in flight when the device re-enters can land after the re-entry and free a slot of an active participant; the host's `leave` carries no sequence or `leftAt` guard. A host-side compare (`left_at` or a request id) would close it; the handheld guards everything before the request is sent (D8). (7) Facts of a `left` participant whose slot another device took: the host plan does not say whether they are accepted (a device that left and works offline); the handheld assumes accepted (host D9 «late data is accepted»). (8) The host judges the reason by `shifts.planned_qty` now; the handheld's `shift_mirror.plannedQty` is refreshed only by the shift list, so a plan changed by the office mid-shift can make the handheld ask (or not ask) wrongly: the `reasonMissing` receipt covers the second case, the first costs the operator one unnecessary reason (a given reason is always kept). (9) Totals have no push (host D11): the strip lags the others' scans by up to a beat. (10) Spec wording «Моя станция» vs the handheld's «Моя смена» (D12).
