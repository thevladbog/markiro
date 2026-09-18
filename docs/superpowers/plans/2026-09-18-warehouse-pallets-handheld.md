# Warehouse Pallets — Plan 2 of 3: Handheld (ТСД) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the handheld a «Паллеты» mode in which an operator scans SSCCs of already-closed boxes onto a device-owned `warehouse` pallet, closes it at capacity or early with a printed label, and syncs memberships and closures through the existing batch, showing per-box refusals from the server.

**Architecture:** Room migration 17→18 widens `pallets` (kind/product/device, nullable shift), renames the write-off box mirror into a shared `box_registry` with the station feed's pallet fields, and adds `pallet_memberships` plus three bootstrap caches. A `PalletBootstrapMirror` fills the caches and the extension-1 serial pool from `GET /station/pallet-bootstrap`; a `BoxRegistryMirror` (the write-off mirror's registry half, renamed) keeps the registry. `SyncEngine` gains a pinned `palletMemberships` channel with a per-record outcome parse. `ClosePallet`/`PalletPrinter` gain warehouse entry points that read the bootstrap caches instead of the shift. A new `feature/pallets` screen owns scans while open, mirrors the write-off gate/verdict UX, and reuses the pallet close/print screens.

**Tech Stack:** Kotlin, Jetpack Compose, Room 2.x (hand-written migrations), Hilt, kotlinx.serialization, Retrofit/OkHttp, JUnit4 + Robolectric + MockWebServer, Gradle (`apps/handheld`, outside the pnpm workspace).

**Spec:** `docs/superpowers/specs/2026-09-17-warehouse-pallet-aggregation-design.md` §3 (plus §2.1, §2.2, §2.4 for the wire contract). Server side is merged in PR #595.

## Global Constraints

- Every Room write goes through `db.recovery.commit { }` / `work { }` / `exclusive { }` / `printing { }`; lock order is lease → `PalletLock` → transaction (see `ClosePallet`).
- Sync: a batch in flight re-reads the pinned set; a missing pin count means 0; every channel's id set is folded into the batch id via `idSignature`; retries are byte-identical. Wire literals: `MAX_PALLET_MEMBERSHIPS = 100` (server `MAX_PALLET_MEMBERSHIPS_PER_SYNC_BATCH`), pinned by `sync-limits-fixtures.json` key `maxPalletMembershipsPerSyncBatch`.
- Wire shapes (server, PR #595): membership `{ palletId, boxSscc (18 digits), addedAt (ISO), operatorId | null }`; warehouse closure `{ palletId, kind: "warehouse", shiftId: null, productId, terminalId, sscc, closedAt, operatorId, printVerifiedAt, printSkippedAt }`; pallet exception `shiftId` nullable; response `memberships[]` one entry per submitted record in submission order with `status ∈ accepted | replayed | already_on_pallet | not_found | not_closed | disassembled | pallet_closed | product_mismatch | subscription_read_only` and optional `winningPalletSscc` (AI-00, 20 digits); registry upsert items on `GET /station/box-registry` carry `palletId, palletSscc (raw 18), palletActive, closedAt, productionDate`.
- Scan classification uses `ScanClassifier.classify` (check-digit validated), never `Sscc.parse`. The pallet screen writes nothing to `scan_events`/`outbox`.
- Warehouse pallet identity on the device: `PalletEntity(kind = "warehouse", shiftId = null, productId, deviceId = terminalId = device_config.deviceId)`. Serial pool: `SsccPool.PALLET_EXTENSION_DIGIT = 1` under the bootstrap's `issuerPrefix` (organisation GLN).
- Completion signal is `SignalKind.BOX_DONE`; refusals `SignalKind.ERROR`; soft duplicates `SignalKind.DUPLICATE`.
- RU and EN strings ship together (`res/values/strings.xml` + `res/values-en/strings.xml`), prefix `pallets_`; `EnglishRenderTest` covers the new screens.
- `AGENTS.md` for the handheld applies: run `./gradlew --no-daemon testDebugUnitTest lintDebug assembleDebug` from `apps/handheld`; emulator/vendor scanner/printer behaviour is reported as not verified.
- SQLite behind Robolectric has no `DROP COLUMN` and cannot change nullability: widening `pallets`/`pallet_exceptions` is a rebuild (create new → copy → drop → rename).
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; commit only paths you changed.

---

## File map

| Path (under `apps/handheld/app/src/main/kotlin/app/markiro/handheld/`)                                                                          | Responsibility                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `core/sync/SyncEngine.kt`                                                                                                                       | `MAX_PALLET_MEMBERSHIPS`, membership channel, outcome application |
| `core/storage/Migrations.kt`, `HandheldDatabase.kt`, `StorageModule.kt`, `MetaStore.kt`                                                         | migration 17→18, new DAOs, meta keys                              |
| `core/storage/PalletEntities.kt`, `PalletDao.kt`                                                                                                | `kind/productId/deviceId`, nullable `shiftId`, `openWarehouse`    |
| `core/storage/PalletMembershipEntities.kt` (new)                                                                                                | `pallet_memberships` entity + DAO                                 |
| `core/storage/BoxRegistryEntities.kt` (new, replaces `WriteoffBoxEntity`)                                                                       | `box_registry` entity + DAO                                       |
| `core/storage/PalletBootstrapEntities.kt` (new)                                                                                                 | `pallet_products`, `pallet_permissions`, `pallet_label_templates` |
| `core/storage/ExceptionEntities.kt`                                                                                                             | `PalletExceptionEntity.shiftId: String?`                          |
| `core/network/PalletDtos.kt` (new), `SyncDtos.kt`, `WriteoffDtos.kt`, `StationApi.kt`                                                           | bootstrap DTO, closure/membership DTOs, registry fields           |
| `core/pallets/BoxRegistryMirror.kt` (new; the registry walk moves out of `WriteoffMirror`)                                                      | registry delta walk                                               |
| `core/pallets/PalletBootstrapMirror.kt` (new), `core/pallets/PalletsModule.kt` (new)                                                            | bootstrap caches + serial block                                   |
| `core/pallets/WarehousePallets.kt` (new)                                                                                                        | open-on-first-scan, attach/remove checks, close                   |
| `core/box/ClosePallet.kt`, `PalletPrinter.kt`, `PalletLabelFields.kt`                                                                           | warehouse close + print sources                                   |
| `core/exceptions/ExceptionFacts.kt`, `ExceptionEngine.kt`                                                                                       | nullable shift, `disassemblePallet`                               |
| `feature/pallets/` (new: `PalletsViewModel.kt`, `PalletsScreens.kt`, `PalletsFeatureModule.kt`)                                                 | the mode                                                          |
| `feature/hub/HubViewModel.kt`, `HubScreen.kt`, `AppNavigation.kt`                                                                               | tile, route                                                       |
| `feature/exceptions/PalletDisassembleViewModel.kt` (new), `PalletDisassembleScreens.kt` (new), `ExceptionsScreens.kt`, `ExceptionsViewModel.kt` | pallet disassemble                                                |
| `res/values/strings.xml`, `res/values-en/strings.xml`                                                                                           | strings                                                           |

---

### Task 1: Membership batch limit literal

**Files:**

- Modify: `core/sync/SyncEngine.kt` (companion, after `MAX_PALLET_CLOSURES`)
- Modify: `app/src/test/kotlin/app/markiro/handheld/core/sync/SyncLimitsFixturesTest.kt`

**Interfaces:**

- Produces: `SyncEngine.MAX_PALLET_MEMBERSHIPS = 100`.

- [ ] **Step 1: Add the failing assertion**

In `SyncLimitsFixturesTest.kotlinLiteralsMatchTheDomainPackage` append:

```kotlin
        assertEquals(
            fixtures.getValue("maxPalletMembershipsPerSyncBatch").jsonPrimitive.int,
            SyncEngine.MAX_PALLET_MEMBERSHIPS,
        )
```

- [ ] **Step 2: Run it to see it fail to compile**

Run (from `apps/handheld`): `./gradlew --no-daemon testDebugUnitTest --tests 'app.markiro.handheld.core.sync.SyncLimitsFixturesTest'`
Expected: compilation error, `MAX_PALLET_MEMBERSHIPS` unresolved.

- [ ] **Step 3: Add the constant**

In `SyncEngine.companion` after `MAX_PALLET_CLOSURES`:

```kotlin
        /**
         * The server's own `MAX_PALLET_MEMBERSHIPS_PER_SYNC_BATCH`
         * (`packages/domain/src/sync/limits.ts`): one closed box scanned onto a
         * warehouse pallet per record. Hand-copied for the reason
         * `MAX_BOX_CLOSURES` above gives; pinned by `SyncLimitsFixturesTest`.
         */
        const val MAX_PALLET_MEMBERSHIPS = 100
```

- [ ] **Step 4: Run the test**

Same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/sync/SyncEngine.kt apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/sync/SyncLimitsFixturesTest.kt
git commit -m "feat(handheld): pin the pallet membership batch limit"
```

---

### Task 2: Room migration 17→18 — storage for warehouse pallets

**Files:**

- Modify: `core/storage/PalletEntities.kt`, `core/storage/PalletDao.kt`, `core/storage/ExceptionEntities.kt`, `core/storage/Migrations.kt`, `core/storage/HandheldDatabase.kt` (`HANDHELD_DATABASE_VERSION = 18`, entity list, DAO accessors), `core/storage/StorageModule.kt` (`MIGRATION_17_18` + DAO providers), `core/storage/MetaStore.kt`
- Create: `core/storage/PalletMembershipEntities.kt`, `core/storage/BoxRegistryEntities.kt`, `core/storage/PalletBootstrapEntities.kt`
- Delete: `WriteoffBoxEntity`/`WriteoffBoxDao` from `WriteoffEntities.kt`/`WriteoffDaos.kt` (replaced by `BoxRegistryEntity`/`BoxRegistryDao`); update `core/writeoff/WriteoffMirror.kt`, `feature/writeoff/WriteoffRepository.kt` and their tests to the new names (`db.boxRegistryDao()`, `BoxRegistryEntity`).
- Test: `app/src/test/kotlin/app/markiro/handheld/core/storage/WarehousePalletMigrationTest.kt` (new), `MigrationTest.kt`, `DeviceRecoveryMigrationTest.kt` (add `MIGRATION_17_18` to both lists), `PalletStorageTest.kt`, `WriteoffMirrorTest.kt`, `WriteoffViewModelTest.kt` (renames only)

**Interfaces:**

- Produces:
  - `PalletEntity(palletId, shiftId: String?, terminalId, sscc, openedAt, closedAt, operatorId, printState, printReason, ackedAt, kind: String = PalletKind.PRODUCTION, productId: String? = null, deviceId: String? = null)`; `object PalletKind { PRODUCTION = "production"; WAREHOUSE = "warehouse" }`.
  - `PalletDao.openWarehouse(deviceId): PalletEntity?`, `observeOpenWarehouse(deviceId): Flow<PalletEntity?>`, `warehouseByDevice(deviceId, limit)`.
  - `PalletExceptionEntity.shiftId: String?`.
  - `PalletMembershipEntity(palletId, sscc, addedAt, operatorId, status, reason, winningPalletSscc, ackedAt, acknowledgedAt)` PK `(palletId, sscc)`; `object MembershipStatus { PENDING; SENT; ACCEPTED; REJECTED }`; `PalletMembershipDao`: `insert`, `byPallet(palletId)`, `observeByPallet(palletId)`, `pending(limit)`, `sentFor(palletId, ssccs)`, `markSent(keys, at)`, `markAccepted(palletId, sscc, at)`, `markRejected(palletId, sscc, reason, winner, at)`, `revertSent()`, `delete(palletId, sscc)`, `observePendingCount()`, `countByPallet(palletId)`, `rejectedByPallet(palletId)`, `acknowledge(palletId, at)`, `bottleSum(palletId)`, `productionDates(palletId)`, `clear()`.
  - `BoxRegistryEntity(sscc, boxId, productId, bottleCount, contentKeysJson, updatedAt, palletId: String?, palletSscc: String?, palletActive: Boolean, closedAt: String?, productionDate: String?, localPalletId: String?)`; `BoxRegistryDao`: `upsert`, `remove`, `bySscc`, `count`, `clear`, `claim(sscc, localPalletId)`, `release(sscc)`, `releaseAll(localPalletId)`.
  - `PalletProductEntity(id, gtin14, name, printName, shelfLifeDays, palletBoxCapacity, chzProductGroupCode)`; `PalletPermissionEntity(employeeId, canBuildPallets)`; `PalletLabelTemplateEntity(key, specJson)` where key is `"org"` or `"category:<code>"`; DAOs with `replaceAll`, `byId`, `get(employeeId)`, `observe(employeeId)`, `get(key)`.
  - `MetaStore.SYNC_PENDING_MEMBERSHIP_COUNT = "sync_pending_membership_count"`, `PALLET_BOOTSTRAP_AT = "pallet_bootstrap_at"`, `PALLET_BOOTSTRAP_ISSUER_PREFIX = "pallet_bootstrap_issuer_prefix"`, `BOX_REGISTRY_UNTIL` = the existing `"writeoff_registry_until"` value (rename the constant, keep the stored key so an installed device keeps its cursor).

- [ ] **Step 1: Write the failing migration test**

`app/src/test/kotlin/app/markiro/handheld/core/storage/WarehousePalletMigrationTest.kt`:

```kotlin
package app.markiro.handheld.core.storage

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith

/**
 * An installed v17 terminal holding a production pallet, a pallet exception and
 * a write-off box mirror upgrades to v18 without losing any of them, and the
 * rebuilt tables accept the warehouse shapes.
 */
@RunWith(AndroidJUnit4::class)
class WarehousePalletMigrationTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()

    private fun database(name: String) = Room.databaseBuilder(context, HandheldDatabase::class.java, name)
        .allowMainThreadQueries()
        .addMigrations(
            MIGRATION_1_2, MIGRATION_2_3, MIGRATION_3_4, MIGRATION_4_5, MIGRATION_5_6, MIGRATION_6_7, MIGRATION_7_8,
            MIGRATION_8_9, MIGRATION_9_10, MIGRATION_10_11, MIGRATION_11_12, MIGRATION_12_13, MIGRATION_13_14,
            MIGRATION_14_15, MIGRATION_15_16, MIGRATION_16_17, MIGRATION_17_18,
        ).build()

    @Test
    fun aVersionSeventeenPalletExceptionAndRegistrySurviveTheRebuild() = runTest {
        val name = "wh-migration.db"
        context.deleteDatabase(name)
        // Build the current schema, then rewind the three rebuilt tables to their v17 DDL.
        database(name).close()
        SQLiteDatabase.openOrCreateDatabase(context.getDatabasePath(name), null).use { raw ->
            raw.execSQL("DROP TABLE IF EXISTS pallet_memberships")
            raw.execSQL("DROP TABLE IF EXISTS pallet_products")
            raw.execSQL("DROP TABLE IF EXISTS pallet_permissions")
            raw.execSQL("DROP TABLE IF EXISTS pallet_label_templates")
            raw.execSQL("DROP TABLE IF EXISTS box_registry")
            raw.execSQL("DROP TABLE IF EXISTS pallets")
            raw.execSQL("DROP TABLE IF EXISTS pallet_exceptions")
            raw.execSQL(
                "CREATE TABLE `pallets` (`palletId` TEXT NOT NULL, `shiftId` TEXT NOT NULL, `terminalId` TEXT, `sscc` TEXT, " +
                    "`openedAt` TEXT NOT NULL, `closedAt` TEXT, `operatorId` TEXT, `printState` TEXT NOT NULL, `printReason` TEXT, " +
                    "`ackedAt` TEXT, PRIMARY KEY(`palletId`))",
            )
            raw.execSQL("CREATE INDEX `index_pallets_shiftId_closedAt` ON `pallets` (`shiftId`, `closedAt`)")
            raw.execSQL(
                "CREATE TABLE `pallet_exceptions` (`id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, `kind` TEXT NOT NULL, " +
                    "`palletId` TEXT NOT NULL, `shiftId` TEXT NOT NULL, `terminalId` TEXT, `operatorId` TEXT, `reason` TEXT NOT NULL, " +
                    "`occurredAt` TEXT NOT NULL, `payloadJson` TEXT NOT NULL, `ackedAt` TEXT)",
            )
            raw.execSQL("CREATE INDEX `index_pallet_exceptions_ackedAt` ON `pallet_exceptions` (`ackedAt`)")
            raw.execSQL(
                "CREATE TABLE `writeoff_boxes` (`sscc` TEXT NOT NULL PRIMARY KEY, `boxId` TEXT NOT NULL, `productId` TEXT NOT NULL, " +
                    "`bottleCount` INTEGER NOT NULL, `contentKeysJson` TEXT NOT NULL, `updatedAt` TEXT NOT NULL)",
            )
            raw.execSQL(
                "INSERT INTO pallets VALUES ('p1','s1','dev-1','134600682000000017','2026-09-10T10:00:00.000Z','2026-09-10T11:00:00.000Z','op-1','printed',NULL,'2026-09-10T11:01:00.000Z')",
            )
            raw.execSQL(
                "INSERT INTO pallet_exceptions (kind,palletId,shiftId,terminalId,operatorId,reason,occurredAt,payloadJson,ackedAt) " +
                    "VALUES ('reprint','p1','s1','dev-1','op-1','Этикетка повреждена','2026-09-10T12:00:00.000Z','{}',NULL)",
            )
            raw.execSQL("INSERT INTO writeoff_boxes VALUES ('034600682000000018','b1','prod-1',12,'[]','t')")
            raw.execSQL("PRAGMA user_version = 17")
        }

        val db = database(name)
        try {
            val pallet = db.palletDao().get("p1")!!
            assertEquals("s1", pallet.shiftId)
            assertEquals(PalletKind.PRODUCTION, pallet.kind)
            assertNull(pallet.productId)
            assertEquals("134600682000000017", pallet.sscc)
            assertEquals(1, db.palletExceptionDao().queued().size)
            val box = db.boxRegistryDao().bySscc("034600682000000018")!!
            assertEquals(12, box.bottleCount)
            assertNull(box.palletId)
            assertEquals(false, box.palletActive)
            assertNull(box.localPalletId)

            db.palletDao().insert(
                PalletEntity(
                    palletId = "w1", shiftId = null, terminalId = "dev-1", sscc = null, openedAt = "t", closedAt = null,
                    operatorId = null, printState = PalletPrint.PENDING, printReason = null, ackedAt = null,
                    kind = PalletKind.WAREHOUSE, productId = "prod-1", deviceId = "dev-1",
                ),
            )
            assertEquals("w1", db.palletDao().openWarehouse("dev-1")?.palletId)
            db.palletMembershipDao().insert(
                PalletMembershipEntity("w1", "034600682000000018", "t", "op-1", MembershipStatus.PENDING, null, null, null, null),
            )
            assertEquals(1, db.palletMembershipDao().pending(10).size)
            assertEquals(12, db.palletMembershipDao().bottleSum("w1"))
        } finally {
            db.close()
        }
    }
}
```

- [ ] **Step 2: Run it to see it fail**

Run: `./gradlew --no-daemon testDebugUnitTest --tests 'app.markiro.handheld.core.storage.WarehousePalletMigrationTest'`
Expected: compilation errors (`MIGRATION_17_18`, `PalletKind`, `boxRegistryDao` unresolved).

- [ ] **Step 3: Entities**

`PalletEntities.kt` — replace the entity:

```kotlin
object PalletKind {
    const val PRODUCTION = "production"
    /** Built from closed boxes of any shift; belongs to this device, not to a shift (spec §3). */
    const val WAREHOUSE = "warehouse"
}

