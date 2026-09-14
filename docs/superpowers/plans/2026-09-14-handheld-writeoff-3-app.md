# Handheld Write-off — Plan 3 of 4: The Android App

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the handheld a **Списание** mode: scan units and boxes, pick one
shared reason, confirm, and file the document through its own durable outbox —
offline first, idempotent on retry, visible in a local history.

**Architecture:** A fourth self-contained mode next to Смена / Инвентаризация /
Настройки. It mirrors the inventory contour's shape exactly: a bootstrap mirror
in Room, a `writeoff_outbox` table of whole documents, a `WriteoffSyncEngine`
that pins each request in `meta` and resends it byte-for-byte, and a feature
module of ViewModels + Compose screens drawn from the `12-writeoff/` mockups.

**Tech Stack:** Kotlin, Jetpack Compose, Room 15→16, Hilt, Retrofit +
kotlinx.serialization, OkHttp `SyncTransport`, Robolectric/JUnit4 + MockWebServer.

**Source spec:** [`2026-09-14-handheld-writeoff-design.md`](../specs/2026-09-14-handheld-writeoff-design.md)
— sections _Handheld_ and _Offline, queue and conflicts_.

**Depends on:** plans 1 and 2, merged. The server routes this app calls already
exist in `main`: `POST /station/writeoffs`, `GET /station/writeoff-bootstrap`,
`GET /station/box-registry`.

## Global Constraints

- Read [`apps/handheld/AGENTS.md`](../../../apps/handheld/AGENTS.md) first. This
  is a Gradle project outside pnpm; a green pnpm run proves nothing here. The
  gate is, from `apps/handheld`:
  `./gradlew --no-daemon testDebugUnitTest lintDebug assembleDebug`.
- `apps/handheld/local.properties` (`sdk.dir=…`) is ignored by git and must
  never be committed.
- Accepted scans, outbox rows, `deviceSeq` and mirror state are **durable
  facts**. A retry resends the same bytes under the same `deviceSeq`; it never
  recreates a document.
- Classify scans through `ScanClassifier` / `KmCodec` only. Do not normalise
  separators or hash inputs independently — Kotlin/TypeScript parity is a
  contract (AGENTS.md _Shared protocol and domain parity_).
- Every user-visible string ships in **both** `res/values/strings.xml` and
  `res/values-en/strings.xml` in the same commit.
- Room schema changes are a version bump plus a hand-written `Migration`
  registered in `StorageModule`; `exportSchema = false`, so there is no schema
  JSON to regenerate.
- Never trust the device's own permission check as the gate: the server
  re-checks `can_writeoff`. The device's check is an affordance that keeps the
  operator out of a mode that would only fail later.
- Prices appear nowhere in this mode.

## What the hub looks like after this plan

The code today has **three** tiles (Смена, Инвентаризация, Настройки); the
`12-writeoff/` mockup drew five because it anticipated «Проверка кода», which
does not exist in code. This plan adds Списание as the **fourth** tile, giving a
clean 2×2 grid, and leaves the Настройки full-width row from the mockup for
whenever a fifth mode really lands. Note the divergence in the commit message so
nobody "fixes" the grid back toward the mockup.

## File Structure

**Created**

| File                                                 | Responsibility                                                                                                           |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `core/storage/WriteoffEntities.kt`                   | `WriteoffOutboxEntity`, `WriteoffReasonEntity`, `WriteoffProductEntity`, `WriteoffPermissionEntity`, `WriteoffBoxEntity` |
| `core/storage/WriteoffDaos.kt`                       | One DAO per table; `observePending()` for the hub                                                                        |
| `core/network/WriteoffDtos.kt`                       | Request/response/bootstrap/registry DTOs                                                                                 |
| `core/writeoff/WriteoffMirror.kt`                    | Bootstrap + box-registry sync into Room, with the «данные на» stamp                                                      |
| `core/writeoff/WriteoffSyncEngine.kt`                | Drains `writeoff_outbox`; pinned, byte-identical, idempotent                                                             |
| `core/writeoff/WriteoffModule.kt`                    | Hilt providers for the mirror and the engine                                                                             |
| `feature/writeoff/WriteoffRepository.kt`             | `WriteoffGateway` interface + implementation                                                                             |
| `feature/writeoff/WriteoffFeatureModule.kt`          | Hilt provider for the gateway                                                                                            |
| `feature/writeoff/WriteoffViewModel.kt`              | The one state machine: list → reason → confirm → result                                                                  |
| `feature/writeoff/WriteoffHistoryViewModel.kt`       | Recent documents with sync state                                                                                         |
| `feature/writeoff/WriteoffScreens.kt`                | Empty, list, reason, confirm, results, blocked states                                                                    |
| `feature/writeoff/WriteoffHistoryScreen.kt`          | History list + read-only document                                                                                        |
| `test/.../core/writeoff/WriteoffSyncEngineTest.kt`   | Outbox survives restart; retry resends the same bytes; outcomes                                                          |
| `test/.../core/writeoff/WriteoffMirrorTest.kt`       | Bootstrap and registry pages land in Room; stamp updates                                                                 |
| `test/.../feature/writeoff/WriteoffViewModelTest.kt` | Scans, duplicates, reason gate, confirm, offline result                                                                  |

**Modified**