@Entity(tableName = "pallets", indices = [Index(value = ["shiftId", "closedAt"]), Index(value = ["deviceId", "kind", "closedAt"])])
data class PalletEntity(
    @PrimaryKey val palletId: String,
    /** Null for a warehouse pallet. */
    val shiftId: String?,
    val terminalId: String?,
    val sscc: String?,
    val openedAt: String,
    val closedAt: String?,
    val operatorId: String?,
    val printState: String,
    val printReason: String?,
    val ackedAt: String?,
    val kind: String = PalletKind.PRODUCTION,
    /** The one product every member box carries; set only for a warehouse pallet. */
    val productId: String? = null,
    /** This device, for a warehouse pallet; the server keys the pallet on it. */
    val deviceId: String? = null,
    /** Set when this closed pallet was taken apart on the device (Task 9). */
    val disassembledAt: String? = null,
)
```

`PalletDao.kt` — add:

```kotlin
    @Query("SELECT * FROM pallets WHERE kind = 'warehouse' AND deviceId = :deviceId AND closedAt IS NULL LIMIT 1")
    suspend fun openWarehouse(deviceId: String): PalletEntity?

    @Query("SELECT * FROM pallets WHERE kind = 'warehouse' AND deviceId = :deviceId AND closedAt IS NULL LIMIT 1")
    fun observeOpenWarehouse(deviceId: String): Flow<PalletEntity?>

    /** Recent warehouse pallets of this device, newest first, for the mode's list. */
    @Query("SELECT * FROM pallets WHERE kind = 'warehouse' AND deviceId = :deviceId ORDER BY closedAt IS NOT NULL, closedAt DESC, openedAt DESC LIMIT :limit")
    fun observeWarehouse(deviceId: String, limit: Int): Flow<List<PalletEntity>>

    @Query("SELECT * FROM pallets WHERE sscc = :sscc LIMIT 1")
    suspend fun bySscc(sscc: String): PalletEntity?

    /** Guarded so a second retirement is a no-op the caller can name. */
    @Query("UPDATE pallets SET disassembledAt = :at WHERE palletId = :palletId AND closedAt IS NOT NULL AND disassembledAt IS NULL")
    suspend fun markDisassembled(palletId: String, at: String): Int

    @Query("SELECT COUNT(*) FROM pallets WHERE closedAt IS NOT NULL AND disassembledAt IS NULL AND (:shiftId IS NULL OR shiftId = :shiftId)")
    fun observeClosedCount(shiftId: String?): Flow<Int>
```

`ExceptionEntities.kt` — `PalletExceptionEntity.shiftId: String?`.

New `PalletMembershipEntities.kt`:

```kotlin
package app.markiro.handheld.core.storage

import androidx.room.Dao
import androidx.room.Entity
import androidx.room.Index
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import kotlinx.coroutines.flow.Flow

object MembershipStatus {
    const val PENDING = "pending"
    /** Pinned into a batch in flight; a retry resends exactly this row. */
    const val SENT = "sent"
    const val ACCEPTED = "accepted"
    const val REJECTED = "rejected"
}

/**
 * One closed box scanned onto a warehouse pallet (spec §3.1). Pure fact after
 * `sent`; only `status`/`reason`/`winningPalletSscc`/`ackedAt`/`acknowledgedAt`
 * change afterwards. `acknowledgedAt` is the operator's «Принято» on a rejection.
 */
@Entity(tableName = "pallet_memberships", primaryKeys = ["palletId", "sscc"], indices = [Index(value = ["status", "addedAt"])])
data class PalletMembershipEntity(
    val palletId: String,
    val sscc: String,
    val addedAt: String,
    val operatorId: String?,
    val status: String,
    val reason: String?,
    val winningPalletSscc: String?,
    val ackedAt: String?,
    val acknowledgedAt: String?,
)

@Dao
interface PalletMembershipDao {
    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insert(row: PalletMembershipEntity)

    @Query("SELECT * FROM pallet_memberships WHERE palletId = :palletId ORDER BY addedAt, sscc")
    suspend fun byPallet(palletId: String): List<PalletMembershipEntity>

    @Query("SELECT * FROM pallet_memberships WHERE palletId = :palletId ORDER BY addedAt, sscc")
    fun observeByPallet(palletId: String): Flow<List<PalletMembershipEntity>>

    /** Oldest first, so a retry re-reads the same first N rows (the pallet channel's own rule). */
    @Query("SELECT * FROM pallet_memberships WHERE status = 'pending' ORDER BY addedAt, palletId, sscc LIMIT :limit")
    suspend fun pending(limit: Int): List<PalletMembershipEntity>

    /** The rows a batch in flight pinned: exactly the `sent` ones, in the same order. */
    @Query("SELECT * FROM pallet_memberships WHERE status = 'sent' ORDER BY addedAt, palletId, sscc LIMIT :limit")
    suspend fun sent(limit: Int): List<PalletMembershipEntity>

    @Query("UPDATE pallet_memberships SET status = 'sent' WHERE status = 'pending' AND palletId = :palletId AND sscc = :sscc")
    suspend fun markSent(palletId: String, sscc: String)

    /** A batch abandoned by `clearPending` (server never applied it) gives its rows back to the queue. */
    @Query("UPDATE pallet_memberships SET status = 'pending' WHERE status = 'sent'")
    suspend fun revertSent()

    @Query("UPDATE pallet_memberships SET status = 'accepted', ackedAt = :at, reason = NULL, winningPalletSscc = NULL WHERE palletId = :palletId AND sscc = :sscc")
    suspend fun markAccepted(palletId: String, sscc: String, at: String)

    @Query("UPDATE pallet_memberships SET status = 'rejected', reason = :reason, winningPalletSscc = :winner, ackedAt = :at WHERE palletId = :palletId AND sscc = :sscc")
    suspend fun markRejected(palletId: String, sscc: String, reason: String, winner: String?, at: String)

    /** Only a pending row can be taken off the pallet locally; a sent one may already be on the server. */
    @Query("DELETE FROM pallet_memberships WHERE palletId = :palletId AND sscc = :sscc AND status = 'pending'")
    suspend fun deletePending(palletId: String, sscc: String): Int

    @Query("SELECT COUNT(*) FROM pallet_memberships WHERE status IN ('pending', 'sent')")
    fun observePendingCount(): Flow<Int>

    /** Boxes counted as ON the pallet: everything not rejected. */
    @Query("SELECT COUNT(*) FROM pallet_memberships WHERE palletId = :palletId AND status <> 'rejected'")
    suspend fun countOnPallet(palletId: String): Int

    @Query("SELECT COUNT(*) FROM pallet_memberships WHERE palletId = :palletId AND status <> 'rejected'")
    fun observeCountOnPallet(palletId: String): Flow<Int>

    @Query("SELECT * FROM pallet_memberships WHERE palletId = :palletId AND status = 'rejected' AND acknowledgedAt IS NULL ORDER BY addedAt")
    fun observeUnacknowledgedRejections(palletId: String): Flow<List<PalletMembershipEntity>>

    @Query("UPDATE pallet_memberships SET acknowledgedAt = :at WHERE palletId = :palletId AND status = 'rejected' AND acknowledgedAt IS NULL")
    suspend fun acknowledge(palletId: String, at: String)

    /** Units on the pallet, from the registry: a warehouse pallet's boxes hold another device's codes. */
    @Query(
        "SELECT COALESCE(SUM(b.bottleCount), 0) FROM pallet_memberships m JOIN box_registry b ON b.sscc = m.sscc " +
            "WHERE m.palletId = :palletId AND m.status <> 'rejected'",
    )
    suspend fun bottleSum(palletId: String): Int

    /** Distinct civil production dates of the member boxes (null when the registry has none). */
    @Query(
        "SELECT DISTINCT b.productionDate FROM pallet_memberships m JOIN box_registry b ON b.sscc = m.sscc " +
            "WHERE m.palletId = :palletId AND m.status <> 'rejected'",
    )
    suspend fun productionDates(palletId: String): List<String?>

    @Query("DELETE FROM pallet_memberships")
    suspend fun clear()
}
```

New `BoxRegistryEntities.kt` (move `WriteoffBoxEntity` here under its new name; delete the old class and `WriteoffBoxDao`):

```kotlin
package app.markiro.handheld.core.storage

import androidx.room.Dao
import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Upsert

/**
 * Closed boxes from `GET /station/box-registry`, keyed by SSCC. Shared by the
 * write-off mode (contents as `01…21…` keys) and the pallet mode (pallet
 * membership, spec §2.4). `localPalletId` is this device's own claim, set on
 * scan and cleared on removal or once the server's answer lands, so a second
 * scan before the next registry refresh is still caught.
 */
@Entity(tableName = "box_registry", indices = [Index(value = ["localPalletId"])])
data class BoxRegistryEntity(
    @PrimaryKey val sscc: String,
    val boxId: String,
    val productId: String,
    val bottleCount: Int,
    val contentKeysJson: String,
    val updatedAt: String,
    val palletId: String? = null,
    /** Raw 18 digits; null while that pallet is open. */
    val palletSscc: String? = null,
    val palletActive: Boolean = false,
    val closedAt: String? = null,
    /** Civil `YYYY-MM-DD` of the owner shift, or null. */
    val productionDate: String? = null,
    val localPalletId: String? = null,
)

@Dao
interface BoxRegistryDao {
    @Upsert
    suspend fun upsert(row: BoxRegistryEntity)

    @Query("DELETE FROM box_registry WHERE sscc = :sscc")
    suspend fun remove(sscc: String)

    @Query("SELECT * FROM box_registry WHERE sscc = :sscc")
    suspend fun bySscc(sscc: String): BoxRegistryEntity?

    @Query("SELECT COUNT(*) FROM box_registry")
    suspend fun count(): Int

    @Query("UPDATE box_registry SET localPalletId = :localPalletId WHERE sscc = :sscc")
    suspend fun claim(sscc: String, localPalletId: String)

    @Query("UPDATE box_registry SET localPalletId = NULL WHERE sscc = :sscc")
    suspend fun release(sscc: String)

    @Query("DELETE FROM box_registry")
    suspend fun clear()
}
```

The mirror's `upsert` must PRESERVE `localPalletId` of an existing row: in `BoxRegistryMirror` (Task 4) read `bySscc` first and copy `localPalletId` into the new row unless the server now reports `palletId != null` (the claim is settled either way).

New `PalletBootstrapEntities.kt`:

```kotlin
package app.markiro.handheld.core.storage

import androidx.room.Dao
import androidx.room.Entity
import androidx.room.Index
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Transaction
import kotlinx.coroutines.flow.Flow

/** `GET /station/pallet-bootstrap` products; replaced wholesale on each refresh. */
@Entity(tableName = "pallet_products", indices = [Index(value = ["gtin14"])])
data class PalletProductEntity(
    @PrimaryKey val id: String,
    val gtin14: String,
    val name: String,
    val printName: String?,
    val shelfLifeDays: Int?,
    val palletBoxCapacity: Int?,
    val chzProductGroupCode: Int?,
)

@Entity(tableName = "pallet_permissions")
data class PalletPermissionEntity(@PrimaryKey val employeeId: String, val canBuildPallets: Boolean)

/** `key` is `org` or `category:<chzProductGroupCode>`; `specJson` is the label spec as the server sent it. */
@Entity(tableName = "pallet_label_templates")
data class PalletLabelTemplateEntity(@PrimaryKey val key: String, val specJson: String) {
    companion object {
        const val ORG = "org"
        fun category(code: Int) = "category:$code"
    }
}

@Dao
interface PalletProductDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun insertAll(rows: List<PalletProductEntity>)
    @Query("DELETE FROM pallet_products") suspend fun clear()
    @Transaction suspend fun replaceAll(rows: List<PalletProductEntity>) { clear(); insertAll(rows) }
    @Query("SELECT * FROM pallet_products WHERE id = :id") suspend fun byId(id: String): PalletProductEntity?
    @Query("SELECT COUNT(*) FROM pallet_products") suspend fun count(): Int
}

@Dao
interface PalletPermissionDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun insertAll(rows: List<PalletPermissionEntity>)
    @Query("DELETE FROM pallet_permissions") suspend fun clear()
    @Transaction suspend fun replaceAll(rows: List<PalletPermissionEntity>) { clear(); insertAll(rows) }
    @Query("SELECT * FROM pallet_permissions WHERE employeeId = :employeeId") suspend fun get(employeeId: String): PalletPermissionEntity?
    @Query("SELECT * FROM pallet_permissions WHERE employeeId = :employeeId") fun observe(employeeId: String): Flow<PalletPermissionEntity?>
}

@Dao
interface PalletLabelTemplateDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun insertAll(rows: List<PalletLabelTemplateEntity>)
    @Query("DELETE FROM pallet_label_templates") suspend fun clear()
    @Transaction suspend fun replaceAll(rows: List<PalletLabelTemplateEntity>) { clear(); insertAll(rows) }
    @Query("SELECT * FROM pallet_label_templates WHERE `key` = :key") suspend fun get(key: String): PalletLabelTemplateEntity?
}
```

- [ ] **Step 4: Migration**

Append to `Migrations.kt`:

```kotlin
/**
 * Warehouse pallets (spec §3.1). SQLite cannot widen a NOT NULL column, so
 * `pallets` and `pallet_exceptions` are rebuilt; `writeoff_boxes` becomes the
 * shared `box_registry` with the station feed's pallet fields; three bootstrap
 * caches and the membership table are new. Every DDL string matches the
 * entities exactly -- Room validates at open.
 */
val MIGRATION_17_18 = object : Migration(17, 18) {
    override fun migrate(db: SupportSQLiteDatabase) {
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS `pallets_new` (`palletId` TEXT NOT NULL, `shiftId` TEXT, `terminalId` TEXT, `sscc` TEXT, " +
                "`openedAt` TEXT NOT NULL, `closedAt` TEXT, `operatorId` TEXT, `printState` TEXT NOT NULL, `printReason` TEXT, " +
                "`ackedAt` TEXT, `kind` TEXT NOT NULL DEFAULT 'production', `productId` TEXT, `deviceId` TEXT, `disassembledAt` TEXT, PRIMARY KEY(`palletId`))",
        )
        db.execSQL(
            "INSERT INTO `pallets_new` (palletId, shiftId, terminalId, sscc, openedAt, closedAt, operatorId, printState, printReason, ackedAt) " +
                "SELECT palletId, shiftId, terminalId, sscc, openedAt, closedAt, operatorId, printState, printReason, ackedAt FROM `pallets`",
        )
        db.execSQL("DROP TABLE `pallets`")
        db.execSQL("ALTER TABLE `pallets_new` RENAME TO `pallets`")
        db.execSQL("CREATE INDEX IF NOT EXISTS `index_pallets_shiftId_closedAt` ON `pallets` (`shiftId`, `closedAt`)")
        db.execSQL("CREATE INDEX IF NOT EXISTS `index_pallets_deviceId_kind_closedAt` ON `pallets` (`deviceId`, `kind`, `closedAt`)")

        db.execSQL(
            "CREATE TABLE IF NOT EXISTS `pallet_exceptions_new` (`id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, `kind` TEXT NOT NULL, " +
                "`palletId` TEXT NOT NULL, `shiftId` TEXT, `terminalId` TEXT, `operatorId` TEXT, `reason` TEXT NOT NULL, " +
                "`occurredAt` TEXT NOT NULL, `payloadJson` TEXT NOT NULL, `ackedAt` TEXT)",
        )
        db.execSQL(
            "INSERT INTO `pallet_exceptions_new` (id, kind, palletId, shiftId, terminalId, operatorId, reason, occurredAt, payloadJson, ackedAt) " +
                "SELECT id, kind, palletId, shiftId, terminalId, operatorId, reason, occurredAt, payloadJson, ackedAt FROM `pallet_exceptions`",
        )
        db.execSQL("DROP TABLE `pallet_exceptions`")
        db.execSQL("ALTER TABLE `pallet_exceptions_new` RENAME TO `pallet_exceptions`")
        db.execSQL("CREATE INDEX IF NOT EXISTS `index_pallet_exceptions_ackedAt` ON `pallet_exceptions` (`ackedAt`)")

        db.execSQL("ALTER TABLE `writeoff_boxes` RENAME TO `box_registry`")
        for (column in listOf("palletId TEXT", "palletSscc TEXT", "palletActive INTEGER NOT NULL DEFAULT 0", "closedAt TEXT", "productionDate TEXT", "localPalletId TEXT")) {
            db.execSQL("ALTER TABLE `box_registry` ADD COLUMN $column")
        }
        db.execSQL("CREATE INDEX IF NOT EXISTS `index_box_registry_localPalletId` ON `box_registry` (`localPalletId`)")

        db.execSQL(
            "CREATE TABLE IF NOT EXISTS `pallet_memberships` (`palletId` TEXT NOT NULL, `sscc` TEXT NOT NULL, `addedAt` TEXT NOT NULL, " +
                "`operatorId` TEXT, `status` TEXT NOT NULL, `reason` TEXT, `winningPalletSscc` TEXT, `ackedAt` TEXT, `acknowledgedAt` TEXT, " +
                "PRIMARY KEY(`palletId`, `sscc`))",
        )
        db.execSQL("CREATE INDEX IF NOT EXISTS `index_pallet_memberships_status_addedAt` ON `pallet_memberships` (`status`, `addedAt`)")
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS `pallet_products` (`id` TEXT NOT NULL, `gtin14` TEXT NOT NULL, `name` TEXT NOT NULL, `printName` TEXT, " +
                "`shelfLifeDays` INTEGER, `palletBoxCapacity` INTEGER, `chzProductGroupCode` INTEGER, PRIMARY KEY(`id`))",
        )
        db.execSQL("CREATE INDEX IF NOT EXISTS `index_pallet_products_gtin14` ON `pallet_products` (`gtin14`)")
        db.execSQL("CREATE TABLE IF NOT EXISTS `pallet_permissions` (`employeeId` TEXT NOT NULL, `canBuildPallets` INTEGER NOT NULL, PRIMARY KEY(`employeeId`))")
        db.execSQL("CREATE TABLE IF NOT EXISTS `pallet_label_templates` (`key` TEXT NOT NULL, `specJson` TEXT NOT NULL, PRIMARY KEY(`key`))")
    }
}
```

Room's index name for `Index(value = ["deviceId","kind","closedAt"])` is `index_pallets_deviceId_kind_closedAt`; Room validates index names, so keep them exact. If `ALTER TABLE … RENAME` on an upgrade suite finds no `writeoff_boxes` (a rewound fixture), guard it: query `sqlite_master` for `writeoff_boxes` and `CREATE TABLE IF NOT EXISTS box_registry (...)` with the full column list when absent.

`HandheldDatabase.kt`: version 18; replace `WriteoffBoxEntity::class` with `BoxRegistryEntity::class`, add `PalletMembershipEntity::class, PalletProductEntity::class, PalletPermissionEntity::class, PalletLabelTemplateEntity::class`; replace `writeoffBoxDao()` with `boxRegistryDao(): BoxRegistryDao`; add `palletMembershipDao()`, `palletProductDao()`, `palletPermissionDao()`, `palletLabelTemplateDao()`. `StorageModule.kt`: add `MIGRATION_17_18` and `@Provides` for the four new DAOs plus `boxRegistryDao`. `MetaStore.kt`: rename `WRITEOFF_REGISTRY_UNTIL` → `BOX_REGISTRY_UNTIL` (same string value), add `SYNC_PENDING_MEMBERSHIP_COUNT`, `PALLET_BOOTSTRAP_AT`, `PALLET_BOOTSTRAP_ISSUER_PREFIX`. Add `MIGRATION_17_18` to `MigrationTest.kt` and `DeviceRecoveryMigrationTest.database()`.

Rename usages: `WriteoffMirror.change()` builds `BoxRegistryEntity` (the five new fields come in Task 4 — for now pass defaults), `contentKeys()` extension moves onto `BoxRegistryEntity`; `WriteoffRepository.box()` returns `BoxRegistryEntity`; `WriteoffLine.Box` construction unchanged; tests renamed accordingly.

- [ ] **Step 5: Run the storage suites**

Run: `./gradlew --no-daemon testDebugUnitTest --tests 'app.markiro.handheld.core.storage.*' --tests 'app.markiro.handheld.core.writeoff.*' --tests 'app.markiro.handheld.feature.writeoff.*' --tests 'app.markiro.handheld.core.sync.*' --tests 'app.markiro.handheld.core.box.*'`
Expected: PASS (the sync/box suites compile against the widened entity because every new field has a default).

- [ ] **Step 6: Commit**

```bash
git add apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/storage apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/writeoff apps/handheld/app/src/main/kotlin/app/markiro/handheld/feature/writeoff apps/handheld/app/src/test/kotlin/app/markiro/handheld
git commit -m "feat(handheld): storage for warehouse pallets (room 18)"
```

---

### Task 3: Wire DTOs

**Files:**

- Create: `core/network/PalletDtos.kt`
- Modify: `core/network/SyncDtos.kt` (`PalletClosureDto`, `SyncBatchRequest`), `core/network/WriteoffDtos.kt` (`BoxRegistryItemDto`), `core/network/StationApi.kt`, `core/exceptions/ExceptionFacts.kt` (`PalletExceptionFact.shiftId: String?`)
- Test: `app/src/test/kotlin/app/markiro/handheld/core/network/PalletDtosTest.kt` (new), `core/exceptions/ExceptionFactsTest.kt` (existing wire test, extend)

**Interfaces:**

- Produces:

```kotlin
@Serializable data class PalletBootstrapProductDto(val id: String, val gtin14: String, val name: String, val printName: String? = null, val shelfLifeDays: Int? = null, val palletBoxCapacity: Int? = null, val chzProductGroupCode: Int? = null)
@Serializable data class PalletBootstrapOperatorDto(val employeeId: String, val canBuildPallets: Boolean)
@Serializable data class PalletCategoryTemplateDto(val chzProductGroupCode: Int, val template: JsonElement)
@Serializable data class PalletLabelTemplatesDto(val organisation: JsonElement? = null, val byCategory: List<PalletCategoryTemplateDto> = emptyList())
@Serializable data class PalletBootstrapDto(val generatedAt: String, val products: List<PalletBootstrapProductDto>, val operators: List<PalletBootstrapOperatorDto>, val palletSscc: BundleSsccDto? = null, val palletSsccRevokedFrom: List<Long> = emptyList(), val palletLabelTemplates: PalletLabelTemplatesDto)
@Serializable data class PalletMembershipDto(val palletId: String, val boxSscc: String, val addedAt: String, val operatorId: String?)
```

`PalletClosureDto(palletId, shiftId: String?, terminalId, sscc, closedAt, operatorId, printVerifiedAt = null, printSkippedAt = null, kind: String = "production", productId: String? = null)`; `SyncBatchRequest.palletMemberships: List<PalletMembershipDto> = emptyList()`; `BoxRegistryItemDto` + `palletId: String? = null, palletSscc: String? = null, palletActive: Boolean? = null, closedAt: String? = null, productionDate: String? = null`; `StationApi.palletBootstrap(): PalletBootstrapDto` at `@GET("station/pallet-bootstrap")`.

- [ ] **Step 1: Write the failing DTO test**

```kotlin
package app.markiro.handheld.core.network

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PalletDtosTest {
    private val strict = NetworkModule.strictJson()

    @Test
    fun aWarehouseClosureSpellsOutItsNullShiftAndItsKind() {
        val body = strict.encodeToString(
            SyncBatchRequest.serializer(),
            SyncBatchRequest(
                "b", emptyList(),
                pallets = listOf(PalletClosureDto("w1", null, "dev-1", "134600682000000017", "t", "op-1", kind = "warehouse", productId = "prod-1")),
                palletMemberships = listOf(PalletMembershipDto("w1", "034600682000000018", "t", null)),
            ),
        )
        val obj = strict.parseToJsonElement(body).jsonObject
        val pallet = obj.getValue("pallets").jsonArrayFirst()
        assertEquals("warehouse", pallet.getValue("kind").jsonPrimitive.content)
        assertEquals("null", pallet.getValue("shiftId").toString())
        assertEquals("prod-1", pallet.getValue("productId").jsonPrimitive.content)
        val membership = obj.getValue("palletMemberships").jsonArrayFirst()
        assertEquals("034600682000000018", membership.getValue("boxSscc").jsonPrimitive.content)
        assertEquals("null", membership.getValue("operatorId").toString())
    }

    @Test
    fun aProductionClosureStillCarriesItsShiftAndDefaultsItsKind() {
        val body = strict.encodeToString(PalletClosureDto.serializer(), PalletClosureDto("p1", "s1", "dev-1", "134600682000000017", "t", null))
        val obj = strict.parseToJsonElement(body).jsonObject
        assertEquals("production", obj.getValue("kind").jsonPrimitive.content)
        assertEquals("s1", obj.getValue("shiftId").jsonPrimitive.content)
    }

    @Test
    fun theBootstrapAndRegistryDtosReadTheServerShapes() {
        val bootstrap = NetworkModule.json().decodeFromString(
            PalletBootstrapDto.serializer(),
            """{"generatedAt":"t","products":[{"id":"p-1","gtin14":"04600682000013","name":"Cola","printName":null,"shelfLifeDays":180,"palletBoxCapacity":12,"chzProductGroupCode":8}],
               "operators":[{"employeeId":"op-1","canBuildPallets":true}],
               "palletSscc":{"issuerPrefix":"046006820","extensionDigit":1,"fromSerial":0,"toSerial":199,"consumedThroughSerial":null},
               "palletSsccRevokedFrom":[],"palletLabelTemplates":{"organisation":{"widthMm":100},"byCategory":[{"chzProductGroupCode":8,"template":{"widthMm":150}}]}}""",
        )
        assertEquals(12, bootstrap.products.single().palletBoxCapacity)
        assertEquals(1, bootstrap.palletSscc?.extensionDigit)
        assertEquals(8, bootstrap.palletLabelTemplates.byCategory.single().chzProductGroupCode)
        val item = NetworkModule.json().decodeFromString(
            BoxRegistryItemDto.serializer(),
            """{"kind":"upsert","boxId":"b","sscc":"034600682000000018","productId":"p-1","bottleCount":6,"contentKeys":[],"updatedAt":"t",
               "palletId":"pl","palletSscc":"134600682000000017","palletActive":true,"closedAt":"c","productionDate":"2026-09-10"}""",
        )
        assertEquals(true, item.palletActive)
        assertEquals("2026-09-10", item.productionDate)
        val legacy = NetworkModule.json().decodeFromString(BoxRegistryItemDto.serializer(), """{"kind":"remove","sscc":"034600682000000018","updatedAt":"t"}""")
        assertNull(legacy.palletActive)
    }

    private fun kotlinx.serialization.json.JsonElement.jsonArrayFirst() = kotlinx.serialization.json.JsonArray::class.java.cast(this).first().jsonObject
}
```

(Replace the helper with `(this as JsonArray).first().jsonObject` if the cast form does not compile.)

- [ ] **Step 2: Run to see it fail** — `./gradlew --no-daemon testDebugUnitTest --tests 'app.markiro.handheld.core.network.PalletDtosTest'`; expected: compilation errors.

- [ ] **Step 3: Implement the DTOs** exactly as the Interfaces block lists; in `StationApi` add

```kotlin
    /** Products, per-operator pallet permission, this device's extension-1 block and pallet label templates, no shift needed. */
    @GET("station/pallet-bootstrap")
    suspend fun palletBootstrap(): PalletBootstrapDto