| File                                                  | Change                                                                                                                         |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `core/storage/HandheldDatabase.kt`                    | Five entities, five DAO getters, version 16                                                                                    |
| `core/storage/Migrations.kt`                          | `MIGRATION_15_16`                                                                                                              |
| `core/storage/StorageModule.kt`                       | Register `MIGRATION_15_16`                                                                                                     |
| `core/storage/MetaStore.kt`                           | `WRITEOFF_NEXT_DEVICE_SEQ`, `WRITEOFF_LAST_SUCCESS_AT`, `WRITEOFF_BOOTSTRAP_AT`, `WRITEOFF_REGISTRY_UNTIL`, `writeoffPin(seq)` |
| `core/storage/DeviceRecovery.kt`                      | `summary()` gains `"writeoffs"`                                                                                                |
| `core/network/StationApi.kt`                          | Three routes                                                                                                                   |
| `core/sync/SyncModule.kt`                             | `ConnectivityNudger` nudges the write-off engine                                                                               |
| `HandheldApp.kt`                                      | Starts the engine                                                                                                              |
| `feature/hub/HubViewModel.kt`                         | `HubTile.WRITEOFF`, pending sum, permission flag                                                                               |
| `feature/hub/HubScreen.kt`                            | Fourth tile                                                                                                                    |
| `AppNavigation.kt`                                    | Routes + composables                                                                                                           |
| `res/values/strings.xml`, `res/values-en/strings.xml` | All copy                                                                                                                       |
| `test/.../core/storage/DeviceRecoveryTest.kt`         | `summaryUsesEveryActualQueueTable` key set                                                                                     |
| Every test that declares `object : StationApi`        | Three new overrides — see Task 2                                                                                               |

## The data model

Whole documents, not events. A write-off is one atomic thing with one
`deviceSeq`, so the outbox row **is** the document and mirrors
`ShiftCloseEntity` (`state` / `conflictCode` / `lastCheckedAt`) rather than
`InventoryOutboxEntity`:

```kotlin
/** One queued write-off. The row IS the document; `requestJson` is resent byte for byte. */
@Entity(tableName = "writeoff_outbox", indices = [Index(value = ["deviceSeq"], unique = true)])
data class WriteoffOutboxEntity(
    @PrimaryKey val documentId: String,
    val deviceSeq: Long,
    val operatorId: String,
    val reasonId: String,
    val reasonName: String,
    val unitCount: Int,
    val boxCount: Int,
    /** Exact request body. The engine never rebuilds it. */
    val requestJson: String,
    val createdAt: String,
    /** pending → sent | rejected. */
    val state: String,
    val orderNo: String?,
    val acceptedCount: Int?,
    /** JSON of the server's conflicts, for the history screen. Null until acknowledged. */
    val conflictsJson: String?,
    val lastAttemptAt: String?,
)
```

Rows in state `sent`/`rejected` are the **history**; the engine only drains
`pending`. Nothing is deleted on acknowledgement — the spec's «last 20
documents» is a read on this table, and the engine prunes anything past 20 that
is no longer pending.

Mirror tables are plain caches, replaced wholesale on each bootstrap:

```kotlin
@Entity(tableName = "writeoff_reasons")
data class WriteoffReasonEntity(@PrimaryKey val id: String, val name: String, val sortOrder: Int)

@Entity(tableName = "writeoff_products")
data class WriteoffProductEntity(@PrimaryKey val gtin14: String, val name: String)

@Entity(tableName = "writeoff_permissions")
data class WriteoffPermissionEntity(@PrimaryKey val employeeId: String, val canWriteoff: Boolean)

/** Closed boxes from `/station/box-registry`; `contentKeys` is a JSON array of `01…21…` keys. */
@Entity(tableName = "writeoff_boxes")
data class WriteoffBoxEntity(
    @PrimaryKey val sscc: String,
    val boxId: String,
    val productId: String,
    val bottleCount: Int,
    val contentKeysJson: String,
    val updatedAt: String,
)
```