```

In `ExceptionFacts.kt` make `PalletExceptionFact.shiftId: String?` (the `toWireJson` `put("shiftId", shiftId)` already writes a JSON null for a null), and update `ExceptionEngine.reprintPallet(shiftId: String?, …)` and `queuePalletOwned` accordingly. Extend the existing wire test for pallet facts with a null-shift case asserting `"shiftId":null` is present.

- [ ] **Step 4: Run** the new test plus `--tests 'app.markiro.handheld.core.exceptions.*' --tests 'app.markiro.handheld.core.network.*'`; expected PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(handheld): warehouse pallet wire shapes"` with the touched paths.

---

### Task 4: Registry and bootstrap mirrors

**Files:**

- Create: `core/pallets/BoxRegistryMirror.kt` (the registry walk moved out of `WriteoffMirror`), `core/pallets/PalletBootstrapMirror.kt`, `core/pallets/PalletsModule.kt`
- Modify: `core/writeoff/WriteoffMirror.kt` (bootstrap half only; delegates the walk to `BoxRegistryMirror`), `core/writeoff/WriteoffModule.kt`, `feature/shift/ShiftRepository.kt` (extract `applyBlock` into a reusable `SsccBlockApplier`)
- Test: `app/src/test/kotlin/app/markiro/handheld/core/pallets/BoxRegistryMirrorTest.kt`, `PalletBootstrapMirrorTest.kt`, `core/writeoff/WriteoffMirrorTest.kt` (registry cases move)

**Interfaces:**

- Produces:

```kotlin
class BoxRegistryMirror(api: StationApi, db: HandheldDatabase, meta: MetaStore) {
    suspend fun walk(): MirrorOutcome            // delta since MetaStore.BOX_REGISTRY_UNTIL; clears on null
}
class SsccBlockApplier(pool: SsccPool) {
    suspend fun apply(block: BundleSsccDto?, revokedFrom: List<Long>)   // exactly ShiftRepository.applyBlock's body
}
class PalletBootstrapMirror(api: StationApi, db: HandheldDatabase, meta: MetaStore, blocks: SsccBlockApplier, registry: BoxRegistryMirror, clock: () -> Long) {
    val stampAt: Flow<Long?>                     // PALLET_BOOTSTRAP_AT
    suspend fun refresh(): MirrorOutcome         // bootstrap caches + serial block + registry walk
    suspend fun issuerPrefix(): String?          // PALLET_BOOTSTRAP_ISSUER_PREFIX
}
```

`MirrorOutcome` stays in `core/writeoff/WriteoffMirror.kt` (shared).

- [ ] **Step 1: Tests first**

`PalletBootstrapMirrorTest` (copy the `WriteoffMirrorTest` harness: in-memory DB, `initializeRecoveryForTest`, MockWebServer, Retrofit with `NetworkModule.json()`):

```kotlin
    private val bootstrapJson = """{"generatedAt":"2026-09-18T08:00:00.000Z",
        "products":[{"id":"p-1","gtin14":"04600682000013","name":"Cola","printName":"Cola 0.5","shelfLifeDays":180,"palletBoxCapacity":12,"chzProductGroupCode":8}],
        "operators":[{"employeeId":"op-1","canBuildPallets":true},{"employeeId":"op-2","canBuildPallets":false}],
        "palletSscc":{"issuerPrefix":"046006820","extensionDigit":1,"fromSerial":0,"toSerial":199,"consumedThroughSerial":null},
        "palletSsccRevokedFrom":[],
        "palletLabelTemplates":{"organisation":{"widthMm":100,"heightMm":150},"byCategory":[{"chzProductGroupCode":8,"template":{"widthMm":100,"heightMm":100}}]}}"""

    @Test
    fun aRefreshFillsCachesSeedsTheExtensionOnePoolAndWalksTheRegistry() = runTest {
        server.enqueue(MockResponse().setBody(bootstrapJson))
        server.enqueue(MockResponse().setBody("""{"until":"9","items":[
            {"kind":"upsert","boxId":"b1","sscc":"034600682000000018","productId":"p-1","bottleCount":6,"contentKeys":[],"updatedAt":"t",
             "palletId":null,"palletSscc":null,"palletActive":false,"closedAt":"c","productionDate":"2026-09-10"}]}"""))
        assertEquals(MirrorOutcome.Ok, mirror.refresh())
        assertEquals(12, db.palletProductDao().byId("p-1")?.palletBoxCapacity)
        assertTrue(db.palletPermissionDao().get("op-1")!!.canBuildPallets)
        assertNotNull(db.palletLabelTemplateDao().get(PalletLabelTemplateEntity.ORG))
        assertNotNull(db.palletLabelTemplateDao().get(PalletLabelTemplateEntity.category(8)))
        assertEquals("046006820", mirror.issuerPrefix())
        assertEquals(200L, SsccPool(db).remaining("046006820", SsccPool.PALLET_EXTENSION_DIGIT))
        assertEquals("2026-09-10", db.boxRegistryDao().bySscc("034600682000000018")?.productionDate)
        assertEquals("9", meta.get(MetaStore.BOX_REGISTRY_UNTIL))
        assertEquals(STAMP, meta.get(MetaStore.PALLET_BOOTSTRAP_AT)?.toLong())
    }

    @Test
    fun aNullBlockLeavesThePoolAloneAndStillFillsTheCaches() = runTest {
        server.enqueue(MockResponse().setBody(bootstrapJson.replace(""""palletSscc":{"issuerPrefix":"046006820","extensionDigit":1,"fromSerial":0,"toSerial":199,"consumedThroughSerial":null}""", """"palletSscc":null""")))
        server.enqueue(MockResponse().setBody("""{"until":"1","items":[]}"""))
        assertEquals(MirrorOutcome.Ok, mirror.refresh())
        assertEquals(0L, SsccPool(db).remaining("046006820", SsccPool.PALLET_EXTENSION_DIGIT))
        assertNull(mirror.issuerPrefix())
        assertEquals(1, db.palletProductDao().count())
    }

    @Test
    fun offlineKeepsEverything() = runTest {
        server.shutdown()
        assertEquals(MirrorOutcome.Offline, mirror.refresh())
    }
```

`BoxRegistryMirrorTest`: move `WriteoffMirrorTest`'s registry-walk cases here (delta since stored `until`, clear on null cursor, `remove` item, mid-walk `until` mismatch → `Failed("registry window")`) and add:

```kotlin
    @Test
    fun anUpsertKeepsTheDeviceClaimUntilTheServerSettlesIt() = runTest {
        db.boxRegistryDao().upsert(BoxRegistryEntity("034600682000000018", "b1", "p-1", 6, "[]", "t", localPalletId = "w-local"))
        server.enqueue(MockResponse().setBody("""{"until":"3","items":[
            {"kind":"upsert","boxId":"b1","sscc":"034600682000000018","productId":"p-1","bottleCount":6,"contentKeys":[],"updatedAt":"t2","palletId":null,"palletSscc":null,"palletActive":false,"closedAt":"c","productionDate":null}]}"""))
        assertEquals(MirrorOutcome.Ok, mirror.walk())
        assertEquals("w-local", db.boxRegistryDao().bySscc("034600682000000018")?.localPalletId)
        server.enqueue(MockResponse().setBody("""{"until":"4","items":[
            {"kind":"upsert","boxId":"b1","sscc":"034600682000000018","productId":"p-1","bottleCount":6,"contentKeys":[],"updatedAt":"t3","palletId":"srv","palletSscc":"134600682000000017","palletActive":true,"closedAt":"c","productionDate":null}]}"""))
        assertEquals(MirrorOutcome.Ok, mirror.walk())
        val row = db.boxRegistryDao().bySscc("034600682000000018")!!
        assertNull(row.localPalletId)
        assertEquals(true, row.palletActive)
    }
```

- [ ] **Step 2: Run to see them fail** — the two new test classes; expected: compilation errors.

- [ ] **Step 3: Implement**

`core/pallets/BoxRegistryMirror.kt` — the `walkRegistry`/`change` bodies of `WriteoffMirror` verbatim, renamed `walk()`, with the item mapping:

```kotlin
    private suspend fun row(item: BoxRegistryItemDto): BoxRegistryEntity? {
        val boxId = item.boxId ?: return null
        val productId = item.productId ?: return null
        val bottleCount = item.bottleCount ?: return null
        val contentKeys = item.contentKeys ?: return null
        val existing = db.boxRegistryDao().bySscc(item.sscc)
        // The device's own claim survives a refresh until the server has an answer
        // of its own (any palletId), at which point the claim is settled either way.
        val localPalletId = if (item.palletId != null) null else existing?.localPalletId
        return BoxRegistryEntity(
            sscc = item.sscc, boxId = boxId, productId = productId, bottleCount = bottleCount,
            contentKeysJson = Json.encodeToString(KEYS, contentKeys), updatedAt = item.updatedAt,
            palletId = item.palletId, palletSscc = item.palletSscc, palletActive = item.palletActive ?: false,
            closedAt = item.closedAt, productionDate = item.productionDate, localPalletId = localPalletId,
        )
    }
```

`WriteoffMirror.refreshOwned()` keeps its three `replaceAll`s and the stamp, then `return registry.walk()` (constructor gains `registry: BoxRegistryMirror`). `SsccBlockApplier` in `core/pallets/SsccBlockApplier.kt` holds `ShiftRepository.applyBlock`'s body; `ShiftRepository` calls it.

`core/pallets/PalletBootstrapMirror.kt`:

```kotlin
class PalletBootstrapMirror(
    private val api: StationApi,
    private val db: HandheldDatabase,
    private val meta: MetaStore,
    private val blocks: SsccBlockApplier,
    private val registry: BoxRegistryMirror,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    val stampAt: Flow<Long?> = db.metaDao().observe(MetaStore.PALLET_BOOTSTRAP_AT).map { it?.toLongOrNull() }

    suspend fun issuerPrefix(): String? = meta.get(MetaStore.PALLET_BOOTSTRAP_ISSUER_PREFIX)

    suspend fun refresh(): MirrorOutcome = try {
        db.recovery.work { refreshOwned() }
    } catch (_: IOException) {
        MirrorOutcome.Offline
    } catch (_: retrofit2.HttpException) {
        MirrorOutcome.Failed("http")
    } catch (_: SerializationException) {
        MirrorOutcome.Failed("shape")
    }

    private suspend fun refreshOwned(): MirrorOutcome {
        val bootstrap = api.palletBootstrap()
        db.recovery.commit {
            db.palletProductDao().replaceAll(bootstrap.products.map {
                PalletProductEntity(it.id, it.gtin14, it.name, it.printName, it.shelfLifeDays, it.palletBoxCapacity, it.chzProductGroupCode)
            })
            db.palletPermissionDao().replaceAll(bootstrap.operators.map { PalletPermissionEntity(it.employeeId, it.canBuildPallets) })
            db.palletLabelTemplateDao().replaceAll(
                listOfNotNull(bootstrap.palletLabelTemplates.organisation?.let { PalletLabelTemplateEntity(PalletLabelTemplateEntity.ORG, it.toString()) }) +
                    bootstrap.palletLabelTemplates.byCategory.map { PalletLabelTemplateEntity(PalletLabelTemplateEntity.category(it.chzProductGroupCode), it.template.toString()) },
            )
            // A null block means "no numbers today" (no GLN, read-only, exhausted): the pool keeps what it has
            // and the prefix is forgotten so a close reports NoIssuer rather than burning from a stale one.
            if (bootstrap.palletSscc != null) meta.put(MetaStore.PALLET_BOOTSTRAP_ISSUER_PREFIX, bootstrap.palletSscc.issuerPrefix)
            else meta.remove(MetaStore.PALLET_BOOTSTRAP_ISSUER_PREFIX)
            meta.put(MetaStore.PALLET_BOOTSTRAP_AT, clock().toString())
        }
        blocks.apply(bootstrap.palletSscc, bootstrap.palletSsccRevokedFrom)
        return registry.walk()
    }
}
```

`core/pallets/PalletsModule.kt` (Hilt, singleton) provides `BoxRegistryMirror`, `SsccBlockApplier`, `PalletBootstrapMirror`; `WriteoffModule.writeoffMirror` gains the `BoxRegistryMirror` parameter.

- [ ] **Step 4: Run** `--tests 'app.markiro.handheld.core.pallets.*' --tests 'app.markiro.handheld.core.writeoff.*' --tests 'app.markiro.handheld.feature.shift.*'`; expected PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(handheld): pallet bootstrap and shared box registry mirrors"`.

---

### Task 5: Sync — membership channel and warehouse closures

**Files:**

- Modify: `core/sync/SyncEngine.kt`
- Test: `app/src/test/kotlin/app/markiro/handheld/core/sync/SyncPalletMembershipsTest.kt` (new; copy the `SyncPalletsTest` harness)

**Interfaces:**

- Consumes: `PalletMembershipDao`, `PalletMembershipDto`, `PalletClosureDto.kind/productId`, `MetaStore.SYNC_PENDING_MEMBERSHIP_COUNT`.
- Produces: memberships ride `palletMemberships[]`; `pending` counts them; outcomes applied per record.

- [ ] **Step 1: Tests first**

```kotlin
    private suspend fun warehousePallet(palletId: String, closed: Boolean) = db.palletDao().insert(
        PalletEntity(
            palletId = palletId, shiftId = null, terminalId = "dev-1", sscc = if (closed) "134600682000000017" else null,
            openedAt = "2026-09-18T08:00:00.000Z", closedAt = if (closed) "2026-09-18T09:00:00.000Z" else null, operatorId = "op-1",
            printState = "pending", printReason = null, ackedAt = null, kind = PalletKind.WAREHOUSE, productId = "p-1", deviceId = "dev-1",
        ),
    )
    private suspend fun membership(palletId: String, sscc: String) = db.palletMembershipDao().insert(
        PalletMembershipEntity(palletId, sscc, "2026-09-18T08:10:00.000Z", "op-1", MembershipStatus.PENDING, null, null, null, null),
    )
    private fun outcome(vararg entries: String) =
        MockResponse().setResponseCode(201).setBody("""{"applied":0,"alreadyApplied":false,"conflicts":[],"memberships":[${entries.joinToString(",")}]}""")

    @Test
    fun membershipsRideTheBatchInSubmissionOrderAndTakeTheirOutcomes() = runTest {
        warehousePallet("w1", closed = false)
        membership("w1", "034600682000000018"); membership("w1", "034600682000000025")
        server.enqueue(outcome(
            """{"palletId":"w1","boxSscc":"034600682000000018","status":"accepted"}""",
            """{"palletId":"w1","boxSscc":"034600682000000025","status":"already_on_pallet","winningPalletSscc":"00134600682000000099"}""",
        ))
        assertTrue(engine().drainAll())
        val body = bodyOf(server.takeRequest())
        assertEquals(listOf("034600682000000018", "034600682000000025"), body.getValue("palletMemberships").jsonArray.map { it.jsonObject.getValue("boxSscc").jsonPrimitive.content })
        val rows = db.palletMembershipDao().byPallet("w1")
        assertEquals(MembershipStatus.ACCEPTED, rows[0].status)
        assertEquals(MembershipStatus.REJECTED, rows[1].status)
        assertEquals("already_on_pallet", rows[1].reason)
        assertEquals("00134600682000000099", rows[1].winningPalletSscc)
        assertNull(meta().get(MetaStore.SYNC_PENDING_MEMBERSHIP_COUNT))
    }

    @Test
    fun aMembershipScannedWhileABatchIsInFlightWaitsForTheNextOne() = runTest {
        warehousePallet("w1", closed = false)
        membership("w1", "034600682000000018")
        server.enqueue(MockResponse().setResponseCode(500))
        assertFalse(engine().drainAll())
        val first = bodyOf(server.takeRequest())
        membership("w1", "034600682000000025")
        server.enqueue(outcome("""{"palletId":"w1","boxSscc":"034600682000000018","status":"accepted"}"""))
        server.enqueue(outcome("""{"palletId":"w1","boxSscc":"034600682000000025","status":"accepted"}"""))
        assertTrue(engine().drainAll())
        val retry = bodyOf(server.takeRequest())
        assertEquals(first.getValue("batchId"), retry.getValue("batchId"))
        assertEquals(1, retry.getValue("palletMemberships").jsonArray.size)
        assertEquals(1, bodyOf(server.takeRequest()).getValue("palletMemberships").jsonArray.size)
    }

    @Test
    fun aWarehouseClosureCarriesKindProductAndNoShift() = runTest {
        warehousePallet("w1", closed = true)
        server.enqueue(ok(0))
        assertTrue(engine().drainAll())
        val pallet = bodyOf(server.takeRequest()).getValue("pallets").jsonArray.single().jsonObject
        assertEquals("warehouse", pallet.getValue("kind").jsonPrimitive.content)
        assertEquals("p-1", pallet.getValue("productId").jsonPrimitive.content)
        assertEquals("null", pallet.getValue("shiftId").toString())
        assertNotNull(db.palletDao().get("w1")?.ackedAt)
    }

    @Test
    fun aMissingOrMalformedMembershipsAnswerDoesNotAckTheRows() = runTest {
        warehousePallet("w1", closed = false)
        membership("w1", "034600682000000018")
        server.enqueue(MockResponse().setResponseCode(201).setBody("""{"applied":0,"alreadyApplied":false,"conflicts":[]}"""))
        assertFalse(engine().drainAll())
        assertEquals(MembershipStatus.SENT, db.palletMembershipDao().byPallet("w1").single().status)
    }
```

`meta()` = `MetaStore(db)`; `ok()`/`bodyOf()` as in `SyncPalletsTest`.

- [ ] **Step 2: Run to see them fail** — `--tests 'app.markiro.handheld.core.sync.SyncPalletMembershipsTest'`.

- [ ] **Step 3: Implement in `drainOnceOwned`**

After the pallet rows block:

```kotlin
        // Memberships (warehouse pallets) pin like every other channel. Rows a
        // batch already chose are `sent`; a fresh batch takes `pending` rows and
        // marks them `sent` under the same commit that writes the pin.
        val membershipLimit = if (pendingCeiling != null) {
            meta.get(MetaStore.SYNC_PENDING_MEMBERSHIP_COUNT)?.toIntOrNull() ?: 0
        } else {
            MAX_PALLET_MEMBERSHIPS
        }
        val membershipRows = when {
            membershipLimit == 0 -> emptyList()
            pendingCeiling != null -> db.palletMembershipDao().sent(membershipLimit)
            else -> db.palletMembershipDao().pending(membershipLimit)
        }
```

Extend the empty check with `membershipRows.isEmpty()`; fold `idSignature(membershipRows.map { "${it.palletId}|${it.sscc}" })` into the batch id (sixth signature); in the pin commit add `meta.put(MetaStore.SYNC_PENDING_MEMBERSHIP_COUNT, membershipRows.size.toString())` and `for (m in membershipRows) db.palletMembershipDao().markSent(m.palletId, m.sscc)`; in `SyncBatchRequest` pass `palletMemberships = membershipRows.map { PalletMembershipDto(it.palletId, it.sscc, it.addedAt, it.operatorId) }`. `PalletEntity.toClosure` adds `kind = kind, productId = productId` (`shiftId` is already nullable now). In `clearPendingOwned` add `meta.remove(SYNC_PENDING_MEMBERSHIP_COUNT)` and `db.palletMembershipDao().revertSent()`. Add `db.palletMembershipDao().observePendingCount()` to the `pending` combine.

Parse: `BatchResponse` gains `memberships: List<MembershipOutcome>?` where

```kotlin
    private class MembershipOutcome(val palletId: String, val boxSscc: String, val status: String, val winningPalletSscc: String?)
```

and `parseBatchResponse` reads `obj["memberships"]` as a `JsonArray` of objects with string `palletId`/`boxSscc`/`status` (any missing/non-string field → return null, i.e. the whole answer is not this endpoint). After the `applied`/`alreadyApplied` check add: `if (membershipRows.isNotEmpty() && (parsed.memberships == null || parsed.memberships.size != membershipRows.size)) return Step.FAILED` — the server answers one entry per submitted record; anything else is not an ack. In the commit block:

```kotlin
            parsed.memberships?.forEachIndexed { i, o ->
                val row = membershipRows[i]
                when (o.status) {
                    "accepted", "replayed" -> {
                        db.palletMembershipDao().markAccepted(row.palletId, row.sscc, Iso.format(at))
                    }
                    else -> {
                        db.palletMembershipDao().markRejected(row.palletId, row.sscc, o.status, o.winningPalletSscc, Iso.format(at))
                        db.boxRegistryDao().release(row.sscc)
                    }
                }
            }
```

and `db.metaDao().remove(MetaStore.SYNC_PENDING_MEMBERSHIP_COUNT)` beside the other pins. A `subscription_read_only` status is a rejection like any other here: the server quarantined the record, and the box stays claimable once the subscription is back.

- [ ] **Step 4: Run** `--tests 'app.markiro.handheld.core.sync.*'`; expected PASS incl. `SyncBatchIdBoundTest`.

- [ ] **Step 5: Commit** — `git commit -m "feat(handheld): sync pallet memberships and warehouse closures"`.

---

### Task 6: Warehouse pallet core — attach, remove, close, label fields

**Files:**

- Create: `core/pallets/WarehousePallets.kt`
- Modify: `core/box/ClosePallet.kt` (`closeWarehouse`), `core/box/PalletLabelFields.kt` (`omitDates`)
- Test: `app/src/test/kotlin/app/markiro/handheld/core/pallets/WarehousePalletsTest.kt`, `core/box/ClosePalletTest.kt` (warehouse cases), `core/box/PalletLabelFieldsTest.kt` (omitDates)

**Interfaces:**

- Produces:

```kotlin
sealed interface AttachResult {
    data class Attached(val pallet: PalletEntity, val boxCount: Int, val capacity: Int?, val atCapacity: Boolean) : AttachResult
    data object AlreadyOnThisPallet : AttachResult          // soft, idempotent
    data class OnAnotherPallet(val palletSscc: String?) : AttachResult   // raw 18 digits or null while open
    data object OnAnotherLocalPallet : AttachResult
    data class OtherProduct(val productName: String) : AttachResult
    data object UnknownBox : AttachResult
    data object UnknownProduct : AttachResult
    data object ThatIsAPallet : AttachResult
}
class WarehousePallets(db, lock: PalletLock, closer: ClosePallet, clock) {
    suspend fun deviceId(): String?
    fun observeOpen(): Flow<PalletEntity?>
    suspend fun attach(sscc: String, operatorId: String?): AttachResult
    suspend fun remove(palletId: String, sscc: String): Boolean
    suspend fun close(operatorId: String?): ClosePalletResult   // early / at capacity
    suspend fun capacity(pallet: PalletEntity): Int?
    suspend fun acknowledgeRejections(palletId: String)
}
```

`ClosePallet.closeWarehouse(held, pallet: PalletEntity, issuerPrefix: String?, operatorId: String?): ClosePalletResult` — same burn+close transaction, box count from `palletMembershipDao().countOnPallet`, no grant completion (warehouse work is outside shift tasks; the server also keeps it out of grant evidence). `palletLabelFields(input, zone, omitDates: Boolean = false)` renders `DATE`/`EXPIRY` as `""` when `omitDates`.

- [ ] **Step 1: Tests first** (`WarehousePalletsTest`, in-memory DB with `initializeRecoveryForTest`, device id from `syntheticDeviceConfig`):