`writeoff_boxes` is keyed by SSCC because that is what the scanner produces; a
`remove` registry item deletes by SSCC. Product **name** for a box is looked up
through `writeoff_products` — the registry carries `productId`, not GTIN, so the
mirror stores the id and the bootstrap's product list must also carry `id`
(plan 1's bootstrap returns `{gtin14, name}` only). **Task 2 adds `id` to
`products[]` on the server side of the bootstrap** — a one-field additive change
to `StationWriteoffBootstrapDto`, so the API and this app move together.

---

### Task 1: Storage — five tables, a migration, and the recovery count

**Files:**

- Create: `core/storage/WriteoffEntities.kt`, `core/storage/WriteoffDaos.kt`
- Modify: `core/storage/HandheldDatabase.kt`, `core/storage/Migrations.kt`,
  `core/storage/StorageModule.kt`, `core/storage/MetaStore.kt`,
  `core/storage/DeviceRecovery.kt`
- Test: `test/.../core/storage/DeviceRecoveryTest.kt`

**Interfaces:**

- Produces: the entities above; `WriteoffOutboxDao` with
  `insert`, `pending(): List`, `observePendingCount(): Flow<Int>`,
  `observeRecent(limit): Flow<List>`, `markSent(documentId, orderNo,
acceptedCount, conflictsJson, at)`, `markRejected(documentId, conflictsJson,
at)`, `touch(documentId, at)`, `pruneSettledBeyond(keep)`;
  `WriteoffReasonDao.replaceAll / all() / observeAll()`;
  `WriteoffProductDao.replaceAll / byGtin`;
  `WriteoffPermissionDao.replaceAll / get(employeeId) / observe(employeeId): Flow<…?>`;
  `WriteoffBoxDao.upsert / remove(sscc) / bySscc / clear`. `MetaStore` keys
  listed in _File Structure_. Task 3's tests call `all()` and Task 5's hub reads
  `observe(...)`, so both the suspend and the `Flow` reads exist from the start.
- Test builders named `writeoff(...)`, `pending(...)`, `pendingWriteoff(...)`
  in later tasks are each **local** to their own test file, not a shared
  fixture; the differing names are deliberate, not drift.
- Consumes: nothing new.

- [x] **Step 1: Write the failing test**

`DeviceRecoveryTest.summaryUsesEveryActualQueueTable` pins the exact key set of
`summary()`. Add `"writeoffs"`:

```kotlin
setOf("scans", "inventory", "labels", "boxes", "pallets", "exceptions", "closes", "conflicts", "unknownPrints", "writeoffs"),
```

And add, in the same file, a test that a pending write-off is counted and a
sent one is not:

```kotlin
@Test fun summaryCountsOnlyPendingWriteoffs() = runTest {
    active()
    db.writeoffOutboxDao().insert(writeoff("d-1", 1, state = "pending"))
    db.writeoffOutboxDao().insert(writeoff("d-2", 2, state = "sent"))
    assertEquals(1L, recovery.summary()["writeoffs"])
}
```

with a small local `writeoff(id, seq, state)` builder returning a
`WriteoffOutboxEntity` with `requestJson = "{}"`.

- [x] **Step 2: Run it and watch it fail**

```bash
cd apps/handheld && ./gradlew --no-daemon testDebugUnitTest --tests '*DeviceRecoveryTest*' -q
```

Expected: compile failure — `writeoffOutboxDao` does not exist.

- [x] **Step 3: Entities, DAOs, database**

Create the entities as in _The data model_. In `WriteoffDaos.kt`:

```kotlin
@Dao
interface WriteoffOutboxDao {
    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insert(row: WriteoffOutboxEntity)

    @Query("SELECT * FROM writeoff_outbox WHERE state = 'pending' ORDER BY deviceSeq")
    suspend fun pending(): List<WriteoffOutboxEntity>

    @Query("SELECT COUNT(*) FROM writeoff_outbox WHERE state = 'pending'")
    fun observePendingCount(): Flow<Int>

    @Query("SELECT * FROM writeoff_outbox ORDER BY deviceSeq DESC LIMIT :limit")
    fun observeRecent(limit: Int): Flow<List<WriteoffOutboxEntity>>

    @Query("SELECT * FROM writeoff_outbox WHERE documentId = :id")
    fun observe(id: String): Flow<WriteoffOutboxEntity?>

    @Query("UPDATE writeoff_outbox SET state = 'sent', orderNo = :orderNo, acceptedCount = :accepted, conflictsJson = :conflicts, lastAttemptAt = :at WHERE documentId = :id")
    suspend fun markSent(id: String, orderNo: String, accepted: Int, conflicts: String, at: String)

    @Query("UPDATE writeoff_outbox SET state = 'rejected', conflictsJson = :conflicts, lastAttemptAt = :at WHERE documentId = :id")
    suspend fun markRejected(id: String, conflicts: String, at: String)

    @Query("UPDATE writeoff_outbox SET lastAttemptAt = :at WHERE documentId = :id")
    suspend fun touch(id: String, at: String)

    /** History keeps the newest `keep` settled rows; pending rows are never pruned. */
    @Query("DELETE FROM writeoff_outbox WHERE state != 'pending' AND documentId NOT IN (SELECT documentId FROM writeoff_outbox WHERE state != 'pending' ORDER BY deviceSeq DESC LIMIT :keep)")
    suspend fun pruneSettledBeyond(keep: Int)
}
```

The other four DAOs are `replaceAll` (a `@Transaction` that clears then inserts)
plus the single read each screen needs. `WriteoffBoxDao` also needs `upsert`,
`remove(sscc)` and `bySscc(sscc)` because the registry is applied as a delta.

In `HandheldDatabase.kt` add the five entity classes to `entities`, five
abstract getters, and bump `HANDHELD_DATABASE_VERSION` to `16`.

- [x] **Step 4: The migration**

In `Migrations.kt`, after `MIGRATION_14_15`:

```kotlin
val MIGRATION_15_16 = object : Migration(15, 16) {
    override fun migrate(db: SupportSQLiteDatabase) {
        db.execSQL("CREATE TABLE IF NOT EXISTS writeoff_outbox (documentId TEXT NOT NULL PRIMARY KEY, deviceSeq INTEGER NOT NULL, operatorId TEXT NOT NULL, reasonId TEXT NOT NULL, reasonName TEXT NOT NULL, unitCount INTEGER NOT NULL, boxCount INTEGER NOT NULL, requestJson TEXT NOT NULL, createdAt TEXT NOT NULL, state TEXT NOT NULL, orderNo TEXT, acceptedCount INTEGER, conflictsJson TEXT, lastAttemptAt TEXT)")
        db.execSQL("CREATE UNIQUE INDEX IF NOT EXISTS index_writeoff_outbox_deviceSeq ON writeoff_outbox (deviceSeq)")
        db.execSQL("CREATE TABLE IF NOT EXISTS writeoff_reasons (id TEXT NOT NULL PRIMARY KEY, name TEXT NOT NULL, sortOrder INTEGER NOT NULL)")
        db.execSQL("CREATE TABLE IF NOT EXISTS writeoff_products (gtin14 TEXT NOT NULL PRIMARY KEY, name TEXT NOT NULL)")
        db.execSQL("CREATE TABLE IF NOT EXISTS writeoff_permissions (employeeId TEXT NOT NULL PRIMARY KEY, canWriteoff INTEGER NOT NULL)")
        db.execSQL("CREATE TABLE IF NOT EXISTS writeoff_boxes (sscc TEXT NOT NULL PRIMARY KEY, boxId TEXT NOT NULL, productId TEXT NOT NULL, bottleCount INTEGER NOT NULL, contentKeysJson TEXT NOT NULL, updatedAt TEXT NOT NULL)")
    }
}
```

Room validates the migrated schema against the entities at open, so a column
mismatch fails loudly in the Robolectric tests rather than in the field. Register
it in `StorageModule.addMigrations(...)` after `MIGRATION_14_15`.

- [x] **Step 5: MetaStore keys and the recovery count**

Add to `MetaStore.Companion`:

```kotlin
const val WRITEOFF_NEXT_DEVICE_SEQ = "writeoff_next_device_seq"
const val WRITEOFF_LAST_SUCCESS_AT = "writeoff_last_success_at"
const val WRITEOFF_BOOTSTRAP_AT = "writeoff_bootstrap_at"
const val WRITEOFF_REGISTRY_UNTIL = "writeoff_registry_until"
/** The in-flight document, so a retry re-sends the same row and nothing else. */
fun writeoffPin(documentId: String) = "writeoff_pending:$documentId"
```

In `DeviceRecovery.summary()` add
`"writeoffs" to count("writeoff_outbox", "state = 'pending'")`.

- [x] **Step 6: Run the tests**

```bash
./gradlew --no-daemon testDebugUnitTest --tests '*DeviceRecoveryTest*' -q
```

Expected: PASS, both the key-set test and the new count test.

- [x] **Step 7: Commit**

```bash
git add apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/storage apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/storage/DeviceRecoveryTest.kt
git commit -m "feat(handheld): write-off storage — outbox, mirrors, migration 15→16"
```

---

### Task 2: Network — DTOs, three routes, and the fake cascade

**Files:**

- Create: `core/network/WriteoffDtos.kt`
- Modify: `core/network/StationApi.kt`
- Modify (server, one field): `apps/api/src/modules/station-writeoffs/dto.ts`,
  `station-writeoffs.service.ts`, `apps/api/test/station-writeoffs.e2e.test.ts`
- Modify: every test file declaring `object : StationApi` (the count is printed
  by the command in Step 3)

**Interfaces:**

- Produces:

```kotlin
@Serializable data class WriteoffItemDto(val rawKm: String)
@Serializable data class WriteoffBoxDto(val sscc: String)
@Serializable
data class WriteoffRequestDto(
    val deviceSeq: Long, val operatorId: String, val writeoffReasonId: String,
    val items: List<WriteoffItemDto>, val boxes: List<WriteoffBoxDto>, val createdAt: String,
)
@Serializable data class WriteoffConflictDto(val rawKm: String, val reason: String)
@Serializable data class WriteoffBoxConflictDto(val sscc: String, val bottleCount: Int? = null, val reason: String)
@Serializable data class WriteoffAcceptedBoxDto(val sscc: String, val bottleCount: Int)
@Serializable
data class WriteoffResultDto(
    val orderNo: String, val status: String, val itemCount: Int,
    val conflicts: List<WriteoffConflictDto>, val boxConflicts: List<WriteoffBoxConflictDto>,
    val acceptedBoxes: List<WriteoffAcceptedBoxDto>,
)
@Serializable data class WriteoffReasonDto(val id: String, val name: String, val sortOrder: Int)
@Serializable data class WriteoffProductDto(val id: String, val gtin14: String, val name: String)
@Serializable data class WriteoffOperatorDto(val employeeId: String, val canWriteoff: Boolean)
@Serializable
data class WriteoffBootstrapDto(
    val generatedAt: String, val reasons: List<WriteoffReasonDto>,
    val products: List<WriteoffProductDto>, val operators: List<WriteoffOperatorDto>,
)
@Serializable
data class BoxRegistryItemDto(
    val kind: String, val sscc: String, val updatedAt: String,
    val boxId: String? = null, val productId: String? = null, val bottleCount: Int? = null,
    val contentKeys: List<String>? = null,
)
@Serializable data class BoxRegistryPageDto(val until: String, val items: List<BoxRegistryItemDto>, val nextCursor: String? = null)
```

and on `StationApi`:

```kotlin
@GET("station/writeoff-bootstrap")
suspend fun writeoffBootstrap(): WriteoffBootstrapDto

@GET("station/box-registry")
suspend fun boxRegistry(@Query("since") since: String?, @Query("until") until: String?, @Query("cursor") cursor: String?, @Query("limit") limit: Int): BoxRegistryPageDto
```

`POST /station/writeoffs` is **not** on `StationApi`: the engine sends it
through `SyncTransport` so the bytes are exactly the pinned `requestJson`.
Retrofit would re-serialise and could reorder or reformat.

- [x] **Step 1: Add `id` to the server bootstrap products**

In `apps/api/src/modules/station-writeoffs/dto.ts`, `products` becomes
`{ id: string; gtin14: string; name: string }[]`; in the service select
`id: schema.products.id` too; update `stationWriteoffBootstrapOpenApiSchema`
and the e2e assertion to expect `id`. Additive, so plan 1's contract survives.

```bash
set -a; source .env; set +a
pnpm --filter @markiro/api exec vitest run test/station-writeoffs.e2e.test.ts test/openapi-docs.test.ts
```

Expected: PASS.

- [x] **Step 2: Write a DTO parse test**

`test/.../core/network/WriteoffDtosTest.kt`: decode a real bootstrap body and a
registry page with one `upsert` and one `remove` through the app's `@Strict`
`Json`, asserting `remove` leaves `boxId` null. This is the parity check that a
server field rename breaks the app in a test rather than in the field.

- [x] **Step 3: Add the routes and fix the fakes**

Adding two methods to `StationApi` fails compilation of every
`object : StationApi` in the tests. Enumerate them:

```bash
grep -rl 'object : StationApi' app/src/test
```

Add to each:

```kotlin
override suspend fun writeoffBootstrap(): app.markiro.handheld.core.network.WriteoffBootstrapDto = error("Unused")
override suspend fun boxRegistry(since: String?, until: String?, cursor: String?, limit: Int): app.markiro.handheld.core.network.BoxRegistryPageDto = error("Unused")
```

This is mechanical and the compiler lists every site.

- [x] **Step 4: Run and commit**

```bash
./gradlew --no-daemon testDebugUnitTest -q
```

Expected: PASS (the fakes compile; nothing else changed).

```bash
git add apps/handheld apps/api
git commit -m "feat(handheld): write-off DTOs and routes; bootstrap products carry id"
```

---

### Task 3: The mirror — bootstrap and box registry into Room

**Files:**

- Create: `core/writeoff/WriteoffMirror.kt`, `core/writeoff/WriteoffModule.kt`
- Test: `test/.../core/writeoff/WriteoffMirrorTest.kt`

**Interfaces:**

- Produces: `class WriteoffMirror(api, db, meta, clock)` with
  `suspend fun refresh(): MirrorOutcome` (`Ok`, `Offline`, `Failed`) and
  `val stampAt: Flow<Long?>` (from `WRITEOFF_BOOTSTRAP_AT`). `refresh()` fetches
  the bootstrap, replaces the three cache tables in one transaction, then walks
  the registry from `WRITEOFF_REGISTRY_UNTIL` (delta) or from nothing (full
  snapshot on first run), applying `upsert`/`remove` per page and storing the
  new `until` only after the last page. `RecoveryBlocked` propagates like every
  other engine.
- Consumes: Task 1 tables and keys, Task 2 routes.

- [x] **Step 1: Write the failing tests**

With `MockWebServer`, following `InventorySyncEngineTest`'s harness:

```kotlin
@Test fun bootstrapReplacesCachesAndStamps() = runTest {
    server.enqueue(MockResponse().setBody(BOOTSTRAP_JSON))
    server.enqueue(MockResponse().setBody("""{"until":"7","items":[]}"""))
    assertEquals(MirrorOutcome.Ok, mirror.refresh())
    assertEquals(listOf("Бой", "Просрочка"), db.writeoffReasonDao().all().map { it.name })
    assertEquals("Вода 0,5 л", db.writeoffProductDao().byGtin("04600682000013")?.name)
    assertTrue(db.writeoffPermissionDao().get("op-1")!!.canWriteoff)
    assertEquals("7", meta.get(MetaStore.WRITEOFF_REGISTRY_UNTIL))
    assertNotNull(meta.get(MetaStore.WRITEOFF_BOOTSTRAP_AT))
}

@Test fun registryDeltaAppliesUpsertAndRemove() = runTest {
    db.writeoffBoxDao().upsert(box("046000000000000018", bottles = 20))
    meta.put(MetaStore.WRITEOFF_REGISTRY_UNTIL, "7")
    server.enqueue(MockResponse().setBody(BOOTSTRAP_JSON))
    server.enqueue(MockResponse().setBody("""{"until":"9","items":[{"kind":"remove","sscc":"046000000000000018","updatedAt":"t"},{"kind":"upsert","sscc":"046000000000000025","boxId":"b2","productId":"p1","bottleCount":12,"contentKeys":["01046000000000002521A"],"updatedAt":"t"}]}"""))
    mirror.refresh()
    assertNull(db.writeoffBoxDao().bySscc("046000000000000018"))
    assertEquals(12, db.writeoffBoxDao().bySscc("046000000000000025")?.bottleCount)
    assertEquals("9", meta.get(MetaStore.WRITEOFF_REGISTRY_UNTIL))
    val request = server.takeRequest(); server.takeRequest().let { assertTrue(it.path!!.contains("since=7")) }
}

@Test fun offlineLeavesCachesUntouched() = runTest {
    db.writeoffReasonDao().replaceAll(listOf(WriteoffReasonEntity("r1", "Старая", 0)))
    server.shutdown()
    assertEquals(MirrorOutcome.Offline, mirror.refresh())
    assertEquals("Старая", db.writeoffReasonDao().all().single().name)
}
```

- [x] **Step 2: Run, expect compile failure, implement**

The registry walk must pass `until` unchanged on cursor pages — the server
rejects a changed one — and must not persist `WRITEOFF_REGISTRY_UNTIL` until the
final page, or a crash mid-walk would skip the tail on the next run.

- [x] **Step 3: Hilt**

`core/writeoff/WriteoffModule.kt` provides `WriteoffMirror` as a singleton from
`StationApi`, `HandheldDatabase`, `MetaStore`.

- [x] **Step 4: Run and commit**

```bash
./gradlew --no-daemon testDebugUnitTest --tests '*WriteoffMirrorTest*' -q
git add apps/handheld
git commit -m "feat(handheld): mirror the write-off bootstrap and box registry"
```

---

### Task 4: The engine — pinned, byte-identical, idempotent

**Files:**

- Create: `core/writeoff/WriteoffSyncEngine.kt`
- Modify: `core/writeoff/WriteoffModule.kt`, `core/sync/SyncModule.kt`,
  `HandheldApp.kt`
- Test: `test/.../core/writeoff/WriteoffSyncEngineTest.kt`

**Interfaces:**

- Produces: `class WriteoffSyncEngine(db, meta, transport, json, scope, clock)`
  with `state: StateFlow<WriteoffSyncState(pending, lastSuccessAt, stuck)>`,
  `start()`, `nudge()`, `drainAll(): Boolean`. Same shape as
  `InventorySyncEngine` so the hub sums it the same way.
- Consumes: `WriteoffOutboxDao`, `SyncTransport`, `MetaStore.writeoffPin`.

**Behaviour, precisely:**

1. `drainOnce`: take the oldest `pending` row. If `writeoffPin(documentId)` is
   absent, write it (the pin is just a marker — the bytes are already in
   `requestJson`). `transport.post("/station/writeoffs", row.requestJson)`.
2. `2xx` → decode `WriteoffResultDto`. `markSent(orderNo, itemCount,
conflictsJson)`. A replay for an already-filed `deviceSeq` returns the same
   `orderNo` — that is the server's idempotency, and the engine does nothing
   special for it.
3. `400`/`422` → **terminal**: `markRejected` with the error body. The server
   has decided (archived reason, all lines refused, unknown operator); retrying
   would only re-ask the same question. This is the `TERMINAL_STATUSES` idea the
   kiosk's worker uses.
4. `401`/`403` → terminal too, but surface `denied` in state so the hub can
   show it; the operator lost the permission or the device its key.
5. Anything else (`5xx`, transport failure) → `touch(lastAttemptAt)`, return
   `FAILED`, back off. The row stays `pending`.
6. After any settle: `pruneSettledBeyond(20)`.

- [ ] **Step 1: Write the failing tests**

```kotlin
@Test fun sendsPendingDocumentAndMarksSent() = runTest {
    db.writeoffOutboxDao().insert(pending("d-1", seq = 1, body = """{"deviceSeq":1,"operatorId":"op-1","writeoffReasonId":"r1","items":[{"rawKm":"x"}],"boxes":[],"createdAt":"t"}"""))
    server.enqueue(MockResponse().setBody("""{"orderNo":"ORD-26-0417","status":"pending","itemCount":1,"conflicts":[],"boxConflicts":[],"acceptedBoxes":[]}"""))
    assertTrue(engine.drainAll())
    val row = db.writeoffOutboxDao().observe("d-1").first()!!
    assertEquals("sent", row.state); assertEquals("ORD-26-0417", row.orderNo); assertEquals(1, row.acceptedCount)
    assertEquals(0, engine.state.value.pending)
}

@Test fun retryResendsTheSameBytes() = runTest {
    val body = """{"deviceSeq":2,"operatorId":"op-1","writeoffReasonId":"r1","items":[{"rawKm":"y"}],"boxes":[],"createdAt":"t"}"""
    db.writeoffOutboxDao().insert(pending("d-2", seq = 2, body = body))
    server.enqueue(MockResponse().setResponseCode(503))
    assertFalse(engine.drainAll())
    assertEquals("pending", db.writeoffOutboxDao().observe("d-2").first()!!.state)
    server.enqueue(MockResponse().setBody(OK_RESULT))
    assertTrue(engine.drainAll())
    assertEquals(body, server.takeRequest().body.readUtf8())
    assertEquals(body, server.takeRequest().body.readUtf8())
}

@Test fun serverRejectionIsTerminal() = runTest {
    db.writeoffOutboxDao().insert(pending("d-3", seq = 3, body = "{}"))
    server.enqueue(MockResponse().setResponseCode(400).setBody("""{"message":"Unknown or archived writeoff reason"}"""))
    engine.drainAll()
    assertEquals("rejected", db.writeoffOutboxDao().observe("d-3").first()!!.state)
    assertEquals(0, server.requestCount - 1)  // no second attempt
}

@Test fun partialAcceptanceKeepsTheConflicts() = runTest {
    db.writeoffOutboxDao().insert(pending("d-4", seq = 4, body = "{}", units = 2))
    server.enqueue(MockResponse().setBody("""{"orderNo":"ORD-26-0418","status":"pending","itemCount":1,"conflicts":[{"rawKm":"dup","reason":"duplicate"}],"boxConflicts":[],"acceptedBoxes":[]}"""))
    engine.drainAll()
    val row = db.writeoffOutboxDao().observe("d-4").first()!!
    assertEquals(1, row.acceptedCount); assertTrue(row.conflictsJson!!.contains("duplicate"))
}

@Test fun pendingSurvivesEngineRestart() = runTest {
    db.writeoffOutboxDao().insert(pending("d-5", seq = 5, body = "{}"))
    val second = WriteoffSyncEngine(db, meta, transport, json, engineScope) { clock }
    assertEquals(1, second.state.first { it.pending == 1 }.pending)
}
```

- [ ] **Step 2: Run, expect compile failure, implement the engine**

Port `InventorySyncEngine`'s skeleton: `nudges` channel, `drainMutex`,
`started`, `state` from `observePendingCount()` + `lastSuccess` + `now`,
`start()` heartbeat loop with `Backoff`, `db.recovery.work {}` around each
drain and `db.recovery.commit {}` around each write. Drop the batch/pin-digest
machinery — a document is already one request, and `requestJson` is the pin.

- [ ] **Step 3: Wire it**

`WriteoffModule` provides the engine with a `SyncTransport(client) { serverUrl.current() }`
exactly as `SyncModule.syncEngine` does. In `SyncModule.connectivityNudger` add
`writeoff.nudge()`. In `HandheldApp.onCreate` add `writeoffSync.start()` beside
`inventorySync.start()`.

- [ ] **Step 4: Run and commit**

```bash
./gradlew --no-daemon testDebugUnitTest --tests '*WriteoffSyncEngineTest*' -q
git add apps/handheld
git commit -m "feat(handheld): write-off sync engine — pinned, byte-identical, idempotent"
```

---

### Task 5: The hub — tile, queue, permission

**Files:**

- Modify: `feature/hub/HubViewModel.kt`, `feature/hub/HubScreen.kt`,
  `AppNavigation.kt`, `res/values/strings.xml`, `res/values-en/strings.xml`
- Test: `test/.../feature/hub/HubViewModelTest.kt`

**Interfaces:**

- Produces: `HubTile.WRITEOFF`; `HubUi.writeoffPending: Int`,
  `HubUi.canWriteoff: Boolean?` (null = mirror never ran);
  `Routes.WRITEOFF = "writeoff"`, `Routes.WRITEOFF_HISTORY = "writeoff/history"`.
- Consumes: `WriteoffSyncEngine.state`, `WriteoffPermissionDao.get(operatorId)`.

- [ ] **Step 1: Write the failing test**

In `HubViewModelTest`, following its harness (the VM constructor gains
`writeoffSync: WriteoffSyncEngine` and `permissions: WriteoffPermissionDao`):

```kotlin
@Test fun hubSumsWriteoffQueueAndReadsPermission() = runTest {
    db.writeoffPermissionDao().replaceAll(listOf(WriteoffPermissionEntity("op-1", true)))
    db.writeoffOutboxDao().insert(pendingWriteoff("d-1", 1))
    val vm = vm()
    val ui = vm.state.first { it.writeoffPending == 1 }
    assertEquals(1, ui.queue)
    assertEquals(true, ui.canWriteoff)
}
```

- [ ] **Step 2: Implement**

`HubViewModel.state` already `combine`s ten flows into a `values` array; append
`writeoffSync.state` and `permissions.observe(operatorId)`, and:

```kotlin
queue = syncState.pending + inventoryState.pending + writeoffState.pending,
stuck = syncState.stuck || inventoryState.stuck || writeoffState.stuck,
writeoffPending = writeoffState.pending,
canWriteoff = permission?.canWriteoff,
```

`HubScreen`: fourth `Tile` after Инвентаризация. The icon is from
`material-icons-extended`, which the screen already uses (`Factory`,
`Inventory2`); if `RemoveShoppingCart` does not resolve, any extended outlined
icon that reads as "take out of stock" is fine — the name is not load-bearing.

```kotlin
{ modifier ->
    Tile(
        Icons.Outlined.RemoveShoppingCart,
        stringResource(R.string.hub_tile_writeoff),
        when {
            state.canWriteoff == false -> stringResource(R.string.hub_writeoff_no_permission)
            state.writeoffPending > 0 -> pluralStringResource(R.plurals.hub_writeoff_pending, state.writeoffPending, state.writeoffPending)
            else -> ""
        },
        { onTile(HubTile.WRITEOFF) },
        modifier,
        statusTone = when { state.canWriteoff == false -> Tone.Warn; state.writeoffPending > 0 -> Tone.Warn; else -> Tone.Neutral },
    )
},
```

`AppNavigation`: `HubTile.WRITEOFF -> nav.navigate(Routes.WRITEOFF)`.

Strings (`ru` / `en`): `hub_tile_writeoff` «Списание» / "Write-off";
`hub_writeoff_no_permission` «нет прав» / "no permission";
`plurals hub_writeoff_pending` «%d не отправлен(о/ы)» / "%d not sent".

- [ ] **Step 3: Run and commit**

```bash
./gradlew --no-daemon testDebugUnitTest --tests '*HubViewModelTest*' -q
git add apps/handheld
git commit -m "feat(handheld): the Списание tile — queue, permission, route"
```

---

### Task 6: The mode — ViewModel state machine and screens

**Files:**

- Create: `feature/writeoff/WriteoffRepository.kt`,
  `feature/writeoff/WriteoffFeatureModule.kt`,
  `feature/writeoff/WriteoffViewModel.kt`,
  `feature/writeoff/WriteoffScreens.kt`,
  `feature/writeoff/WriteoffHistoryViewModel.kt`,
  `feature/writeoff/WriteoffHistoryScreen.kt`
- Modify: `AppNavigation.kt`, both `strings.xml`
- Test: `test/.../feature/writeoff/WriteoffViewModelTest.kt`

**Interfaces:**

- `WriteoffGateway` (faked in tests):

```kotlin
interface WriteoffGateway {
    fun observeReasons(): Flow<List<WriteoffReasonEntity>>
    suspend fun productName(gtin14: String): String?
    suspend fun box(sscc: String): WriteoffBoxEntity?
    suspend fun canWriteoff(operatorId: String): Boolean?
    val stampAt: Flow<Long?>
    suspend fun refreshMirror(): MirrorOutcome
    /** Assigns the next deviceSeq, freezes the request bytes, inserts the row, nudges the engine. */
    suspend fun file(operatorId: String, reasonId: String, reasonName: String, lines: List<WriteoffLine>): String
    fun observeDocument(id: String): Flow<WriteoffOutboxEntity?>
    fun observeRecent(): Flow<List<WriteoffOutboxEntity>>
}
```

- `WriteoffLine` = `Unit(km: ParsedKm, name: String)` | `Box(sscc, name, count, contentKeys)`.
- `WriteoffUi`:

```kotlin
data class WriteoffUi(
    val step: Step = Step.LIST,          // LIST, REASON, CONFIRM, RESULT
    val lines: List<WriteoffLine> = emptyList(),
    val unitCount: Int = 0, val boxCount: Int = 0,
    val lastVerdict: Verdict? = null,    // Accepted(tail) | Duplicate(tail) | UnknownProduct | UnknownBox | NotACode
    val reasons: List<WriteoffReasonEntity> = emptyList(),
    val selectedReason: WriteoffReasonEntity? = null,
    val operatorName: String = "",
    val blocked: Blocked? = null,        // NoPermission | NoReasons | NeverSynced
    val stampAt: Long? = null,
    val filedDocumentId: String? = null,
)
```

**`file()` is the one place `deviceSeq` is minted**, inside a single
`db.recovery.commit {}`: read `WRITEOFF_NEXT_DEVICE_SEQ` (default 1), build the
`WriteoffRequestDto`, encode it **once** with the app's `Json` into
`requestJson`, insert the outbox row, write back `seq + 1`. Then
`engine.nudge()`. If the process dies between the insert and the nudge, the
heartbeat drains it; if it dies before the commit, nothing was minted. This is
the whole offline guarantee, and it is one transaction.

- [ ] **Step 1: Write the failing ViewModel tests**

With a `FakeWriteoffGateway` and a `ScanRouterAdapter(flow)`:

Two written out in full, so the shape is unambiguous; the rest follow it:

```kotlin
private val scans = MutableSharedFlow<ScanEvent>(extraBufferCapacity = 8)
private val gateway = FakeWriteoffGateway(products = mapOf(GTIN to "Вода 0,5 л"), canWriteoff = true, reasons = listOf(REASON))
private fun vm() = WriteoffViewModel(gateway, session, ScanRouterAdapter(scans), recovery)

@Test fun unitScanAddsALineAndNamesTheProduct() = runTest {
    val vm = vm()
    scans.emit(ScanEvent(raw = km("A"), symbology = null, source = "debug", at = clock))
    val ui = vm.state.first { it.unitCount == 1 }
    assertEquals(Verdict.Accepted(tail = km("A").takeLast(6)), ui.lastVerdict)
    assertEquals("Вода 0,5 л", (ui.lines.single() as WriteoffLine.Unit).name)
}

@Test fun confirmFilesThroughTheGatewayAndShowsTheResult() = runTest {
    val vm = vm()
    scans.emit(ScanEvent(raw = km("B"), at = clock, source = ScanSource.DEBUG))
    vm.state.first { it.unitCount == 1 }
    vm.next(); vm.selectReason(REASON); vm.toConfirm(); vm.confirm()
    val ui = vm.state.first { it.step == Step.RESULT }
    assertEquals(1, gateway.filed.size)
    assertEquals(REASON.id, gateway.filed.single().reasonId)
    assertNotNull(ui.filedDocumentId)
}
```

Check `ScanEvent`'s real constructor in `core/scan` before writing these — the
field names above are the ones `InventoryListViewModel` consumes, but verify.

```kotlin
@Test fun sameUnitTwiceIsADuplicateNotASecondLine()      // lastVerdict Duplicate, unitCount still 1
@Test fun unitInsideAnAlreadyListedBoxIsADuplicate()     // box contentKeys contains the KM key
@Test fun unknownGtinIsRefusedWithoutALine()             // lastVerdict UnknownProduct
@Test fun boxScanAddsABoxLineWithItsCount()              // boxCount 1, unitCount unchanged
@Test fun nextIsDisabledWithNoLinesAndConfirmWithoutReason()
@Test fun confirmFilesThroughTheGatewayAndShowsTheResult() // filedDocumentId set, step RESULT
@Test fun noPermissionBlocksTheModeBeforeAnyScan()
@Test fun neverSyncedBlocksTheModeInsteadOfLettingAScanThrough()
```

Each is short: emit into the scan flow, assert on `vm.state.first { … }`.

- [ ] **Step 2: Implement the ViewModel**

Scan handling:

```kotlin
when (val input = ScanClassifier.classify(event.raw)) {
    is ScanInput.Km -> addUnit(input.km)
    is ScanInput.Sscc -> addBox(input.sscc)
    is ScanInput.Gtin, is ScanInput.Unknown -> verdict(Verdict.NotACode)
}
```

`addUnit`: `KmCodec.key(km)` against every line's keys (a box line contributes
its `contentKeys`) → `Duplicate`; else `gateway.productName(km.gtin14)` null →
`UnknownProduct`; else append. `addBox`: `gateway.box(sscc)` null →
`UnknownBox`; any of its `contentKeys` already listed → `Duplicate`; else append.

`confirm()`: guarded by `selectedReason != null && lines.isNotEmpty()`; calls
`gateway.file(...)`, then `step = RESULT`, and observes the document so the
result screen flips from «В очереди» to the act number when the engine settles it.

- [ ] **Step 3: Screens**

`WriteoffScreens.kt`, one composable per mockup frame, built from
`ScreenColumn`, `StatusStrip`, `AppBar`, `PrimaryButton`, `DestructiveButton`,
`Banner`, `FullScreenState`, `MarkiroChip`, plus two local composables in the
style of `InventoryWorkScreen`'s `LastZone`/`Counter`:

| Frame                                       | Composable                      | Notes                                                                                                                  |
| ------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `12-writeoff/empty`                         | `WriteoffListScreen` (no lines) | «Отсканируйте код или короб», note «Причину укажете перед подтверждением»                                              |
| `12-writeoff/list`                          | `WriteoffListScreen`            | compact verdict, counters, rows, «Далее»                                                                               |
| `12-writeoff/reason`                        | `WriteoffReasonScreen`          | 2-column grid of reasons, 6 per page, «Подтвердить» disabled until one is chosen                                       |
| `12-writeoff/confirm`                       | `WriteoffConfirmScreen`         | summary, warn banner «Отменить с ТСД нельзя», **`DestructiveButton`** «Списать N шт»                                   |
| `12-writeoff/done*`                         | `WriteoffResultScreen`          | one composable, three looks: pending («В очереди»), sent («Списано» + act), partial («Списано X из Y» + rejected list) |
| `no-permission`, `no-reasons`, never-synced | `FullScreenState`               | «В хаб»                                                                                                                |
| `12-writeoff/history`                       | `WriteoffHistoryScreen`         | rows with state chip; tap → read-only document                                                                         |