```kotlin
    private suspend fun registry(sscc: String, productId: String = "p-1", palletActive: Boolean = false, palletSscc: String? = null, localPalletId: String? = null) =
        db.boxRegistryDao().upsert(BoxRegistryEntity(sscc, "b-$sscc", productId, 6, "[]", "t", palletId = if (palletActive) "srv" else null, palletSscc = palletSscc, palletActive = palletActive, closedAt = "c", productionDate = "2026-09-10", localPalletId = localPalletId))
    private suspend fun product(id: String = "p-1", capacity: Int? = 2) = db.palletProductDao().replaceAll(listOf(PalletProductEntity(id, "0460068200001$id", "Cola $id", null, 180, capacity, 8)))

    @Test fun theFirstAcceptedScanOpensThePalletWithTheBoxProduct() = runTest {
        product(); registry("034600682000000018")
        val r = pallets.attach("034600682000000018", "op-1") as AttachResult.Attached
        assertEquals(PalletKind.WAREHOUSE, r.pallet.kind); assertEquals("p-1", r.pallet.productId)
        assertEquals(db.deviceConfigDao().get()!!.deviceId, r.pallet.deviceId); assertEquals(r.pallet.deviceId, r.pallet.terminalId)
        assertEquals(1, r.boxCount); assertEquals(2, r.capacity); assertFalse(r.atCapacity)
        assertEquals(r.pallet.palletId, db.boxRegistryDao().bySscc("034600682000000018")?.localPalletId)
        assertEquals(MembershipStatus.PENDING, db.palletMembershipDao().byPallet(r.pallet.palletId).single().status)
    }
    @Test fun refusalsInSpecOrder() = runTest {
        product(); product("p-2", 5)
        assertEquals(AttachResult.UnknownBox, pallets.attach("034600682000000999", null))
        registry("034600682000000025", localPalletId = "other-local")
        assertEquals(AttachResult.OnAnotherLocalPallet, pallets.attach("034600682000000025", null))
        registry("034600682000000032", palletActive = true, palletSscc = "134600682000000017")
        assertEquals(AttachResult.OnAnotherPallet("134600682000000017"), pallets.attach("034600682000000032", null))
        registry("034600682000000018"); pallets.attach("034600682000000018", null)
        assertEquals(AttachResult.AlreadyOnThisPallet, pallets.attach("034600682000000018", null))
        registry("034600682000000049", productId = "p-2")
        assertEquals(AttachResult.OtherProduct("Cola p-2"), pallets.attach("034600682000000049", null))
        assertEquals(AttachResult.ThatIsAPallet, pallets.attach("134600682000000017", null))
    }
    @Test fun aRegistryBoxOnADisassembledPalletIsFree() = runTest {
        product(); db.boxRegistryDao().upsert(BoxRegistryEntity("034600682000000018", "b", "p-1", 6, "[]", "t", palletId = "old", palletSscc = "134600682000000017", palletActive = false))
        assertTrue(pallets.attach("034600682000000018", null) is AttachResult.Attached)
    }
    @Test fun capacityClosesThePalletAndBurnsAnExtensionOneSerial() = runTest {
        product(); SsccPool(db).addRange(ServerRange("046006820", 1, 0, 199, null)); MetaStore(db).put(MetaStore.PALLET_BOOTSTRAP_ISSUER_PREFIX, "046006820")
        registry("034600682000000018"); registry("034600682000000025")
        pallets.attach("034600682000000018", "op-1")
        val second = pallets.attach("034600682000000025", "op-1") as AttachResult.Attached
        assertTrue(second.atCapacity)
        val closed = pallets.close("op-1") as ClosePalletResult.Closed
        assertEquals(2, closed.boxCount); assertTrue(closed.sscc.startsWith("1046006820"))
        assertNull(db.palletDao().openWarehouse(second.pallet.deviceId!!))
        assertEquals(199L, SsccPool(db).remaining("046006820", 1))
    }
    @Test fun noIssuerOrNoSerialsLeavesThePalletOpen() = runTest {
        product(); registry("034600682000000018"); pallets.attach("034600682000000018", null)
        assertEquals(ClosePalletResult.NoIssuer, pallets.close(null))
        MetaStore(db).put(MetaStore.PALLET_BOOTSTRAP_ISSUER_PREFIX, "046006820")
        assertEquals(ClosePalletResult.NoSerials, pallets.close(null))
        assertNotNull(db.palletDao().openWarehouse(db.deviceConfigDao().get()!!.deviceId))
    }
    @Test fun removeOnlyTakesAPendingRowAndReleasesTheClaim() = runTest {
        product(); registry("034600682000000018")
        val r = pallets.attach("034600682000000018", null) as AttachResult.Attached
        assertTrue(pallets.remove(r.pallet.palletId, "034600682000000018"))
        assertNull(db.boxRegistryDao().bySscc("034600682000000018")?.localPalletId)
        registry("034600682000000025"); pallets.attach("034600682000000025", null)
        db.palletMembershipDao().markSent(r.pallet.palletId, "034600682000000025")
        assertFalse(pallets.remove(r.pallet.palletId, "034600682000000025"))
    }
```

`PalletLabelFieldsTest`: `palletLabelFields(input, omitDates = true)` yields `""` for `DATE` and `EXPIRY` and leaves every other field as before; the existing fixture test keeps passing with the default.

- [ ] **Step 2: Run to see them fail** — `--tests 'app.markiro.handheld.core.pallets.WarehousePalletsTest' --tests 'app.markiro.handheld.core.box.PalletLabelFieldsTest'`.

- [ ] **Step 3: Implement `WarehousePallets`**

```kotlin
class WarehousePallets(
    private val db: HandheldDatabase,
    private val lock: PalletLock,
    private val closer: ClosePallet,
    private val meta: MetaStore,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    suspend fun deviceId(): String? = db.deviceConfigDao().get()?.deviceId

    fun observeOpen(): Flow<PalletEntity?> = db.deviceConfigDao().observe().flatMapLatest { cfg ->
        cfg?.deviceId?.let { db.palletDao().observeOpenWarehouse(it) } ?: flowOf(null)
    }

    suspend fun capacity(pallet: PalletEntity): Int? =
        pallet.productId?.let { db.palletProductDao().byId(it)?.palletBoxCapacity }

    /** The six checks of spec §3.2, in order; lease → lock → transaction, as `CloseBox` does. */
    suspend fun attach(sscc: String, operatorId: String?): AttachResult = db.recovery.exclusive {
        lock.withLock { attachOwned(sscc, operatorId) }
    }

    private suspend fun attachOwned(sscc: String, operatorId: String?): AttachResult {
        val deviceId = deviceId() ?: return AttachResult.UnknownBox
        if (sscc.first() == '1' || db.palletDao().get(sscc) != null) return AttachResult.ThatIsAPallet
        val box = db.boxRegistryDao().bySscc(sscc) ?: return AttachResult.UnknownBox
        val open = db.palletDao().openWarehouse(deviceId)
        if (box.localPalletId != null && box.localPalletId != open?.palletId) return AttachResult.OnAnotherLocalPallet
        if (box.palletActive) return AttachResult.OnAnotherPallet(box.palletSscc)
        if (open != null && db.palletMembershipDao().byPallet(open.palletId).any { it.sscc == sscc && it.status != MembershipStatus.REJECTED }) {
            return AttachResult.AlreadyOnThisPallet
        }
        val product = db.palletProductDao().byId(box.productId) ?: return AttachResult.UnknownProduct
        if (open != null && open.productId != box.productId) {
            return AttachResult.OtherProduct(product.name)
        }
        return db.recovery.commit {
            val pallet = open ?: PalletEntity(
                palletId = UUID.randomUUID().toString(), shiftId = null, terminalId = deviceId, sscc = null,
                openedAt = Iso.format(clock()), closedAt = null, operatorId = operatorId, printState = PalletPrint.PENDING,
                printReason = null, ackedAt = null, kind = PalletKind.WAREHOUSE, productId = box.productId, deviceId = deviceId,
            ).also { db.palletDao().insert(it) }
            db.palletMembershipDao().insert(PalletMembershipEntity(pallet.palletId, sscc, Iso.format(clock()), operatorId, MembershipStatus.PENDING, null, null, null, null))
            db.boxRegistryDao().claim(sscc, pallet.palletId)
            val count = db.palletMembershipDao().countOnPallet(pallet.palletId)
            val capacity = product.palletBoxCapacity
            AttachResult.Attached(pallet, count, capacity, capacity != null && count >= capacity)
        }
    }

    suspend fun remove(palletId: String, sscc: String): Boolean = db.recovery.commit {
        val removed = db.palletMembershipDao().deletePending(palletId, sscc) > 0
        if (removed) db.boxRegistryDao().release(sscc)
        removed
    }

    suspend fun close(operatorId: String?): ClosePalletResult = db.recovery.exclusive {
        lock.withLock { held ->
            val deviceId = deviceId() ?: return@withLock ClosePalletResult.Empty
            val open = db.palletDao().openWarehouse(deviceId) ?: return@withLock ClosePalletResult.Empty
            closer.closeWarehouse(held, open, meta.get(MetaStore.PALLET_BOOTSTRAP_ISSUER_PREFIX), operatorId)
        }
    }

    suspend fun acknowledgeRejections(palletId: String) = db.recovery.commit { db.palletMembershipDao().acknowledge(palletId, Iso.format(clock())) }
}
```

`ThatIsAPallet`: the registry never lists a pallet, so an extension-digit-1 SSCC or one matching a local pallet's `sscc` (add `PalletDao.bySscc(sscc)`; use it instead of `get(sscc)`) is a pallet label.

`ClosePallet.closeWarehouse` mirrors `close(held, …)` with: `lock.requireHeld(held)`, `requireNoTransaction`, `NoIssuer` on null prefix, `Empty` when `countOnPallet == 0`, the same one-commit burn + `palletDao().close`, no `grants.complete`, and `Closed(pallet.copy(...), sscc, boxCount, closedAt)`.

- [ ] **Step 4: Run** the two suites plus `--tests 'app.markiro.handheld.core.box.*'`; expected PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(handheld): warehouse pallet attach, remove and close"`.

---

### Task 7: Printing a warehouse pallet label

**Files:**

- Modify: `core/box/PalletPrinter.kt`, `core/print/PrintReason.kt` (add `TEMPLATE_MISSING` is present; add `PRODUCT_MISSING = "product_missing"` if absent)
- Test: `app/src/test/kotlin/app/markiro/handheld/core/box/PalletPrinterTest.kt` (warehouse cases)

**Interfaces:**

- Consumes: `PalletEntity.kind/productId`, `PalletProductDao`, `PalletLabelTemplateDao`, `PalletMembershipDao.countOnPallet/bottleSum/productionDates`, `palletLabelFields(..., omitDates)`.
- Produces: `PalletPrinter.print` renders a warehouse pallet from the bootstrap caches; refusal reasons `TEMPLATE_MISSING` (no org/category template) and `PRODUCT_MISSING`.

- [ ] **Step 1: Tests first** — in `PalletPrinterTest` (copy its existing printer/transport fakes) add:

```kotlin
    private suspend fun warehouseFixture(templateKey: String = PalletLabelTemplateEntity.ORG, dates: List<String?> = listOf("2026-09-10", "2026-09-10")) {
        db.palletProductDao().replaceAll(listOf(PalletProductEntity("p-1", "04600682000013", "Cola", "Cola 0.5", 180, 12, 8)))
        db.palletLabelTemplateDao().replaceAll(listOf(PalletLabelTemplateEntity(templateKey, PALLET_TEMPLATE_JSON)))
        db.palletDao().insert(PalletEntity("w1", null, "dev-1", "134600682000000017", "t", "2026-09-18T09:00:00.000Z", "op-1", PalletPrint.PENDING, null, null, PalletKind.WAREHOUSE, "p-1", "dev-1"))
        dates.forEachIndexed { i, date ->
            val sscc = "03460068200000%03d".format(i)
            db.boxRegistryDao().upsert(BoxRegistryEntity(sscc, "b$i", "p-1", 6, "[]", "t", productionDate = date))
            db.palletMembershipDao().insert(PalletMembershipEntity("w1", sscc, "t", null, MembershipStatus.ACCEPTED, null, null, "t", null))
        }
    }

    @Test fun aWarehousePalletRendersFromTheBootstrapCaches() = runTest {
        warehouseFixture()
        assertEquals(PrintOutcome.Printed, printer.print("w1"))
        val fields = renderer.lastFields!!
        assertEquals("Cola", fields[LabelField.PRODUCT_NAME]); assertEquals("2", fields[LabelField.QTY_BOXES]); assertEquals("12", fields[LabelField.QTY])
        assertEquals(formatLabelDate("2026-09-10"), fields[LabelField.DATE]); assertEquals("", fields[LabelField.SHIFT_NO])
    }
    @Test fun mixedProductionDatesLeaveTheDatesBlank() = runTest {
        warehouseFixture(dates = listOf("2026-09-10", "2026-09-11"))
        assertEquals(PrintOutcome.Printed, printer.print("w1"))
        assertEquals("", renderer.lastFields!![LabelField.DATE]); assertEquals("", renderer.lastFields!![LabelField.EXPIRY])
    }
    @Test fun theCategoryTemplateWinsOverTheOrganisationOne() = runTest {
        warehouseFixture(templateKey = PalletLabelTemplateEntity.category(8))
        assertEquals(PrintOutcome.Printed, printer.print("w1"))
    }
    @Test fun noTemplateRefusesWithTemplateMissing() = runTest {
        warehouseFixture(); db.palletLabelTemplateDao().clear()
        assertEquals(PrintOutcome.Failed(PrintReason.TEMPLATE_MISSING), printer.print("w1"))
        assertEquals(PalletPrint.FAILED, db.palletDao().get("w1")?.printState)
    }
```