No `SignalOverlay` in this mode — the spec says why. Hardware Back from LIST
with lines asks «Очистить список?» before leaving; from REASON/CONFIRM it steps
back, not out.

- [ ] **Step 4: Navigation and strings**

`AppNavigation`: `composable(Routes.WRITEOFF)` hosting one `WriteoffViewModel`
across the four steps (the step is state, not a route — Back is handled in the
VM), and `composable(Routes.WRITEOFF_HISTORY)`. All copy in both `strings.xml`
files under a `writeoff_` prefix; take the Russian from the mockups verbatim.

- [ ] **Step 5: Run and commit**

```bash
./gradlew --no-daemon testDebugUnitTest --tests '*WriteoffViewModelTest*' -q
git add apps/handheld
git commit -m "feat(handheld): the Списание mode — list, reason, confirm, result, history"
```

---

### Task 7: The gate

- [ ] **Step 1: Full Android gates**

```bash
cd apps/handheld && ./gradlew --no-daemon testDebugUnitTest lintDebug assembleDebug
```

Expected: all three green. Record the counts.

- [ ] **Step 2: The one API change**

```bash
set -a; source .env; set +a
pnpm --filter @markiro/api test && pnpm --filter @markiro/api typecheck && pnpm --filter @markiro/api lint && pnpm --filter @markiro/api build
pnpm format:check
```