(`renderer.lastFields` — extend the test's fake renderer to capture the field map if it does not already.)

- [ ] **Step 2: Run to see them fail** — `--tests 'app.markiro.handheld.core.box.PalletPrinterTest'`.

- [ ] **Step 3: Implement** — in `printOwned`, replace the shift lookup block with a source selector:

```kotlin
        val source = if (pallet.kind == PalletKind.WAREHOUSE) warehouseSource(pallet) else shiftSource(pallet)
        val templateJson = when (source) { is Source.Ready -> source.templateJson; is Source.Refused -> return fail(palletId, source.reason) }
```

where

```kotlin
    private sealed interface Source {
        data class Ready(val templateJson: String, val input: (boxCount: Int, itemCount: Int) -> PalletLabelInput, val omitDates: Boolean) : Source
        data class Refused(val reason: String) : Source
    }

    private suspend fun warehouseSource(pallet: PalletEntity): Source {
        val product = pallet.productId?.let { db.palletProductDao().byId(it) } ?: return Source.Refused(PrintReason.PRODUCT_MISSING)
        val template = product.chzProductGroupCode?.let { db.palletLabelTemplateDao().get(PalletLabelTemplateEntity.category(it)) }
            ?: db.palletLabelTemplateDao().get(PalletLabelTemplateEntity.ORG)
            ?: return Source.Refused(PrintReason.TEMPLATE_MISSING)
        val dates = db.palletMembershipDao().productionDates(pallet.palletId)
        val uniform = dates.singleOrNull()?.takeIf { it != null }
        return Source.Ready(template.specJson, { boxCount, itemCount ->
            PalletLabelInput(
                sscc = checkNotNull(pallet.sscc), boxCount = boxCount, itemCount = itemCount, productName = product.name,
                productPrintName = product.printName, gtin14 = product.gtin14, egaisCode = null, shelfLifeDays = product.shelfLifeDays,
                operatorName = null, counterpartyName = null, closedAt = checkNotNull(pallet.closedAt), productionDate = uniform, shiftNumber = null,
            )
        }, omitDates = uniform == null)
    }
```

`shiftSource` wraps the existing shift lookups (`SHIFT_MISSING`/`TEMPLATE_MISSING`, `omitDates = false`). Counts: warehouse → `palletMembershipDao().countOnPallet` / `bottleSum`; production → `pallets.boxCount` / `itemCount`. Then `palletLabelFields(source.input(boxCount, itemCount), omitDates = source.omitDates)`. Keep everything after (status check, PRINTING state, render, send) unchanged.

- [ ] **Step 4: Run** `--tests 'app.markiro.handheld.core.box.*' --tests 'app.markiro.handheld.feature.work.LabelQueueViewModelTest'`; expected PASS (the label queue lists warehouse pallets through the same `observeUnprinted`).

- [ ] **Step 5: Commit** — `git commit -m "feat(handheld): print warehouse pallet labels from the bootstrap caches"`.

---

### Task 8: The «Паллеты» mode — view model, screens, hub tile, route, strings

**Files:**

- Create: `feature/pallets/PalletsViewModel.kt`, `feature/pallets/PalletsScreens.kt`, `feature/pallets/PalletsFeatureModule.kt`
- Modify: `feature/hub/HubViewModel.kt` (`HubTile.PALLETS`, `canBuildPallets`, `palletsPending`), `feature/hub/HubScreen.kt` (tile), `AppNavigation.kt` (`Routes.PALLETS = "pallets"`, composable), `res/values/strings.xml`, `res/values-en/strings.xml`
- Test: `app/src/test/kotlin/app/markiro/handheld/feature/pallets/PalletsViewModelTest.kt`, `PalletsScreensTest.kt`, `feature/hub/HubViewModelTest.kt`, `HubScreenTest.kt`, `EnglishRenderTest.kt`

**Interfaces:**

- Produces:

```kotlin
interface PalletsGateway {
    suspend fun canBuildPallets(operatorId: String): Boolean?
    suspend fun bootstrapReady(): Boolean
    val stampAt: Flow<Long?>
    suspend fun refresh(): MirrorOutcome
    fun observeOpen(): Flow<PalletEntity?>
    fun observeMembers(palletId: String): Flow<List<PalletMembershipEntity>>
    fun observeRejections(palletId: String): Flow<List<PalletMembershipEntity>>
    suspend fun capacity(pallet: PalletEntity): Int?
    suspend fun productName(productId: String): String?
    suspend fun attach(sscc: String, operatorId: String?): AttachResult
    suspend fun remove(palletId: String, sscc: String): Boolean
    suspend fun close(operatorId: String?): ClosePalletResult
    suspend fun acknowledge(palletId: String)
    suspend fun print(palletId: String, replacementPrinterId: String?, allowUnknown: Boolean): PrintOutcome
    suspend fun resolveUnknownAsPrinted(palletId: String)
    suspend fun defer(palletId: String)
    suspend fun reprintPallet(palletId: String, reason: ReprintReason, operatorId: String?, deviceId: String?)
    suspend fun deviceId(): String?
    fun nudgeSync()
}
enum class PalletsBlocked { NO_PERMISSION, NEVER_SYNCED }
sealed interface PalletVerdict {
    data class Attached(val tail: String) : PalletVerdict
    data class AlreadyHere(val tail: String) : PalletVerdict
    data class OnPallet(val palletTail: String?) : PalletVerdict
    data object OnLocalPallet : PalletVerdict
    data class OtherProduct(val name: String) : PalletVerdict
    data object UnknownBox : PalletVerdict
    data object UnknownProduct : PalletVerdict
    data object IsPallet : PalletVerdict
    data object UnitCode : PalletVerdict
    data object NotACode : PalletVerdict
}
data class PalletsUi(
    val blocked: PalletsBlocked? = null, val stampAt: Long? = null, val operatorName: String = "",
    val pallet: PalletEntity? = null, val productName: String = "", val boxCount: Int = 0, val capacity: Int? = null,
    val members: List<PalletMembershipEntity> = emptyList(), val rejections: List<PalletMembershipEntity> = emptyList(),
    val lastVerdict: PalletVerdict? = null, val confirmEarlyClose: Boolean = false,
    val closeStep: PalletCloseStep = PalletCloseStep.Idle,
)
```

`PalletsViewModel(gateway, session, scans, recovery, signals: SignalPort)` with `@Inject` secondary constructor; functions `remove(sscc)`, `requestEarlyClose()`, `cancelEarlyClose()`, `confirmEarlyClose()`, `acknowledge()`, `retryPrint(replacementPrinterId?)`, `confirmPrinted()`, `deferLabel()`, `dismissClose()`, `refresh()`.

- [ ] **Step 1: View-model tests first** (`PalletsViewModelTest`, fake gateway + `ScanRouterAdapter(MutableSharedFlow)`, `MainDispatcherRule`, signals captured in a list):

```kotlin
    @Test fun anOperatorWithoutPermissionIsBlockedBeforeTheFirstScan() = runTest { gateway.permission = false; val vm = vm(); advanceUntilIdle(); assertEquals(PalletsBlocked.NO_PERMISSION, vm.state.value.blocked); scans.emit(ScanEvent("034600682000000018", null, "wedge", 0)); advanceUntilIdle(); assertEquals(0, gateway.attachCalls) }
    @Test fun aUnitCodeIsRefusedSoftlyAndNeverRecorded() = runTest { val vm = vm(); advanceUntilIdle(); scans.emit(ScanEvent("0104600682000013215S", null, "wedge", 0)); advanceUntilIdle(); assertEquals(PalletVerdict.UnitCode, vm.state.value.lastVerdict); assertEquals(listOf(SignalKind.ERROR), signals); assertEquals(0, gateway.attachCalls) }
    @Test fun anAcceptedScanUpdatesTheStripAndPlaysOk() = runTest { gateway.next = AttachResult.Attached(openPallet, 1, 12, false); val vm = vm(); advanceUntilIdle(); scans.emit(ScanEvent("034600682000000018", null, "wedge", 0)); advanceUntilIdle(); assertEquals(PalletVerdict.Attached("000018"), vm.state.value.lastVerdict); assertEquals(listOf(SignalKind.OK), signals) }
    @Test fun capacityClosesAndPrintsThroughTheCloseStep() = runTest { gateway.next = AttachResult.Attached(openPallet, 12, 12, true); gateway.closeResult = ClosePalletResult.Closed(openPallet.copy(sscc = "134600682000000017", closedAt = "t"), "134600682000000017", 12, "t"); gateway.printOutcome = PrintOutcome.Printed; val vm = vm(); advanceUntilIdle(); scans.emit(ScanEvent("034600682000000018", null, "wedge", 0)); advanceUntilIdle(); assertTrue(vm.state.value.closeStep is PalletCloseStep.Printed); assertTrue(SignalKind.BOX_DONE in signals); assertEquals(1, gateway.nudges) }
    @Test fun refusalsMapToVerdictsAndErrorSignals() = runTest { gateway.next = AttachResult.OnAnotherPallet("134600682000000017"); val vm = vm(); advanceUntilIdle(); scans.emit(ScanEvent("034600682000000018", null, "wedge", 0)); advanceUntilIdle(); assertEquals(PalletVerdict.OnPallet("000017"), vm.state.value.lastVerdict); assertEquals(listOf(SignalKind.ERROR), signals) }
    @Test fun aRejectionFromTheServerShowsUntilAcknowledged() = runTest { gateway.rejections.value = listOf(PalletMembershipEntity("w1", "034600682000000018", "t", null, MembershipStatus.REJECTED, "already_on_pallet", "00134600682000000099", "t", null)); val vm = vm(); advanceUntilIdle(); assertEquals(1, vm.state.value.rejections.size); vm.acknowledge(); advanceUntilIdle(); assertEquals("w1", gateway.acknowledged) }
    @Test fun earlyCloseAsksFirst() = runTest { gateway.open.value = openPallet; val vm = vm(); advanceUntilIdle(); vm.requestEarlyClose(); assertTrue(vm.state.value.confirmEarlyClose); vm.confirmEarlyClose(); advanceUntilIdle(); assertEquals(1, gateway.closeCalls) }
    @Test fun aRefusedCloseIsShownNotSwallowed() = runTest { gateway.open.value = openPallet; gateway.closeResult = ClosePalletResult.NoSerials; val vm = vm(); advanceUntilIdle(); vm.requestEarlyClose(); vm.confirmEarlyClose(); advanceUntilIdle(); assertEquals(PalletCloseStep.Refused(ClosePalletResult.NoSerials), vm.state.value.closeStep) }
```

- [ ] **Step 2: Run to see them fail** — `--tests 'app.markiro.handheld.feature.pallets.*'`.

- [ ] **Step 3: View model**

```kotlin
@HiltViewModel
class PalletsViewModel(
    private val gateway: PalletsGateway,
    private val session: SessionHolder,
    scans: ScanEvents,
    private val recovery: DeviceRecovery,
    private val signals: SignalPort,
) : ViewModel() {
    @Inject constructor(gateway: PalletsGateway, session: SessionHolder, scans: ScanEvents, recovery: DeviceRecovery, signaller: Signaller) :
        this(gateway, session, scans, recovery, { signaller.play(it) })

    private val _state = MutableStateFlow(PalletsUi())
    val state: StateFlow<PalletsUi> = _state.asStateFlow()
    private val operatorId: String? get() = session.state.value.operator?.operatorId
    private val closing = AtomicBoolean(false)
    private val retrying = AtomicBoolean(false)

    init {
        _state.update { it.copy(operatorName = session.state.value.operator?.name.orEmpty()) }
        viewModelScope.launch {
            val id = operatorId
            val permitted = if (id == null) null else runCatching { recovery.work { gateway.canBuildPallets(id) } }.getOrNull()
            val ready = runCatching { recovery.work { gateway.bootstrapReady() } }.getOrDefault(false)
            _state.update { it.copy(blocked = when { permitted == false -> PalletsBlocked.NO_PERMISSION; !ready -> PalletsBlocked.NEVER_SYNCED; else -> null }) }
            scans.events.collect { event -> if (_state.value.blocked == null && _state.value.closeStep is PalletCloseStep.Idle) onScan(event.raw) }
        }
        viewModelScope.launch { gateway.stampAt.collectLatest { at -> _state.update { it.copy(stampAt = at) } } }
        viewModelScope.launch {
            gateway.observeOpen().collectLatest { pallet ->
                if (pallet == null) { _state.update { it.copy(pallet = null, productName = "", boxCount = 0, capacity = null, members = emptyList(), rejections = emptyList()) }; return@collectLatest }
                val name = runCatching { recovery.work { pallet.productId?.let { gateway.productName(it) } } }.getOrNull().orEmpty()
                val capacity = runCatching { recovery.work { gateway.capacity(pallet) } }.getOrNull()
                _state.update { it.copy(pallet = pallet, productName = name, capacity = capacity) }
                combine(gateway.observeMembers(pallet.palletId), gateway.observeRejections(pallet.palletId)) { m, r -> m to r }
                    .collect { (members, rejections) ->
                        _state.update { it.copy(members = members.filter { m -> m.status != MembershipStatus.REJECTED }, boxCount = members.count { m -> m.status != MembershipStatus.REJECTED }, rejections = rejections) }
                    }
            }
        }
        viewModelScope.launch { runCatching { gateway.refresh() } }
    }

    private suspend fun onScan(raw: String) {
        when (val input = ScanClassifier.classify(raw)) {
            is ScanInput.Sscc -> attach(input.sscc)
            is ScanInput.Km -> verdict(PalletVerdict.UnitCode, SignalKind.ERROR)
            is ScanInput.Gtin, is ScanInput.Unknown -> verdict(PalletVerdict.NotACode, SignalKind.ERROR)
        }
    }

    private suspend fun attach(sscc: String) {
        val tail = sscc.takeLast(TAIL)
        val result = runCatching { recovery.work { gateway.attach(sscc, operatorId) } }.getOrElse { return verdict(PalletVerdict.UnknownBox, SignalKind.ERROR) }
        when (result) {
            is AttachResult.Attached -> { verdict(PalletVerdict.Attached(tail), SignalKind.OK); if (result.atCapacity) closeNow() }
            AttachResult.AlreadyOnThisPallet -> verdict(PalletVerdict.AlreadyHere(tail), SignalKind.DUPLICATE)
            is AttachResult.OnAnotherPallet -> verdict(PalletVerdict.OnPallet(result.palletSscc?.takeLast(TAIL)), SignalKind.ERROR)
            AttachResult.OnAnotherLocalPallet -> verdict(PalletVerdict.OnLocalPallet, SignalKind.ERROR)
            is AttachResult.OtherProduct -> verdict(PalletVerdict.OtherProduct(result.productName), SignalKind.ERROR)
            AttachResult.UnknownBox -> verdict(PalletVerdict.UnknownBox, SignalKind.ERROR)
            AttachResult.UnknownProduct -> verdict(PalletVerdict.UnknownProduct, SignalKind.ERROR)
            AttachResult.ThatIsAPallet -> verdict(PalletVerdict.IsPallet, SignalKind.ERROR)
        }
    }

    private fun verdict(v: PalletVerdict, signal: SignalKind) { _state.update { it.copy(lastVerdict = v) }; signals.play(signal) }

    fun remove(sscc: String) { val pallet = _state.value.pallet ?: return; viewModelScope.launch { runCatching { recovery.work { gateway.remove(pallet.palletId, sscc) } } } }
    fun requestEarlyClose() { if (_state.value.pallet != null) _state.update { it.copy(confirmEarlyClose = true) } }
    fun cancelEarlyClose() { _state.update { it.copy(confirmEarlyClose = false) } }
    fun confirmEarlyClose() { _state.update { it.copy(confirmEarlyClose = false) }; viewModelScope.launch { closeNow() } }

    private suspend fun closeNow() {
        if (!closing.compareAndSet(false, true)) return
        try {
            when (val result = runCatching { recovery.work { gateway.close(operatorId) } }.getOrElse { ClosePalletResult.Empty }) {
                is ClosePalletResult.Closed -> {
                    signals.play(SignalKind.BOX_DONE)
                    val closed = ClosedPalletUi(result.pallet.palletId, result.sscc, result.boxCount)
                    _state.update { it.copy(closeStep = PalletCloseStep.Printing(closed)) }
                    _state.update { it.copy(closeStep = attemptPrint(closed)) }
                    gateway.nudgeSync()
                }
                else -> _state.update { it.copy(closeStep = PalletCloseStep.Refused(result)) }
            }
        } finally { closing.set(false) }
    }

    private suspend fun attemptPrint(closed: ClosedPalletUi, replacementPrinterId: String? = null, explicitRetry: Boolean = false): PalletCloseStep =
        when (val printed = recovery.work { gateway.print(closed.palletId, replacementPrinterId, allowUnknown = explicitRetry) }) {
            PrintOutcome.Printed -> PalletCloseStep.Printed(closed)
            is PrintOutcome.Failed -> PalletCloseStep.Failed(closed, printed.reason)
            is PrintOutcome.Unknown -> PalletCloseStep.Unknown(closed, printed.cause)
        }

    fun retryPrint(replacementPrinterId: String? = null) {
        val closed = _state.value.closeStep.closedPallet() ?: return
        if (!retrying.compareAndSet(false, true)) return
        viewModelScope.launch {
            try {
                if (_state.value.closeStep is PalletCloseStep.Unknown) recovery.work { gateway.reprintPallet(closed.palletId, ReprintReason.PRINT_OUTCOME_UNKNOWN, operatorId, gateway.deviceId()) }
                _state.update { it.copy(closeStep = PalletCloseStep.Printing(closed)) }
                _state.update { it.copy(closeStep = attemptPrint(closed, replacementPrinterId, explicitRetry = true)) }
            } finally { retrying.set(false) }
        }
    }
    fun confirmPrinted() { val closed = _state.value.closeStep.closedPallet(); _state.update { it.copy(closeStep = PalletCloseStep.Idle) }; if (closed != null) viewModelScope.launch { recovery.work { gateway.resolveUnknownAsPrinted(closed.palletId) } } }
    fun deferLabel() { val closed = _state.value.closeStep.closedPallet(); _state.update { it.copy(closeStep = PalletCloseStep.Idle) }; if (closed != null) viewModelScope.launch { recovery.work { gateway.defer(closed.palletId) } } }
    fun dismissClose() { _state.update { it.copy(closeStep = PalletCloseStep.Idle) } }
    fun acknowledge() { val pallet = _state.value.pallet ?: return; viewModelScope.launch { recovery.work { gateway.acknowledge(pallet.palletId) } } }
    fun refresh() { viewModelScope.launch { runCatching { gateway.refresh() } } }

    private companion object { const val TAIL = 6 }
}
```

`PalletsRepository : PalletsGateway` (in `PalletsFeatureModule.kt`, `@Provides @Singleton`) wires `WarehousePallets`, `PalletBootstrapMirror`, `PalletPrinter`, `ExceptionEngine.reprintPallet(null, …)`, `SyncEngine.nudge`, DAOs. Register `WarehousePallets` and `ClosePallet` providers if not already provided (`ClosePallet` is constructed where `CloseBox` is — reuse that provider).

- [ ] **Step 4: Screens** (`PalletsScreens.kt`): `PalletsRoute(state, cb: PalletsCallbacks)` with

```kotlin
data class PalletsCallbacks(val onBack: () -> Unit = {}, val onRemove: (String) -> Unit = {}, val onEarlyClose: () -> Unit = {}, val onCancelEarlyClose: () -> Unit = {}, val onConfirmEarlyClose: () -> Unit = {}, val onAcknowledge: () -> Unit = {}, val onRefresh: () -> Unit = {}, val close: PalletCloseCallbacks = PalletCloseCallbacks())
```

Composition rules (mirror `WriteoffRoute`): `blocked` → `FullScreenState(Icons.Outlined.Warning, title, text, primary = StateAction(pallets_to_hub, onBack), tone = Tone.Warn)`; `closeStep !is Idle` → `PalletCloseScreen(state.closeStep, cb.close)` (the 06d screen, reused as-is); `confirmEarlyClose` → `AlertDialog` with `pallet_close_confirm_*` strings and `boxCount`/`capacity ?: boxCount`; otherwise `Column { AppBar(pallets_title, onBack) { IconAction(Icons.Outlined.Refresh, pallets_refresh, onRefresh) }; stamp line (common_data_as_of); rejections banner when non-empty: Banner(pluralStringResource(pallets_rejected, n, n), Tone.Warn, Icons.Outlined.Warning) + one row per rejection «…tail — reason text» + SecondaryButton(pallets_acknowledge, onAcknowledge); lastVerdict → VerdictRow; pallet == null → FullScreenState(Icons.Outlined.QrCodeScanner, pallets_empty_title, pallets_empty_text); else PalletStrip(boxCount, capacity ?: boxCount) (when capacity null show pallets_count_no_capacity), product name caption, members list newest first (row: Inventory2 icon, «короб …tail», status chip: pending → pallets_status_pending, sent → pallets_status_sent, accepted → pallets_status_accepted; IconAction(Close) only when status == pending), SecondaryButton(work_close_pallet_early, onEarlyClose) }`.

Reason text mapping (`rejectionText(reason)`): `already_on_pallet` → `pallets_reject_already_on_pallet` (+ winner tail when present), `not_found` → `pallets_reject_not_found`, `not_closed` → `pallets_reject_not_closed`, `disassembled` → `pallets_reject_disassembled`, `pallet_closed` → `pallets_reject_pallet_closed`, `product_mismatch` → `pallets_reject_product_mismatch`, `subscription_read_only` → `pallets_reject_read_only`, else `pallets_reject_other`.

- [ ] **Step 5: Hub, navigation**

`HubTile.PALLETS`; `HubUi.canBuildPallets: Boolean?`, `palletsPending: Int` (memberships pending count from `PalletMembershipDao.observePendingCount()`); `HubViewModel` takes `palletPermissions: PalletPermissionDao` and `memberships: PalletMembershipDao`, adds two flows to the `combine` (renumber the `values[n]` casts — write them as named locals) — update `HubViewModelTest` constructions accordingly. `HubScreen`: a `Tile(Icons.Outlined.Layers, hub_tile_pallets, status, { onTile(HubTile.PALLETS) }, modifier, statusTone)` beside the write-off tile with `hub_pallets_no_permission` / plural `hub_pallets_pending`. `Routes.PALLETS = "pallets"`; `HubTile.PALLETS -> nav.navigate(Routes.PALLETS)`; `composable(Routes.PALLETS)` binds `PalletsViewModel` with `BackHandler` that first dismisses a non-Idle close step / early-close dialog, then pops to HUB.

- [ ] **Step 6: Strings** (RU / EN; add to both files under `<!-- Warehouse pallets -->`):

```
pallets_title            Паллеты / Pallets
hub_tile_pallets         Паллеты / Pallets
hub_pallets_no_permission нет прав / no permission
hub_pallets_pending (plurals) %d короб не отправлен … / %d box not sent …
pallets_blocked_permission_title  Нет права собирать паллеты / No permission to build pallets
pallets_blocked_permission_text   Попросите менеджера включить «Сборка паллет на ТСД» в карточке сотрудника. / Ask a manager to enable “Build pallets on handheld” for this employee.
pallets_blocked_sync_title  Справочник ещё не загружен / Catalogue not loaded yet
pallets_blocked_sync_text   Подключитесь к сети и откройте раздел заново. / Connect to the network and reopen this section.
pallets_to_hub           На главный экран / To the hub
pallets_refresh          Обновить реестр / Refresh registry
pallets_empty_title      Отсканируйте короб / Scan a box
pallets_empty_text       Первый короб задаёт товар паллеты. / The first box sets the pallet's product.
pallets_count_no_capacity %1$d коробов · ёмкость не задана / %1$d boxes · no capacity set
pallets_member_box       короб …%1$s / box …%1$s
pallets_status_pending   в очереди / queued
pallets_status_sent      отправляется / sending
pallets_status_accepted  принят / accepted
pallets_remove           Убрать с паллеты / Remove from pallet
pallets_verdict_attached Принят …%1$s / Accepted …%1$s
pallets_verdict_already  Уже на этой паллете …%1$s / Already on this pallet …%1$s
pallets_verdict_on_pallet Уже на паллете …%1$s / Already on pallet …%1$s
pallets_verdict_on_open_pallet Уже на открытой паллете другого устройства / Already on another device's open pallet
pallets_verdict_on_local Уже на другой паллете этого ТСД / Already on another pallet of this handheld
pallets_verdict_other_product Другой товар: %1$s / Different product: %1$s
pallets_verdict_unknown_box Короб неизвестен. Обновите реестр / Unknown box. Refresh the registry
pallets_verdict_unknown_product Товар неизвестен / Unknown product
pallets_verdict_is_pallet Это паллета, не короб / That is a pallet, not a box
pallets_verdict_unit_code Это код единицы, нужен SSCC короба / That is a unit code; scan the box SSCC
pallets_verdict_not_a_code Это не код / Not a code
pallets_rejected (plurals) Снимите с паллеты %d короб … / Take %d box off the pallet …
pallets_reject_already_on_pallet На паллете …%1$s / On pallet …%1$s
pallets_reject_not_found  Сервер не знает этот короб / Unknown to the server
pallets_reject_not_closed Короб не закрыт / Box not closed
pallets_reject_disassembled Короб расформирован / Box disassembled
pallets_reject_pallet_closed Паллета уже закрыта на сервере / Pallet already closed on the server
pallets_reject_product_mismatch Другой товар / Different product
pallets_reject_read_only  Подписка только для чтения / Subscription is read-only
pallets_reject_other      Отклонено сервером / Refused by the server
pallets_acknowledge       Принято / Got it
pallet_refused_no_template Нет шаблона этикетки паллеты — задайте его в кабинете / No pallet label template — set one in the cabinet
pallet_refused_no_issuer  В организации не задан GLN — паллета не получит номер / The organisation has no GLN — the pallet cannot be numbered
```

`PalletCloseScreen`'s `Refused` branch must render `ClosePalletResult.NoIssuer` with `pallet_refused_no_issuer` (add the case if the 06d screen lacks it).

- [ ] **Step 7: Screen tests** — `PalletsScreensTest` (Compose rule): blocked screen shows the permission text; empty state; a member row with a pending chip exposes the remove action; a rejection renders the reason and the acknowledge button; `EnglishRenderTest` gets `palletsRendersInEnglish` for the list state with one member and one rejection, and `HubScreenTest` covers the new tile.

- [ ] **Step 8: Run** `--tests 'app.markiro.handheld.feature.pallets.*' --tests 'app.markiro.handheld.feature.hub.*' --tests 'app.markiro.handheld.EnglishRenderTest'` then `./gradlew --no-daemon lintDebug`; expected PASS.

- [ ] **Step 9: Commit** — `git commit -m "feat(handheld): warehouse pallet building mode"`.

---

### Task 9: Pallet disassembly on the handheld (both kinds)

**Files:**

- Modify: `core/exceptions/ExceptionEngine.kt` (`disassemblePallet`), `feature/exceptions/ExceptionsScreens.kt`, `ExceptionsViewModel.kt` (`closedPalletCount`), `AppNavigation.kt` (`Routes.PALLET_DISASSEMBLE = "exceptions/{shiftId}/pallet-disassemble"`, and a shift-less entry `Routes.PALLETS_DISASSEMBLE = "pallets/disassemble"` from the pallets screen overflow)
- Create: `feature/exceptions/PalletDisassembleViewModel.kt`, `feature/exceptions/PalletDisassembleScreens.kt`
- Test: `core/exceptions/ExceptionEngineTest.kt` (pallet cases), `feature/exceptions/PalletDisassembleViewModelTest.kt`, `EnglishRenderTest`, strings

**Interfaces:**

- Produces: `ExceptionEngine.disassemblePallet(palletId, reason: DisassembleReason, operatorId, terminalId): DisassemblePalletResult` (`Retired | AlreadyRetired | NotClosed`) — sets `pallets.disassembledAt` through `PalletDao.markDisassembled` (column added in Task 2), releases every member's `box_registry.localPalletId`, queues `PalletExceptionFact(DISASSEMBLE, palletId, shiftId = pallet.shiftId, …)`.
- `PalletDisassembleStep { ScanPallet; Reason(palletId, sscc, boxCount); Confirm(...); Retired; Refused(message) }` mirrors `DisassembleStep`; the scan resolves `ScanClassifier.classify` → `Sscc` → `PalletDao.bySscc` (closed, not disassembled; for the shift-scoped route also `shiftId == route shift`).

- [ ] **Step 1: Tests first** — engine: retiring a closed warehouse pallet sets `disassembledAt`, queues a `disassemble` fact with `"shiftId":null` in its payload, releases claims; a second call answers `AlreadyRetired`; an open pallet answers `NotClosed`. View model: scanning a box SSCC refuses with `pallet_disassemble_unknown`; a closed pallet's SSCC moves to `Reason`; confirm calls the engine and shows `Retired`.
- [ ] **Step 2: Run to see them fail.**
- [ ] **Step 3: Implement** engine + view model + screens (copy `DisassembleViewModel`/`DisassembleScreens` structure with pallet strings: `exceptions_disassemble_pallet` «Расформировать паллету» / “Disassemble pallet”, `pallet_disassemble_scan_hint`, `pallet_disassemble_unknown`, `pallet_disassemble_not_closed`, `pallet_disassemble_already`, `pallet_disassemble_done`), add the `ActionRow` to the exceptions hub (enabled when `closedPalletCount > 0`, unavailable text `exceptions_no_closed_pallets`), add an overflow entry «Расформировать паллету» on the pallets screen leading to the shift-less route.
- [ ] **Step 4: Run** `--tests 'app.markiro.handheld.core.exceptions.*' --tests 'app.markiro.handheld.feature.exceptions.*' --tests 'app.markiro.handheld.core.sync.SyncPalletExceptionsTest' --tests 'app.markiro.handheld.EnglishRenderTest'`; expected PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(handheld): disassemble a pallet from the terminal"`.

---

### Task 10: Full gates and docs

**Files:**

- Modify: `apps/handheld/README.md` (mode description, route, permission), `docs/superpowers/specs/2026-09-17-warehouse-pallet-aggregation-design.md` (status line: handheld implemented; §3.1 notes `disassembledAt` column and the shift-less disassemble route)

- [ ] **Step 1:** From `apps/handheld`: `./gradlew --no-daemon testDebugUnitTest lintDebug assembleDebug`. Expected: all green; record test counts.
- [ ] **Step 2:** From the repo root: `pnpm --filter @markiro/domain exec vitest run test/sync-limits-fixtures.test.ts` (fixture unchanged) and `pnpm format:check` (README/spec).
- [ ] **Step 3:** Update the README and spec; `git diff --check`.
- [ ] **Step 4: Commit** — `git commit -m "docs(handheld): warehouse pallets mode"`.

Not proven by any gate: vendor scanner intents on a real terminal, physical pallet label output, and the sync against a live server — report them as not run.

---

## Self-review against spec §3

- §3.1 storage: Task 2 (entities incl. `disassembledAt`, memberships, registry rename + `localPalletId`, bootstrap caches, meta keys; ext-1 range via `SsccBlockApplier` in Task 4).
- §3.2 screen: Task 8 (hub tile + permission, scan gate, `ScanClassifier`, six checks in `WarehousePallets.attach` (Task 6), opening on first scan, strip, capacity/early close, label rules in Task 7, remove-while-pending, conflict banner + reprint + acknowledge), Task 9 (disassemble for both kinds).
- §3.3 sync: Task 5 (pinned channel, batch-id signature, per-record outcomes, `replayed` = accepted, registry refresh after batches — the pallets screen refreshes on entry and on «Обновить»; add a `refresh()` call from `SyncEngine` completion is NOT done here: the registry walk runs from the screen, which is enough because a rejection already releases the local claim).
- §3.4 strings: Tasks 8–9.
- Server contract additions since the spec: `pallet_closed` status (Task 5/8), `subscription_read_only` (Task 5/8), bootstrap `chzProductGroupCode` keys (Task 4).