- [ ] **Step 3: Emulator smoke, honestly scoped**

If an emulator is available, install the debug APK and drive the mode with the
README's debug broadcast:

```bash
adb shell "am broadcast -a app.markiro.handheld.DEBUG_SCAN --es data '010460068200001321abc<GS>93AbCd'"
adb shell "am broadcast -a app.markiro.handheld.DEBUG_SCAN --es data '00346006820000000014'"
```

Then `adb shell svc wifi disable`, confirm a document, `adb shell am force-stop
app.markiro.handheld`, reopen, `svc wifi enable`, and watch the history row go
from «В очереди» to the act number. **State in the report whether this was done.**
A green Robolectric run proves the state machine, not the scanner, the vendor
intent, or the real device's screen.

- [ ] **Step 4: Commit anything the gates changed**, then hand off to
      `finishing-a-development-branch`.

## Done when

- The hub shows Списание; without `can_writeoff` the tile says so and the mode
  blocks before any scan.
- A unit or a closed box scans into the list; duplicates and unknowns are
  refused with a compact verdict; no price is shown anywhere.
- One shared reason is required; confirm is destructive-styled.
- The document lands in `writeoff_outbox` with a minted `deviceSeq` in one
  transaction, survives process death, is resent byte-for-byte, and settles to
  `sent` (act number) or `rejected` (server's reason).
- `DeviceRecovery.summary()["writeoffs"]` counts pending documents.
- History shows the last 20 with their state; partial acceptance names what was
  refused.
- `testDebugUnitTest lintDebug assembleDebug` is green; both string files are
  complete.

## Not in this plan

Printing an act from the device; Chestny ZNAK reporting; cancelling a filed
write-off; pallets; a «Проверка кода» tile (the mockup's fifth); surfacing the
handheld's line in the cabinet. The full-width Настройки row from the mockup is
deferred until a fifth mode exists.
