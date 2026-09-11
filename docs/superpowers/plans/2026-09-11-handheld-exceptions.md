# Handheld exceptions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the handheld the four operator corrections the station already
has — undo a scan, clear an open box, disassemble a closed box, reprint its
label — against the server contract that already accepts them.

**Architecture:** A sealed `ExceptionFact` hierarchy makes the server's closed
wire shape a compile-time fact; facts are stored with their exact JSON and
drained as a fifth channel of the existing sync batch, gated by a watermark so
an exception never reaches the server before the scan it corrects. The four
actions are reached from the work screen's overflow menu.

**Tech Stack:** Kotlin 2.2, Jetpack Compose/Material3, Hilt, Room 2.7.2,
kotlinx.serialization, Retrofit, JUnit 4 + Robolectric, Turbine.

## Global Constraints

- `minSdk = 28`. Gradle project at `apps/handheld`, outside the pnpm workspace.
- Spec: [`docs/superpowers/specs/2026-09-11-handheld-exceptions-design.md`](../specs/2026-09-11-handheld-exceptions-design.md). Read it before Task 1.
- **The wire shape is closed and load-bearing.** `undo` carries `codeHash` and
  `targetScannedAt` and no `reason`; `clear` carries neither code fields nor a
  reason; `disassemble` and `reprint` carry a reason and no code fields. All
  nine keys are always present, nulls spelled out. A violation is a 400 on the
  whole batch, retried forever, wedging scans, box closures and shift closure on
  that device permanently.
- The exceptions array is capped at **200** per batch server-side
  (`apps/api/src/modules/station-scans/dto.ts`).
- `targetScannedAt` is a **join key**, copied from `CodeEntity.scannedAt`. Never
  read from the clock.
- Reason strings sent to the server are the canonical Russian wording, verbatim
  from `apps/station/src/i18n/ru.json`. The UI label is localized; the audit
  value is not.
- No server file changes. This slice touches `apps/handheld` only.
- Gates per task: `./gradlew :app:testDebugUnitTest --tests '<filter>'`, and
  before the PR `./gradlew :app:testDebugUnitTest :app:lintDebug :app:assembleDebug`.
- Run Gradle from `apps/handheld`.

## File structure

**Create:**

| File                                         | Responsibility                                                         |
| -------------------------------------------- | ---------------------------------------------------------------------- |
| `core/exceptions/ExceptionFacts.kt`          | The sealed fact hierarchy, the reason vocabularies, and `toWireJson()` |
| `core/exceptions/ExceptionEngine.kt`         | Applies one correction locally in a transaction and queues its fact    |
| `core/exceptions/ExceptionModule.kt`         | Hilt binding for the engine                                            |
| `core/storage/ExceptionEntities.kt`          | `BoxExceptionEntity`                                                   |
| `core/storage/ExceptionDaos.kt`              | `BoxExceptionDao`                                                      |
| `feature/exceptions/ExceptionsViewModel.kt`  | List availability, the two named-target confirmations                  |
| `feature/exceptions/ExceptionsScreens.kt`    | List, undo and clear confirmations                                     |
| `feature/exceptions/DisassembleViewModel.kt` | The three-step stepper                                                 |
| `feature/exceptions/DisassembleScreens.kt`   | Scan → reason → confirm                                                |
| `feature/exceptions/ReprintViewModel.kt`     | Target choice, reason, print                                           |
| `feature/exceptions/ReprintScreens.kt`       | Target list and reason                                                 |

**Modify:** `core/storage/HandheldDatabase.kt` (version 7, one new entity, one
DAO), `core/storage/Migrations.kt` (`MIGRATION_6_7`), `core/storage/BoxEntities.kt`
(`disassembledAt`), `core/storage/BoxDaos.kt`, `core/storage/ShiftDaos.kt`
(`maxId`, and `CodeDao` gains `lastIn`/`delete`/`deleteInBox`),
`core/box/Sscc.kt` (a parser), `core/storage/DeviceWipe.kt`, `core/storage/MetaStore.kt`,
`core/network/SyncDtos.kt`, `core/sync/SyncEngine.kt`, `AppNavigation.kt`,
`feature/work/WorkScreen.kt`, `feature/work/LabelQueueViewModel.kt`,
`feature/work/WorkViewModel.kt`, `res/values/strings.xml`, `res/values-en/strings.xml`.

---

### Task 1: The wire format as a type

**Files:**

- Create: `apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/exceptions/ExceptionFacts.kt`
- Test: `apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/exceptions/ExceptionFactsTest.kt`

**Interfaces:**

- Produces: `sealed interface ExceptionFact` with `Undo`, `Clear`, `Disassemble`,
  `Reprint`; `fun ExceptionFact.toWireJson(): JsonObject`; `enum class
DisassembleReason(val audit: String)`; `enum class ReprintReason(val audit: String)`.

- [ ] **Step 1: Write the failing test**

Create `ExceptionFactsTest.kt`:

```kotlin
package app.markiro.handheld.core.exceptions

import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The server validates each fact with a `superRefine` that rejects the WHOLE
 * batch on a wrong shape, and a rejected batch is retried forever. These four
 * assertions are what stands between a typo and a permanently wedged device.
 */
class ExceptionFactsTest {
    private val keys = listOf(
        "kind", "boxId", "codeHash", "targetScannedAt",
        "shiftId", "terminalId", "operatorId", "reason", "occurredAt",
    )

    private val undo = ExceptionFact.Undo(
        boxId = "box-1", shiftId = "11111111-1111-4111-8111-111111111111",
        terminalId = "dev-1", operatorId = "22222222-2222-4222-8222-222222222222",
        occurredAt = "2026-09-11T08:00:00.000Z",
        codeHash = "a".repeat(64), targetScannedAt = "2026-09-11T07:59:00.000Z",
    )
    private val clear = ExceptionFact.Clear(
        boxId = "box-1", shiftId = undo.shiftId, terminalId = "dev-1",
        operatorId = undo.operatorId, occurredAt = undo.occurredAt,
    )
    private val disassemble = ExceptionFact.Disassemble(
        boxId = "box-1", shiftId = undo.shiftId, terminalId = "dev-1",
        operatorId = undo.operatorId, occurredAt = undo.occurredAt,
        reason = DisassembleReason.WRONG_PRODUCT.audit,
    )
    private val reprint = ExceptionFact.Reprint(
        boxId = "box-1", shiftId = undo.shiftId, terminalId = "dev-1",
        operatorId = undo.operatorId, occurredAt = undo.occurredAt,
        reason = ReprintReason.DAMAGED_LABEL.audit,
    )

    /** Every key is always present: the server's nullable fields have no default. */
    @Test
    fun everyKindCarriesEveryKey() {
        for (fact in listOf(undo, clear, disassemble, reprint)) {
            assertEquals(fact.kind, keys, fact.toWireJson().keys.toList())
        }
    }

    @Test
    fun undoCarriesTheCodeAndNoReason() {
        val json = undo.toWireJson()
        assertEquals("undo", json["kind"]!!.jsonPrimitive.content)
        assertEquals("a".repeat(64), json["codeHash"]!!.jsonPrimitive.content)
        assertEquals("2026-09-11T07:59:00.000Z", json["targetScannedAt"]!!.jsonPrimitive.content)
        assertEquals(JsonNull, json["reason"])
    }

    @Test
    fun clearCarriesNeitherCodeNorReason() {
        val json = clear.toWireJson()
        assertEquals("clear", json["kind"]!!.jsonPrimitive.content)
        assertEquals(JsonNull, json["codeHash"])
        assertEquals(JsonNull, json["targetScannedAt"])
        assertEquals(JsonNull, json["reason"])
    }

    @Test
    fun disassembleAndReprintCarryAReasonAndNoCode() {
        for (fact in listOf(disassemble, reprint)) {
            val json = fact.toWireJson()
            assertEquals(JsonNull, json["codeHash"])
            assertEquals(JsonNull, json["targetScannedAt"])
            assertEquals(fact.kind, false, json["reason"] == JsonNull)
        }
        assertEquals("Неверный товар", disassemble.toWireJson()["reason"]!!.jsonPrimitive.content)
        assertEquals("Этикетка повреждена", reprint.toWireJson()["reason"]!!.jsonPrimitive.content)
    }

    /** A null operator is a null, not a missing key. */
    @Test
    fun anAbsentOperatorIsStillSpelledOut() {
        val json = clear.copy(operatorId = null, terminalId = null).toWireJson()
        assertEquals(JsonNull, json["operatorId"])
        assertEquals(JsonNull, json["terminalId"])
    }

    /** The audit wording must match the station's, or one ledger reads two ways. */
    @Test
    fun theAuditWordingIsTheStationsVerbatim() {
        assertEquals(
            listOf("Неверный товар", "Неверное количество", "Упаковка повреждена", "Отклонено контролем качества"),
            DisassembleReason.entries.map { it.audit },
        )
        assertEquals(
            listOf("Этикетка повреждена", "Этикетка не читается", "Замятие принтера / нет печати", "Запрос контроля качества"),
            ReprintReason.entries.filter { it != ReprintReason.PRINT_OUTCOME_UNKNOWN }.map { it.audit },
        )
    }
}
```

- [ ] **Step 2: Run it to confirm it fails**

Run from `apps/handheld`:

```bash
./gradlew :app:testDebugUnitTest --tests '*ExceptionFactsTest'
```

Expected: compilation failure, `Unresolved reference: ExceptionFact`.

- [ ] **Step 3: Write the implementation**

Create `ExceptionFacts.kt`:

```kotlin
package app.markiro.handheld.core.exceptions

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * One operator correction, in the only four shapes the server accepts.
 *
 * A sealed hierarchy rather than one class with four nullable fields, because
 * the server's `superRefine` rejects the WHOLE batch when a fact carries a
 * field its kind forbids, and a rejected batch is retried indefinitely --
 * wedging scans, box closures and shift closure on that device. Making the
 * shape a type removes the class of bug: there is no way to construct a
 * `Clear` that carries a code hash.
 */
sealed interface ExceptionFact {
    val kind: String
    val boxId: String
    val shiftId: String

    /** Informational on the wire: the server always uses the authenticated device. */
    val terminalId: String?
    val operatorId: String?
    val occurredAt: String

    data class Undo(
        override val boxId: String,
        override val shiftId: String,
        override val terminalId: String?,
        override val operatorId: String?,
        override val occurredAt: String,
        val codeHash: String,
        /**
         * The original scan's own `scannedAt`, copied from `codes_mirror`.
         *
         * A JOIN KEY, not a timestamp: the server matches the claim it releases
         * by this exact value. Reading the clock here instead sent a whole
         * slice's events to quarantine once already.
         */
        val targetScannedAt: String,
    ) : ExceptionFact {
        override val kind get() = "undo"
    }

    data class Clear(
        override val boxId: String,
        override val shiftId: String,
        override val terminalId: String?,
        override val operatorId: String?,
        override val occurredAt: String,
    ) : ExceptionFact {
        override val kind get() = "clear"
    }

    data class Disassemble(
        override val boxId: String,
        override val shiftId: String,
        override val terminalId: String?,
        override val operatorId: String?,
        override val occurredAt: String,
        val reason: String,
    ) : ExceptionFact {
        override val kind get() = "disassemble"
    }

    data class Reprint(
        override val boxId: String,
        override val shiftId: String,
        override val terminalId: String?,
        override val operatorId: String?,
        override val occurredAt: String,
        val reason: String,
    ) : ExceptionFact {
        override val kind get() = "reprint"
    }
}

/**
 * Every key, always present, nulls spelled out.
 *
 * Built by hand rather than serialized from a class because the Retrofit
 * converter uses the lenient `Json` (`explicitNulls = false`, see
 * `core/network/NetworkModule.kt`), which DROPS a null-valued field -- and
 * `codeHash`, `reason`, `terminalId` and `operatorId` are declared `.nullable()`
 * WITHOUT `.default()` on the server, so an absent key fails validation for the
 * whole batch. This is the same reason `productLabelEvents` is a list of raw
 * JSON elements.
 */
fun ExceptionFact.toWireJson(): JsonObject {
    val undo = this as? ExceptionFact.Undo
    val reason = when (this) {
        is ExceptionFact.Disassemble -> reason
        is ExceptionFact.Reprint -> reason
        is ExceptionFact.Undo, is ExceptionFact.Clear -> null
    }
    return buildJsonObject {
        put("kind", kind)
        put("boxId", boxId)
        put("codeHash", undo?.codeHash)
        put("targetScannedAt", undo?.targetScannedAt)
        put("shiftId", shiftId)
        put("terminalId", terminalId)
        put("operatorId", operatorId)
        put("reason", reason)
        put("occurredAt", occurredAt)
    }
}

/**
 * The audit text is a WIRE value, not UI copy, so it lives here rather than in
 * `strings.xml`: the server stores exactly this string and the station stores
 * the same Russian wording (`apps/station/src/i18n/ru.json`). A handheld
 * switched to English shows a localized label and still sends the canonical
 * text, so one manager's ledger does not end up half translated.
 */
enum class DisassembleReason(val audit: String) {
    WRONG_PRODUCT("Неверный товар"),
    WRONG_QUANTITY("Неверное количество"),
    DAMAGED_PACKAGE("Упаковка повреждена"),
    QUALITY_REJECTED("Отклонено контролем качества"),
}

enum class ReprintReason(val audit: String) {
    DAMAGED_LABEL("Этикетка повреждена"),
    UNREADABLE_LABEL("Этикетка не читается"),
    PRINTER_JAM("Замятие принтера / нет печати"),
    QUALITY_REQUEST("Запрос контроля качества"),

    /**
     * Never offered in the reason list: written by print recovery when the
     * operator resolves an unknown outcome with «Напечатать ещё раз» (Task 7).
     */
    PRINT_OUTCOME_UNKNOWN("Результат печати неизвестен"),
}
```

- [ ] **Step 4: Run the test to confirm it passes**

```bash
./gradlew :app:testDebugUnitTest --tests '*ExceptionFactsTest'
```

Expected: BUILD SUCCESSFUL.

- [ ] **Step 5: Commit**

```bash
git add apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/exceptions/ExceptionFacts.kt apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/exceptions/ExceptionFactsTest.kt
git commit -m "feat(handheld): форма исключения как тип, а не как соглашение"
```

---

### Task 2: Storage and the migration

**Files:**

- Create: `core/storage/ExceptionEntities.kt`, `core/storage/ExceptionDaos.kt`
- Modify: `core/storage/BoxEntities.kt`, `core/storage/BoxDaos.kt`,
  `core/storage/ShiftDaos.kt`, `core/storage/Migrations.kt`,
  `core/storage/HandheldDatabase.kt`, `core/storage/DeviceWipe.kt`
- Test: `apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/storage/ExceptionStorageTest.kt`

**Interfaces:**

- Consumes: nothing from Task 1.
- Produces: `BoxExceptionEntity(id, kind, boxId, codeHash, targetScannedAt,
shiftId, operatorId, reason, occurredAt, payloadJson, afterOutboxId, ackedAt)`;
  `BoxExceptionDao` with `insert`, `sendable(through: Long, limit: Int)`,
  `markAcked(ids: List<Long>, at: String)`, `observeUnackedCount()`, `clear()`;
  `BoxDao.markDisassembled(boxId, at)`, `BoxDao.reprintable(shiftId)`,
  `BoxDao.observeReprintable(shiftId)`; `OutboxDao.maxId()`.

- [ ] **Step 1: Write the failing test**

Create `ExceptionStorageTest.kt`:

```kotlin
package app.markiro.handheld.core.storage

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ExceptionStorageTest {
    private lateinit var db: HandheldDatabase

    @Before
    fun setUp() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries().build()
    }

    @After
    fun tearDown() = db.close()

    private fun fact(
        kind: String,
        boxId: String = "box-1",
        afterOutboxId: Long = 0,
    ) = BoxExceptionEntity(
        kind = kind,
        boxId = boxId,
        codeHash = if (kind == "undo") "a".repeat(64) else null,
        targetScannedAt = if (kind == "undo") "2026-09-11T07:59:00.000Z" else null,
        shiftId = "s1",
        operatorId = "op-1",
        reason = if (kind == "disassemble" || kind == "reprint") "Неверный товар" else null,
        occurredAt = "2026-09-11T08:00:00.000Z",
        payloadJson = """{"kind":"$kind"}""",
        afterOutboxId = afterOutboxId,
        ackedAt = null,
    )

    private fun box(boxId: String, acked: Boolean) = BoxEntity(
        boxId = boxId, shiftId = "s1", sscc = "000000000000000017",
        openedAt = "2026-09-11T07:00:00.000Z", closedAt = "2026-09-11T07:30:00.000Z",
        operatorId = "op-1", printState = "printed", printReason = null,
        ackedAt = if (acked) "2026-09-11T07:31:00.000Z" else null, disassembledAt = null,
    )

    private fun outboxRow() = OutboxEntity(
        shiftId = "s1", raw = "01046000000000152", verdict = "ok",
        scannedAt = "2026-09-11T07:59:00.000Z", operatorId = "op-1",
        codeHash = "a".repeat(64), gtin14 = "04600000000015", serial = "x", boxId = "box-1",
    )

    /**
     * The ordering guarantee: an undo queued behind a backlog of unsent scans
     * must not leave before the scan it corrects, or the server applies it
     * against a row that does not exist yet and silently drops it.
     */
    @Test
    fun anExceptionWaitsForTheScansItCorrects() = runTest {
        db.outboxDao().insert(outboxRow())
        db.outboxDao().insert(outboxRow())
        val watermark = db.outboxDao().maxId()
        db.boxExceptionDao().insert(fact("undo", afterOutboxId = watermark))
        // Nothing has been sent yet: a batch whose ceiling is below the watermark must not carry it.
        assertEquals(emptyList<String>(), db.boxExceptionDao().sendable(1, 10).map { it.kind })
        // A batch whose ceiling reaches the watermark carries the scans in the same request.
        assertEquals(listOf("undo"), db.boxExceptionDao().sendable(watermark, 10).map { it.kind })
    }

    @Test
    fun aScanQueuedAfterTheExceptionDoesNotDelayIt() = runTest {
        val watermark = db.outboxDao().maxId()
        db.boxExceptionDao().insert(fact("clear", afterOutboxId = watermark))
        db.outboxDao().insert(outboxRow())
        assertEquals(listOf("clear"), db.boxExceptionDao().sendable(Long.MAX_VALUE, 10).map { it.kind })
    }

    /** Disassemble and reprint name a box the server must already know about. */
    @Test
    fun aClosedBoxExceptionWaitsForItsClosureToBeAcknowledged() = runTest {
        db.boxDao().insert(box("box-9", acked = false))
        db.boxExceptionDao().insert(fact("disassemble", boxId = "box-9"))
        assertEquals(emptyList<String>(), db.boxExceptionDao().sendable(Long.MAX_VALUE, 10).map { it.kind })
        db.boxDao().markAcked(listOf("box-9"), "2026-09-11T08:05:00.000Z")
        assertEquals(listOf("disassemble"), db.boxExceptionDao().sendable(Long.MAX_VALUE, 10).map { it.kind })
    }

    /** Undo and clear target an OPEN box the server knows only through its items. */
    @Test
    fun anOpenBoxExceptionDoesNotWaitForABoxRow() = runTest {
        db.boxExceptionDao().insert(fact("undo", boxId = "box-open"))
        assertEquals(listOf("undo"), db.boxExceptionDao().sendable(Long.MAX_VALUE, 10).map { it.kind })
    }

    @Test
    fun sendableIsOldestFirstAndAcknowledgesById() = runTest {
        db.boxExceptionDao().insert(fact("undo"))
        db.boxExceptionDao().insert(fact("clear"))
        val rows = db.boxExceptionDao().sendable(Long.MAX_VALUE, 10)
        assertEquals(listOf("undo", "clear"), rows.map { it.kind })
        db.boxExceptionDao().markAcked(listOf(rows.first().id), "2026-09-11T09:00:00.000Z")
        assertEquals(listOf("clear"), db.boxExceptionDao().sendable(Long.MAX_VALUE, 10).map { it.kind })
    }

    @Test
    fun theQueueDepthCountsOnlyWhatIsStillOwed() = runTest {
        db.boxExceptionDao().insert(fact("undo"))
        assertEquals(1, db.boxExceptionDao().unackedCount())
        db.boxExceptionDao().markAcked(db.boxExceptionDao().sendable(Long.MAX_VALUE, 10).map { it.id }, "2026-09-11T09:00:00.000Z")
        assertEquals(0, db.boxExceptionDao().unackedCount())
    }

    /** A retired box leaves the reprint list and never comes back. */
    @Test
    fun aDisassembledBoxIsNoLongerReprintable() = runTest {
        db.boxDao().insert(box("box-1", acked = true))
        assertEquals(listOf("box-1"), db.boxDao().reprintable("s1").map { it.boxId })
        db.boxDao().markDisassembled("box-1", "2026-09-11T08:10:00.000Z")
        assertEquals(emptyList<String>(), db.boxDao().reprintable("s1").map { it.boxId })
        assertNotNull(db.boxDao().get("box-1")?.disassembledAt)
    }

    /** Retirement happens once; a redelivered confirmation must not restamp it. */
    @Test
    fun disassemblingTwiceKeepsTheFirstStamp() = runTest {
        db.boxDao().insert(box("box-1", acked = true))
        assertEquals(1, db.boxDao().markDisassembled("box-1", "2026-09-11T08:10:00.000Z"))
        assertEquals(0, db.boxDao().markDisassembled("box-1", "2026-09-11T09:10:00.000Z"))
        assertEquals("2026-09-11T08:10:00.000Z", db.boxDao().get("box-1")?.disassembledAt)
    }

    /** An open box has no SSCC to reprint and is not on the list. */
    @Test
    fun anOpenBoxIsNotReprintable() = runTest {
        db.boxDao().insert(box("box-1", acked = true).copy(closedAt = null, sscc = null))
        assertEquals(emptyList<String>(), db.boxDao().reprintable("s1").map { it.boxId })
    }

    @Test
    fun aWipeLeavesNoException() = runTest {
        db.boxExceptionDao().insert(fact("undo"))
        db.boxExceptionDao().clear()
        assertEquals(0, db.boxExceptionDao().unackedCount())
        assertNull(db.boxDao().get("box-1"))
    }
}
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
./gradlew :app:testDebugUnitTest --tests '*ExceptionStorageTest'
```

Expected: compilation failure, `Unresolved reference: BoxExceptionEntity`.

- [ ] **Step 3: Add the entity**

Create `core/storage/ExceptionEntities.kt`:

```kotlin
package app.markiro.handheld.core.storage

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

/**
 * One queued operator correction: the audit fact and the outbox row at once.
 *
 * `payloadJson` is the exact wire object built when the operator confirmed, so
 * a retry resends byte-identical JSON and the shape cannot drift between the
 * moment it was validated and the moment it is sent.
 *
 * `afterOutboxId` is the ordering watermark: the outbox's highest id at that
 * same moment. The drain may not send this row until every scan up to that id
 * has been delivered, or the server would apply the correction against rows
 * that have not arrived yet and drop it without an error anywhere.
 */
@Entity(tableName = "box_exceptions", indices = [Index(value = ["ackedAt"])])
data class BoxExceptionEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val kind: String,
    val boxId: String,
    val codeHash: String?,
    val targetScannedAt: String?,
    val shiftId: String,
    val operatorId: String?,
    val reason: String?,
    val occurredAt: String,
    val payloadJson: String,
    val afterOutboxId: Long,
    val ackedAt: String?,
)
```

- [ ] **Step 4: Add the DAO**

Create `core/storage/ExceptionDaos.kt`:

```kotlin
package app.markiro.handheld.core.storage

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.Query
import kotlinx.coroutines.flow.Flow

@Dao
interface BoxExceptionDao {
    @Insert
    suspend fun insert(row: BoxExceptionEntity): Long

    /**
     * Facts whose targets the server already has, oldest first.
     *
     * `through` is the outbox ceiling of the batch being built, so a fact whose
     * watermark is at or below it rides the same request as the scans it
     * corrects -- the server applies `items` before `exceptions` within one
     * transaction. A fact above the ceiling waits for a later batch.
     *
     * `disassemble` and `reprint` additionally wait for their box's closure to
     * be acknowledged: those two name a closed box, and the box channel has its
     * own per-batch limit, so sharing a request is not guaranteed.
     */
    @Query(
        "SELECT * FROM box_exceptions WHERE ackedAt IS NULL AND afterOutboxId <= :through " +
            "AND (kind IN ('undo', 'clear') OR EXISTS (" +
            "SELECT 1 FROM boxes WHERE boxes.boxId = box_exceptions.boxId AND boxes.ackedAt IS NOT NULL)) " +
            "ORDER BY id LIMIT :limit",
    )
    suspend fun sendable(through: Long, limit: Int): List<BoxExceptionEntity>

    @Query("UPDATE box_exceptions SET ackedAt = :at WHERE id IN (:ids)")
    suspend fun markAcked(ids: List<Long>, at: String)

    @Query("SELECT COUNT(*) FROM box_exceptions WHERE ackedAt IS NULL")
    suspend fun unackedCount(): Int

    @Query("SELECT COUNT(*) FROM box_exceptions WHERE ackedAt IS NULL")
    fun observeUnackedCount(): Flow<Int>

    @Query("DELETE FROM box_exceptions WHERE ackedAt IS NOT NULL")
    suspend fun purgeAcked()

    @Query("DELETE FROM box_exceptions")
    suspend fun clear()
}
```

- [ ] **Step 5: Add the box column and its queries**

In `core/storage/BoxEntities.kt`, add the last field of `BoxEntity`:

```kotlin
    /** Null until the box is retired; once set the SSCC is never reissued. */
    val disassembledAt: String? = null,
```

In `core/storage/BoxDaos.kt`, add to `BoxDao`:

```kotlin
    /** Guarded so a redelivered confirmation cannot restamp a retirement. */
    @Query("UPDATE boxes SET disassembledAt = :at WHERE boxId = :boxId AND disassembledAt IS NULL")
    suspend fun markDisassembled(boxId: String, at: String): Int

    /** Closed, not retired boxes of this shift, most recent first. */
    @Query(
        "SELECT * FROM boxes WHERE shiftId = :shiftId AND closedAt IS NOT NULL " +
            "AND disassembledAt IS NULL ORDER BY closedAt DESC, boxId DESC",
    )
    suspend fun reprintable(shiftId: String): List<BoxEntity>

    @Query(
        "SELECT * FROM boxes WHERE shiftId = :shiftId AND closedAt IS NOT NULL " +
            "AND disassembledAt IS NULL ORDER BY closedAt DESC, boxId DESC",
    )
    fun observeReprintable(shiftId: String): Flow<List<BoxEntity>>

    @Query("SELECT boxId FROM boxes WHERE sscc = :sscc AND disassembledAt IS NULL LIMIT 1")
    suspend fun boxIdBySscc(sscc: String): String?
```

Also exclude retired boxes from the deferred-label queue — change the two
`observeUnprinted` / `observeUnprintedCount` queries to add
`AND disassembledAt IS NULL`, so a box retired before its label printed stops
asking to be printed:

```kotlin
    @Query(
        "SELECT * FROM boxes WHERE closedAt IS NOT NULL AND printState <> 'printed' " +
            "AND disassembledAt IS NULL ORDER BY closedAt, boxId",
    )
    fun observeUnprinted(): Flow<List<BoxEntity>>

    @Query(
        "SELECT COUNT(*) FROM boxes WHERE closedAt IS NOT NULL AND printState <> 'printed' " +
            "AND disassembledAt IS NULL",
    )
    fun observeUnprintedCount(): Flow<Int>
```

In `core/storage/ShiftDaos.kt`, add to `OutboxDao`:

```kotlin
    /** The watermark a correction records: everything queued before it. */
    @Query("SELECT COALESCE(MAX(id), 0) FROM outbox")
    suspend fun maxId(): Long
```

- [ ] **Step 6: Register the table and the migration**

In `core/storage/HandheldDatabase.kt`: add `BoxExceptionEntity::class` to the
`entities` array, bump `version = 7`, and add the accessor next to the other box
DAOs:

```kotlin
    abstract fun boxExceptionDao(): BoxExceptionDao
```

In `core/storage/Migrations.kt`, append:

```kotlin
val MIGRATION_6_7 = object : Migration(6, 7) {
    override fun migrate(db: SupportSQLiteDatabase) {
        db.execSQL("ALTER TABLE `boxes` ADD COLUMN `disassembledAt` TEXT")
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS `box_exceptions` (`id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, " +
                "`kind` TEXT NOT NULL, `boxId` TEXT NOT NULL, `codeHash` TEXT, `targetScannedAt` TEXT, " +
                "`shiftId` TEXT NOT NULL, `operatorId` TEXT, `reason` TEXT, `occurredAt` TEXT NOT NULL, " +
                "`payloadJson` TEXT NOT NULL, `afterOutboxId` INTEGER NOT NULL, `ackedAt` TEXT)",
        )
        db.execSQL("CREATE INDEX IF NOT EXISTS `index_box_exceptions_ackedAt` ON `box_exceptions` (`ackedAt`)")
    }
}
```

Find where the migration list is assembled (`StorageModule.kt` passes them to
`Room.databaseBuilder(...).addMigrations(...)`) and add `MIGRATION_6_7` to it.

In `core/storage/DeviceWipe.kt`, add inside the transaction, immediately above
`db.boxDao().clear()`:

```kotlin
            db.boxExceptionDao().clear()
```

**Do not add a shift-close purge.** `ShiftCloser` drops the duplicate labels'
bytes and purges settled label jobs, and the symmetry is tempting — but an
unacknowledged correction must outlive its shift and drain afterwards, exactly
as a box closure does. `purgeAcked` in Task 4 runs after the server has taken
the fact, which is the only safe moment to drop one.

- [ ] **Step 7: Run the tests**

```bash
./gradlew :app:testDebugUnitTest --tests '*ExceptionStorageTest'
```

Expected: BUILD SUCCESSFUL.

- [ ] **Step 8: Add the migration test**

There is an existing migration test file for this database — find it with
`ls apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/storage/`. Add a
case in the same style, following whatever helper that file already uses to open
a database at an older version:

```kotlin
    /** A device that upgrades mid-shift keeps its boxes and gains an empty queue. */
    @Test
    fun migratingToSevenKeepsBoxesAndAddsTheExceptionQueue() {
        val db = helper.createDatabase(TEST_DB, 6).apply {
            execSQL(
                "INSERT INTO boxes (boxId, shiftId, sscc, openedAt, closedAt, operatorId, printState, printReason, ackedAt) " +
                    "VALUES ('box-1', 's1', '000000000000000017', '2026-09-11T07:00:00.000Z', " +
                    "'2026-09-11T07:30:00.000Z', 'op-1', 'printed', NULL, NULL)",
            )
            close()
        }
        helper.runMigrationsAndValidate(TEST_DB, 7, true, MIGRATION_6_7).use { migrated ->
            migrated.query("SELECT boxId, disassembledAt FROM boxes").use { c ->
                assertTrue(c.moveToFirst())
                assertEquals("box-1", c.getString(0))
                assertTrue(c.isNull(1))
            }
            migrated.query("SELECT COUNT(*) FROM box_exceptions").use { c ->
                assertTrue(c.moveToFirst())
                assertEquals(0, c.getInt(0))
            }
        }
    }
```

If no migration test file exists, create
`core/storage/MigrationTest.kt` using `MigrationTestHelper` with
`HandheldDatabase::class.java`, and register the schema export the helper needs
by setting `exportSchema = true` plus the `room.schemaLocation` KSP argument in
`apps/handheld/app/build.gradle.kts`. Do that only if the file is genuinely
absent — do not duplicate an existing harness.

- [ ] **Step 9: Run the storage suite**

```bash
./gradlew :app:testDebugUnitTest --tests '*core.storage*'
```

Expected: BUILD SUCCESSFUL.

- [ ] **Step 10: Commit**

```bash
git add apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/storage apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/storage
git commit -m "feat(handheld): очередь исключений и признак расформирования короба"
```

---

### Task 3: Applying a correction locally

**Files:**

- Create: `core/exceptions/ExceptionEngine.kt`, `core/exceptions/ExceptionModule.kt`
- Test: `apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/exceptions/ExceptionEngineTest.kt`

**Interfaces:**

- Consumes: `ExceptionFact`, `toWireJson()`, `DisassembleReason`,
  `ReprintReason` (Task 1); `BoxExceptionDao`, `BoxDao.markDisassembled`,
  `OutboxDao.maxId()` (Task 2).
- Produces: `class ExceptionEngine` with
  `suspend fun undoLastScan(shiftId: String, boxId: String, expectedCodeHash: String, operatorId: String?, terminalId: String?): UndoResult`,
  `suspend fun clearBox(shiftId: String, boxId: String, operatorId: String?, terminalId: String?): Int`,
  `suspend fun disassemble(shiftId: String, boxId: String, reason: DisassembleReason, operatorId: String?, terminalId: String?): DisassembleResult`,
  `suspend fun reprint(shiftId: String, boxId: String, reason: ReprintReason, operatorId: String?, terminalId: String?)`,
  `suspend fun lastScanIn(boxId: String): CodeEntity?`;
  `sealed interface UndoResult { data class Undone(val codeHash: String) : UndoResult; data object Stale : UndoResult; data object Empty : UndoResult }`;
  `sealed interface DisassembleResult { data object Retired : DisassembleResult; data object AlreadyRetired : DisassembleResult; data object NotClosed : DisassembleResult }`.

- [ ] **Step 1: Write the failing test**

Create `ExceptionEngineTest.kt`:

```kotlin
package app.markiro.handheld.core.exceptions

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.storage.BoxEntity
import app.markiro.handheld.core.storage.CodeEntity
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.OutboxEntity
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ExceptionEngineTest {
    private lateinit var db: HandheldDatabase
    private var now = 1_757_577_600_000L
    private lateinit var engine: ExceptionEngine

    @Before
    fun setUp() = runTest {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries().build()
        engine = ExceptionEngine(db) { now }
        db.boxDao().insert(
            BoxEntity(
                boxId = "box-1", shiftId = "s1", sscc = null, openedAt = "2026-09-11T07:00:00.000Z",
                closedAt = null, operatorId = "op-1", printState = "pending", printReason = null, ackedAt = null,
            ),
        )
    }

    @After
    fun tearDown() = db.close()

    private suspend fun scan(hash: String, at: String, boxId: String? = "box-1") {
        db.codeDao().insert(CodeEntity(hash, "s1", "04600000000015", hash.take(6), at, boxId))
        db.outboxDao().insert(
            OutboxEntity(
                shiftId = "s1", raw = "raw-$hash", verdict = "ok", scannedAt = at, operatorId = "op-1",
                codeHash = hash, gtin14 = "04600000000015", serial = hash.take(6), boxId = boxId,
            ),
        )
    }

    private val a = "a".repeat(64)
    private val b = "b".repeat(64)

    @Test
    fun undoReleasesTheCodeAndQueuesTheFact() = runTest {
        scan(a, "2026-09-11T07:58:00.000Z")
        scan(b, "2026-09-11T07:59:00.000Z")
        assertEquals(UndoResult.Undone(b), engine.undoLastScan("s1", "box-1", b, "op-1", "dev-1"))
        // Released locally: the code is scannable again on this device immediately.
        assertNull(db.codeDao().get(b))
        assertNotNull(db.codeDao().get(a))
        val queued = db.boxExceptionDao().sendable(Long.MAX_VALUE, 10).single()
        assertEquals("undo", queued.kind)
        // The join key is the ORIGINAL scan's own time, not the moment of the undo.
        assertEquals("2026-09-11T07:59:00.000Z", queued.targetScannedAt)
        val wire = Json.parseToJsonElement(queued.payloadJson)
        assertEquals(b, wire.jsonObject["codeHash"]!!.jsonPrimitive.content)
    }

    /** The journal keeps the scan and records that it was taken back. */
    @Test
    fun undoLeavesAnUndoneEventBehind() = runTest {
        scan(a, "2026-09-11T07:58:00.000Z")
        engine.undoLastScan("s1", "box-1", a, "op-1", "dev-1")
        // `observeRecent` is ordered by id DESC, so the first row is the newest.
        assertEquals("undone", db.scanEventDao().observeRecent("s1", 10).first().first().verdict)
    }

    /** A scan landing between opening the screen and confirming changes the target. */
    @Test
    fun undoRefusesWhenTheLastScanChanged() = runTest {
        scan(a, "2026-09-11T07:58:00.000Z")
        scan(b, "2026-09-11T07:59:00.000Z")
        assertEquals(UndoResult.Stale, engine.undoLastScan("s1", "box-1", a, "op-1", "dev-1"))
        assertNotNull(db.codeDao().get(a))
        assertEquals(0, db.boxExceptionDao().unackedCount())
    }

    @Test
    fun undoOnAnEmptyBoxDoesNothing() = runTest {
        assertEquals(UndoResult.Empty, engine.undoLastScan("s1", "box-1", a, "op-1", "dev-1"))
        assertEquals(0, db.boxExceptionDao().unackedCount())
    }

    /** The watermark is taken at confirmation: everything queued before it. */
    @Test
    fun undoRecordsTheOutboxWatermark() = runTest {
        scan(a, "2026-09-11T07:58:00.000Z")
        scan(b, "2026-09-11T07:59:00.000Z")
        engine.undoLastScan("s1", "box-1", b, "op-1", "dev-1")
        assertEquals(db.outboxDao().maxId(), db.boxExceptionDao().sendable(Long.MAX_VALUE, 10).single().afterOutboxId)
    }

    @Test
    fun clearReleasesEveryCodeOfTheBoxAndOnlyThatBox() = runTest {
        scan(a, "2026-09-11T07:58:00.000Z")
        scan(b, "2026-09-11T07:59:00.000Z")
        scan("c".repeat(64), "2026-09-11T07:59:30.000Z", boxId = "box-2")
        assertEquals(2, engine.clearBox("s1", "box-1", "op-1", "dev-1"))
        assertNull(db.codeDao().get(a))
        assertNull(db.codeDao().get(b))
        assertNotNull(db.codeDao().get("c".repeat(64)))
        val queued = db.boxExceptionDao().sendable(Long.MAX_VALUE, 10).single()
        assertEquals("clear", queued.kind)
        assertNull(queued.codeHash)
    }

    /** Clearing an empty box is a no-op, not a queued fact about nothing. */
    @Test
    fun clearingAnEmptyBoxQueuesNothing() = runTest {
        assertEquals(0, engine.clearBox("s1", "box-1", "op-1", "dev-1"))
        assertEquals(0, db.boxExceptionDao().unackedCount())
    }

    @Test
    fun disassembleRetiresTheBoxAndReleasesItsCodes() = runTest {
        scan(a, "2026-09-11T07:58:00.000Z")
        db.boxDao().close("box-1", "000000000000000017", "2026-09-11T08:00:00.000Z", "op-1")
        assertEquals(
            DisassembleResult.Retired,
            engine.disassemble("s1", "box-1", DisassembleReason.WRONG_PRODUCT, "op-1", "dev-1"),
        )
        assertNotNull(db.boxDao().get("box-1")?.disassembledAt)
        assertNull(db.codeDao().get(a))
        val queued = db.boxExceptionDao().sendable(Long.MAX_VALUE, 10).single()
        assertEquals("disassemble", queued.kind)
        assertEquals("Неверный товар", queued.reason)
    }

    @Test
    fun disassembleRefusesAnOpenBox() = runTest {
        assertEquals(
            DisassembleResult.NotClosed,
            engine.disassemble("s1", "box-1", DisassembleReason.WRONG_PRODUCT, "op-1", "dev-1"),
        )
        assertEquals(0, db.boxExceptionDao().unackedCount())
    }

    @Test
    fun disassemblingTwiceQueuesOneFact() = runTest {
        db.boxDao().close("box-1", "000000000000000017", "2026-09-11T08:00:00.000Z", "op-1")
        engine.disassemble("s1", "box-1", DisassembleReason.WRONG_PRODUCT, "op-1", "dev-1")
        assertEquals(
            DisassembleResult.AlreadyRetired,
            engine.disassemble("s1", "box-1", DisassembleReason.WRONG_PRODUCT, "op-1", "dev-1"),
        )
        assertEquals(1, db.boxExceptionDao().unackedCount())
    }

    /** Reprint is an audit fact and nothing else: no box or item state moves. */
    @Test
    fun reprintChangesNothingButTheLedger() = runTest {
        scan(a, "2026-09-11T07:58:00.000Z")
        db.boxDao().close("box-1", "000000000000000017", "2026-09-11T08:00:00.000Z", "op-1")
        engine.reprint("s1", "box-1", ReprintReason.DAMAGED_LABEL, "op-1", "dev-1")
        assertNotNull(db.codeDao().get(a))
        assertNull(db.boxDao().get("box-1")?.disassembledAt)
        val queued = db.boxExceptionDao().sendable(Long.MAX_VALUE, 10).single()
        assertEquals("reprint", queued.kind)
        assertEquals("Этикетка повреждена", queued.reason)
    }

    /** Every stored payload is the exact object that goes on the wire. */
    @Test
    fun everyQueuedFactStoresAllNineKeys() = runTest {
        scan(a, "2026-09-11T07:58:00.000Z")
        engine.undoLastScan("s1", "box-1", a, "op-1", "dev-1")
        db.boxDao().close("box-1", "000000000000000017", "2026-09-11T08:00:00.000Z", "op-1")
        engine.reprint("s1", "box-1", ReprintReason.PRINTER_JAM, "op-1", "dev-1")
        for (row in db.boxExceptionDao().sendable(Long.MAX_VALUE, 10)) {
            val keys = Json.parseToJsonElement(row.payloadJson).jsonObject.keys
            assertTrue(row.kind, keys.size == 9)
        }
    }
}
```

Add the imports `kotlinx.serialization.json.jsonObject` and
`kotlinx.coroutines.flow.first` alongside the others.

- [ ] **Step 2: Run it to confirm it fails**

```bash
./gradlew :app:testDebugUnitTest --tests '*ExceptionEngineTest'
```

Expected: compilation failure, `Unresolved reference: ExceptionEngine`.

- [ ] **Step 3: Write the engine**

Create `core/exceptions/ExceptionEngine.kt`:

```kotlin
package app.markiro.handheld.core.exceptions

import androidx.room.withTransaction
import app.markiro.handheld.core.storage.BoxExceptionEntity
import app.markiro.handheld.core.storage.CodeEntity
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.ScanEventEntity
import app.markiro.handheld.core.util.Iso

sealed interface UndoResult {
    data class Undone(val codeHash: String) : UndoResult

    /** A scan landed between the confirmation screen opening and the operator confirming. */
    data object Stale : UndoResult
    data object Empty : UndoResult
}

sealed interface DisassembleResult {
    data object Retired : DisassembleResult
    data object AlreadyRetired : DisassembleResult
    data object NotClosed : DisassembleResult
}

/**
 * The four operator corrections, applied on this device and queued for the
 * server.
 *
 * Every one is a single Room transaction: the local effect and the queued fact
 * land together or not at all. A correction the operator saw applied must never
 * be missing from the queue, and a fact must never describe a release that did
 * not happen.
 */
class ExceptionEngine(
    private val db: HandheldDatabase,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    /** The undo target: what the confirmation screen names. */
    suspend fun lastScanIn(boxId: String): CodeEntity? = db.codeDao().lastIn(boxId)

    suspend fun undoLastScan(
        shiftId: String,
        boxId: String,
        expectedCodeHash: String,
        operatorId: String?,
        terminalId: String?,
    ): UndoResult = db.withTransaction {
        val last = db.codeDao().lastIn(boxId) ?: return@withTransaction UndoResult.Empty
        if (last.codeHash != expectedCodeHash) return@withTransaction UndoResult.Stale
        val at = Iso.format(clock())
        // Released locally first: the row leaving `codes_mirror` is what makes the
        // code scannable again on this device without waiting for a round trip.
        db.codeDao().delete(last.codeHash)
        db.scanEventDao().insert(
            ScanEventEntity(
                shiftId = shiftId, raw = "", verdict = "undone", scannedAt = at,
                operatorId = operatorId, codeHash = last.codeHash,
            ),
        )
        queue(
            ExceptionFact.Undo(
                boxId = boxId, shiftId = shiftId, terminalId = terminalId, operatorId = operatorId,
                occurredAt = at,
                codeHash = last.codeHash,
                // The ORIGINAL scan's own time. The server joins the claim by it.
                targetScannedAt = last.scannedAt,
            ),
        )
        UndoResult.Undone(last.codeHash)
    }

    /** Returns how many units were released; zero queues nothing. */
    suspend fun clearBox(
        shiftId: String,
        boxId: String,
        operatorId: String?,
        terminalId: String?,
    ): Int = db.withTransaction {
        val released = db.codeDao().deleteInBox(boxId)
        if (released == 0) return@withTransaction 0
        queue(
            ExceptionFact.Clear(
                boxId = boxId, shiftId = shiftId, terminalId = terminalId,
                operatorId = operatorId, occurredAt = Iso.format(clock()),
            ),
        )
        released
    }

    suspend fun disassemble(
        shiftId: String,
        boxId: String,
        reason: DisassembleReason,
        operatorId: String?,
        terminalId: String?,
    ): DisassembleResult = db.withTransaction {
        val box = db.boxDao().get(boxId) ?: return@withTransaction DisassembleResult.NotClosed
        if (box.closedAt == null) return@withTransaction DisassembleResult.NotClosed
        val at = Iso.format(clock())
        if (db.boxDao().markDisassembled(boxId, at) == 0) return@withTransaction DisassembleResult.AlreadyRetired
        db.codeDao().deleteInBox(boxId)
        queue(
            ExceptionFact.Disassemble(
                boxId = boxId, shiftId = shiftId, terminalId = terminalId,
                operatorId = operatorId, occurredAt = at, reason = reason.audit,
            ),
        )
        DisassembleResult.Retired
    }

    /** Records the request. The printing itself is the caller's business. */
    suspend fun reprint(
        shiftId: String,
        boxId: String,
        reason: ReprintReason,
        operatorId: String?,
        terminalId: String?,
    ) {
        queue(
            ExceptionFact.Reprint(
                boxId = boxId, shiftId = shiftId, terminalId = terminalId,
                operatorId = operatorId, occurredAt = Iso.format(clock()), reason = reason.audit,
            ),
        )
    }

    /**
     * The watermark is read here, inside the same transaction as the local
     * effect, so it names exactly the scans that preceded this correction.
     */
    private suspend fun queue(fact: ExceptionFact) {
        val undo = fact as? ExceptionFact.Undo
        db.boxExceptionDao().insert(
            BoxExceptionEntity(
                kind = fact.kind,
                boxId = fact.boxId,
                codeHash = undo?.codeHash,
                targetScannedAt = undo?.targetScannedAt,
                shiftId = fact.shiftId,
                operatorId = fact.operatorId,
                reason = when (fact) {
                    is ExceptionFact.Disassemble -> fact.reason
                    is ExceptionFact.Reprint -> fact.reason
                    is ExceptionFact.Undo, is ExceptionFact.Clear -> null
                },
                occurredAt = fact.occurredAt,
                payloadJson = fact.toWireJson().toString(),
                afterOutboxId = db.outboxDao().maxId(),
                ackedAt = null,
            ),
        )
    }
}
```

- [ ] **Step 4: Add the DAO queries the engine needs**

In `core/storage/ShiftDaos.kt`, add to `CodeDao`:

```kotlin
    /** The undo target: the most recent accepted code of this box. */
    @Query("SELECT * FROM codes_mirror WHERE boxId = :boxId ORDER BY scannedAt DESC, codeHash DESC LIMIT 1")
    suspend fun lastIn(boxId: String): CodeEntity?

    @Query("DELETE FROM codes_mirror WHERE codeHash = :codeHash")
    suspend fun delete(codeHash: String)

    @Query("DELETE FROM codes_mirror WHERE boxId = :boxId")
    suspend fun deleteInBox(boxId: String): Int
```

If `CodeDao` already declares any of these, keep the existing one rather than
adding a second.

- [ ] **Step 5: Run the test**

```bash
./gradlew :app:testDebugUnitTest --tests '*ExceptionEngineTest'
```

Expected: BUILD SUCCESSFUL.

- [ ] **Step 6: Provide the engine to Hilt**

Create `core/exceptions/ExceptionModule.kt`, following the shape of
`core/sync/SyncModule.kt`:

```kotlin
package app.markiro.handheld.core.exceptions

import app.markiro.handheld.core.storage.HandheldDatabase
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object ExceptionModule {
    @Provides
    @Singleton
    fun exceptionEngine(db: HandheldDatabase): ExceptionEngine = ExceptionEngine(db)
}
```

- [ ] **Step 7: Commit**

```bash
git add apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/exceptions apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/storage/ShiftDaos.kt apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/exceptions
git commit -m "feat(handheld): движок исключений — местный эффект и факт одной транзакцией"
```

---

### Task 4: The fifth batch channel

**Files:**

- Modify: `core/network/SyncDtos.kt`, `core/storage/MetaStore.kt`,
  `core/sync/SyncEngine.kt`
- Test: `apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/sync/SyncExceptionsTest.kt`

**Interfaces:**

- Consumes: `BoxExceptionDao.sendable/markAcked/observeUnackedCount` (Task 2).
- Produces: `SyncBatchRequest.exceptions: List<JsonElement>`;
  `MetaStore.SYNC_PENDING_EXCEPTION_COUNT`; `SyncEngine.MAX_EXCEPTIONS = 200`.

- [ ] **Step 1: Write the failing test**

`core/sync/SyncEngineTest.kt` already has the harness: a `MockWebServer`, an
in-memory `HandheldDatabase` with a `dev-1` config row, an `engine()` factory
over `NetworkModule.strictJson()`, an `outbox(raw)` helper and an `ok(applied)`
response builder. Copy those into the new file rather than inventing another.

Create `SyncExceptionsTest.kt`:

```kotlin
package app.markiro.handheld.core.sync

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.network.NetworkModule
import app.markiro.handheld.core.network.RevocationBus
import app.markiro.handheld.core.network.RevocationInterceptor
import app.markiro.handheld.core.storage.BoxEntity
import app.markiro.handheld.core.storage.BoxExceptionEntity
import app.markiro.handheld.core.storage.DeviceConfigEntity
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.MetaStore
import app.markiro.handheld.core.storage.OutboxEntity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The channel exists so a correction reaches the server. These tests are about
 * the two ways it can fail silently: leaving before the scan it corrects, and
 * being acknowledged when the server never took it.
 */
@RunWith(AndroidJUnit4::class)
class SyncExceptionsTest {
    private lateinit var db: HandheldDatabase
    private lateinit var server: MockWebServer
    private val bus = RevocationBus()
    private val strict = NetworkModule.strictJson()
    private val clock = 1_757_500_000_000L
    private val engineScope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)

    @Before
    fun setUp() = runTest {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries().build()
        server = MockWebServer().also { it.start() }
        db.deviceConfigDao().upsert(
            DeviceConfigEntity(
                deviceId = "dev-1", deviceName = "ТСД 1", tenantId = "t-1", organizationName = "ООО",
                lineId = "l1", lineName = "Линия 2", kind = "handheld",
                serverUrl = server.url("/").toString(), pairedAt = 1L,
            ),
        )
    }

    @After
    fun tearDown() {
        engineScope.cancel()
        server.shutdown()
        db.close()
    }

    private fun engine(): SyncEngine {
        val client = OkHttpClient.Builder()
            .addInterceptor(RevocationInterceptor(bus, Json { ignoreUnknownKeys = true })).build()
        return SyncEngine(
            db = db, meta = MetaStore(db.metaDao()), config = db.deviceConfigDao(),
            transport = SyncTransport(client) { server.url("/").toString() },
            json = strict, scope = engineScope, clock = { clock },
        )
    }

    private suspend fun outbox(raw: String) = db.outboxDao().insert(
        OutboxEntity(
            shiftId = "s1", raw = raw, verdict = "ok", scannedAt = "2026-09-10T10:00:00.000Z",
            operatorId = "op-1", codeHash = raw.padEnd(64, '0'), gtin14 = "04600682000013",
            serial = raw, boxId = "box-1",
        ),
    )

    private suspend fun queue(kind: String, boxId: String = "box-1", afterOutboxId: Long = 0) =
        db.boxExceptionDao().insert(
            BoxExceptionEntity(
                kind = kind, boxId = boxId,
                codeHash = if (kind == "undo") "a".repeat(64) else null,
                targetScannedAt = if (kind == "undo") "2026-09-10T09:59:00.000Z" else null,
                shiftId = "s1", operatorId = "op-1",
                reason = if (kind == "disassemble" || kind == "reprint") "Неверный товар" else null,
                occurredAt = "2026-09-10T10:00:00.000Z",
                payloadJson = """{"kind":"$kind","boxId":"$boxId","codeHash":null,"targetScannedAt":null,""" +
                    """"shiftId":"s1","terminalId":"dev-1","operatorId":"op-1","reason":null,""" +
                    """"occurredAt":"2026-09-10T10:00:00.000Z"}""",
                afterOutboxId = afterOutboxId, ackedAt = null,
            ),
        )

    private fun ok(applied: Int) = MockResponse().setResponseCode(201)
        .setBody("""{"applied":$applied,"alreadyApplied":false,"conflicts":[]}""")

    private fun bodyOf(): kotlinx.serialization.json.JsonObject =
        Json.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonObject

    @Test
    fun aBatchCarriesTheExceptionsWhoseTargetsItAlsoCarries() = runTest {
        outbox("a")
        queue("undo", afterOutboxId = db.outboxDao().maxId())
        server.enqueue(ok(1))
        assertTrue(engine().drainAll())
        val body = bodyOf()
        assertEquals(1, body.getValue("items").jsonArray.size)
        val exceptions = body.getValue("exceptions").jsonArray
        assertEquals(1, exceptions.size)
        assertEquals("undo", exceptions[0].jsonObject.getValue("kind").jsonPrimitive.content)
        assertEquals(0, db.boxExceptionDao().unackedCount())
    }

    /**
     * The whole point of the watermark. A device that packed offline has more
     * scans queued than one batch carries; the correction must wait for its own.
     */
    @Test
    fun anExceptionDoesNotLeaveBeforeItsScan() = runTest {
        repeat(SyncEngine.BATCH_SIZE + 1) { outbox("s$it") }
        queue("undo", afterOutboxId = db.outboxDao().maxId())
        server.enqueue(ok(SyncEngine.BATCH_SIZE))
        server.enqueue(ok(1))
        assertTrue(engine().drainAll())
        assertEquals(0, bodyOf().getValue("exceptions").jsonArray.size)
        assertEquals(1, bodyOf().getValue("exceptions").jsonArray.size)
    }

    @Test
    fun aPinnedBatchDoesNotGrowNewExceptions() = runTest {
        outbox("a")
        queue("clear", afterOutboxId = db.outboxDao().maxId())
        server.enqueue(MockResponse().setResponseCode(500))
        val e = engine()
        assertFalse(e.drainAll())
        queue("clear", boxId = "box-2", afterOutboxId = 0)
        server.enqueue(ok(1))
        server.enqueue(ok(0))
        assertTrue(e.drainAll())
        bodyOf()
        val retried = bodyOf().getValue("exceptions").jsonArray
        assertEquals(1, retried.size)
        assertEquals("box-1", retried[0].jsonObject.getValue("boxId").jsonPrimitive.content)
        assertEquals("box-2", bodyOf().getValue("exceptions").jsonArray[0].jsonObject.getValue("boxId").jsonPrimitive.content)
    }

    @Test
    fun exceptionsAreAcknowledgedOnlyAfterTheServerTakesTheBatch() = runTest {
        outbox("a")
        queue("clear", afterOutboxId = db.outboxDao().maxId())
        server.enqueue(MockResponse().setResponseCode(500))
        val e = engine()
        assertFalse(e.drainAll())
        assertEquals(1, db.boxExceptionDao().unackedCount())
        server.enqueue(ok(1))
        assertTrue(e.drainAll())
        assertEquals(0, db.boxExceptionDao().unackedCount())
    }

    /** A closed-box fact waits for the closure the server has to have seen first. */
    @Test
    fun aDisassembleWaitsForItsClosure() = runTest {
        db.boxDao().insert(
            BoxEntity(
                boxId = "box-9", shiftId = "s1", sscc = "000000000000000017",
                openedAt = "2026-09-10T09:00:00.000Z", closedAt = "2026-09-10T09:30:00.000Z",
                operatorId = "op-1", printState = "printed", printReason = null, ackedAt = null,
            ),
        )
        queue("disassemble", boxId = "box-9")
        server.enqueue(ok(0))
        // `drainOnce`, not `drainAll`: the loop's next pass would pick the fact
        // up as soon as the first batch acknowledged the closure, which is
        // correct behaviour and would hide what this test is about.
        assertEquals(SyncEngine.Step.SENT, engine().drainOnce())
        val body = bodyOf()
        assertEquals(1, body.getValue("boxes").jsonArray.size)
        // The closure rides this batch; the fact about it rides the next.
        assertEquals(0, body.getValue("exceptions").jsonArray.size)
        assertEquals(1, db.boxExceptionDao().unackedCount())
    }

    @Test
    fun theQueueDepthCountsExceptions() = runTest {
        queue("clear")
        assertEquals(1, engine().state.first { it.pending > 0 }.pending)
    }
}
```

**Two existing assertions will fail once the batch id grows a fifth signature.**
`SyncEngineTest` asserts literal batch ids such as `"dev-1:$installId:3:0:0"`.
Those become `"dev-1:$installId:3:0:0:0"`. Update every such assertion in
`SyncEngineTest.kt` and `DuplicateSyncTest.kt` — do not weaken them to a prefix
match, because the whole point of the id is that a different set never signs the
same.

- [ ] **Step 2: Run it to confirm it fails**

```bash
./gradlew :app:testDebugUnitTest --tests '*SyncExceptionsTest'
```

Expected: failures — the request body has no `exceptions` array.

- [ ] **Step 3: Add the wire field**

In `core/network/SyncDtos.kt`, add the fifth field of `SyncBatchRequest`:

```kotlin
    /**
     * Operator corrections, sent as stored JSON for the same reason the label
     * events are: the server's schema requires every nullable key to be
     * present, and this device's Retrofit converter drops null-valued fields.
     */
    val exceptions: List<JsonElement> = emptyList(),
```

- [ ] **Step 4: Add the meta key**

In `core/storage/MetaStore.kt`, beside `SYNC_PENDING_LABEL_COUNT`:

```kotlin
        const val SYNC_PENDING_EXCEPTION_COUNT = "sync_pending_exception_count"
```

- [ ] **Step 5: Wire the channel into the drain**

In `core/sync/SyncEngine.kt`:

Add to the `pending` flow so the queue indicator counts corrections:

```kotlin
    private val pending: Flow<Int> = combine(
        db.outboxDao().count(),
        db.boxDao().observeUnackedCount(),
        db.productLabelEventDao().observeUnackedCount(),
        db.boxExceptionDao().observeUnackedCount(),
    ) { counts -> counts.sum() }
```

The four-argument `combine` with a vararg lambda over one `Flow<Int>` type is
safe here because every flow is `Flow<Int>`.

In `drainOnce()`, after the `labelRows` block and before the emptiness check:

```kotlin
        // Corrections follow the same pinning rule as boxes and label events.
        val exceptionLimit = if (pendingCeiling != null) {
            meta.get(MetaStore.SYNC_PENDING_EXCEPTION_COUNT)?.toIntOrNull() ?: 0
        } else {
            MAX_EXCEPTIONS
        }
        // An exception may only ride a batch that also carries -- or has already
        // delivered -- the scans it corrects. `maxId` is this batch's outbox
        // ceiling; an empty outbox means everything before it is acknowledged.
        val exceptionThrough = if (rows.isEmpty()) Long.MAX_VALUE else rows.last().id
        val exceptionRows = if (exceptionLimit == 0) {
            emptyList()
        } else {
            db.boxExceptionDao().sendable(exceptionThrough, exceptionLimit)
        }
```

Change the emptiness check to include them:

```kotlin
        if (rows.isEmpty() && boxRows.isEmpty() && labelRows.isEmpty() && exceptionRows.isEmpty()) {
```

Fold the exception set into the batch id, beside the box and label signatures:

```kotlin
            val id = "${cfg.deviceId}:${meta.installId()}:$maxId:${idSignature(boxIds)}:" +
                "${idSignature(labelRows.map { it.eventId })}:${idSignature(exceptionRows.map { it.id.toString() })}"
            meta.put(MetaStore.SYNC_PENDING_CEILING, maxId.toString())
            meta.put(MetaStore.SYNC_PENDING_BOX_COUNT, boxIds.size.toString())
            meta.put(MetaStore.SYNC_PENDING_LABEL_COUNT, labelRows.size.toString())
            meta.put(MetaStore.SYNC_PENDING_EXCEPTION_COUNT, exceptionRows.size.toString())
            meta.put(MetaStore.SYNC_PENDING_BATCH_ID, id)
```

Add the payload to the request:

```kotlin
            SyncBatchRequest(
                batchId,
                rows.map { it.toItem(cfg.deviceId) },
                boxRows.map { it.toClosure(cfg.deviceId) },
                labelRows.map { json.parseToJsonElement(it.payloadJson) },
                exceptionRows.map { json.parseToJsonElement(it.payloadJson) },
            ),
```

Acknowledge inside the success transaction, beside the box ack:

```kotlin
            // Unconditional, like the boxes above: this endpoint answers no
            // per-exception receipt, and the server records every fact it
            // accepts -- including one that matched nothing.
            if (exceptionRows.isNotEmpty()) {
                db.boxExceptionDao().markAcked(exceptionRows.map { it.id }, Iso.format(at))
                db.boxExceptionDao().purgeAcked()
            }
```

and clear the new meta key in both the success transaction and `clearPending()`:

```kotlin
            db.metaDao().remove(MetaStore.SYNC_PENDING_EXCEPTION_COUNT)
```

```kotlin
        meta.remove(MetaStore.SYNC_PENDING_EXCEPTION_COUNT)
```

Add the constant to the companion object:

```kotlin
        /** The server's own cap on `exceptions[]`. */
        const val MAX_EXCEPTIONS = 200
```

- [ ] **Step 6: Run the sync suite**

```bash
./gradlew :app:testDebugUnitTest --tests '*core.sync*'
```

Expected: BUILD SUCCESSFUL, including the pre-existing sync tests.

- [ ] **Step 7: Commit**

```bash
git add apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/sync apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/network/SyncDtos.kt apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/storage/MetaStore.kt apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/sync
git commit -m "feat(handheld): пятый канал пачки — исключения с гарантией порядка"
```

---

### Task 5: The list and the two named-target confirmations

**Files:**

- Create: `feature/exceptions/ExceptionsViewModel.kt`, `feature/exceptions/ExceptionsScreens.kt`
- Modify: `AppNavigation.kt`, `feature/work/WorkScreen.kt`,
  `res/values/strings.xml`, `res/values-en/strings.xml`
- Test: `apps/handheld/app/src/test/kotlin/app/markiro/handheld/feature/exceptions/ExceptionsViewModelTest.kt`,
  `.../ExceptionsScreenTest.kt`

**Interfaces:**

- Consumes: `ExceptionEngine`, `UndoResult` (Task 3).
- Produces: `Routes.EXCEPTIONS = "exceptions/{shiftId}"` and
  `Routes.exceptions(id: String)`; `data class ExceptionsUi(val canUndo: Boolean,
val undoTarget: UndoTarget?, val openBoxId: String?, val openBoxOrdinal: Int,
val openBoxCount: Int, val reprintableCount: Int, val step: ExceptionsStep)`
  — `openBoxOrdinal` comes from `BoxDao.ordinal(shiftId, openedAt, boxId)`, the
  display number the operator reads on the work screen;
  `data class UndoTarget(val codeTail: String, val scannedAt: String, val codeHash: String)`;
  `sealed interface ExceptionsStep { data object List; data object ConfirmUndo;
data object ConfirmClear; data class Done(val message: Int); data class Refused(val message: Int) }`.

- [ ] **Step 1: Add the strings**

In `res/values/strings.xml`:

```xml
    <string name="work_exceptions">Исключения</string>
    <string name="exceptions_title">Исключения</string>
    <string name="exceptions_disassemble">Расформировать короб</string>
    <string name="exceptions_clear">Очистить короб</string>
    <string name="exceptions_reprint">Перепечатать этикетку</string>
    <string name="exceptions_undo">Отменить последний скан</string>
    <string name="exceptions_last_scan">Последний скан: %1$s в %2$s</string>
    <string name="exceptions_no_last_scan">Отменять нечего: в коробе нет сканов</string>
    <string name="exceptions_no_open_box">Короб не открыт</string>
    <string name="exceptions_no_closed_boxes">В этой смене нет закрытых коробов</string>
    <string name="exceptions_validation_only">Отмена доступна только в агрегации</string>
    <string name="exceptions_confirm_undo_title">Отменить последний скан?</string>
    <string name="exceptions_confirm_undo_body">Единица %1$s, принята в %2$s. Она выйдет из короба, а код снова можно будет сканировать.</string>
    <string name="exceptions_confirm_clear_title">Очистить короб?</string>
    <string name="exceptions_confirm_clear_body">Короб %1$d · %2$d единиц. Все единицы выйдут из короба, короб останется открытым.</string>
    <string name="exceptions_undone">Скан отменён</string>
    <string name="exceptions_cleared">Короб очищен</string>
    <string name="exceptions_undo_stale">Появился новый скан — отмена относится уже к нему. Откройте экран заново.</string>
    <string name="exceptions_confirm">Подтвердить</string>
```

In `res/values-en/strings.xml`, the same keys:

```xml
    <string name="work_exceptions">Exceptions</string>
    <string name="exceptions_title">Exceptions</string>
    <string name="exceptions_disassemble">Disassemble box</string>
    <string name="exceptions_clear">Clear box</string>
    <string name="exceptions_reprint">Reprint label</string>
    <string name="exceptions_undo">Undo last scan</string>
    <string name="exceptions_last_scan">Last scan: %1$s at %2$s</string>
    <string name="exceptions_no_last_scan">Nothing to undo: the box has no scans</string>
    <string name="exceptions_no_open_box">No box is open</string>
    <string name="exceptions_no_closed_boxes">This shift has no closed boxes</string>
    <string name="exceptions_validation_only">Undo is available in aggregation only</string>
    <string name="exceptions_confirm_undo_title">Undo the last scan?</string>
    <string name="exceptions_confirm_undo_body">Unit %1$s, accepted at %2$s. It leaves the box and its code becomes scannable again.</string>
    <string name="exceptions_confirm_clear_title">Clear the box?</string>
    <string name="exceptions_confirm_clear_body">Box %1$d · %2$d units. Every unit leaves the box; the box stays open.</string>
    <string name="exceptions_undone">Scan undone</string>
    <string name="exceptions_cleared">Box cleared</string>
    <string name="exceptions_undo_stale">A new scan arrived, so undo now targets that one. Reopen the screen.</string>
    <string name="exceptions_confirm">Confirm</string>
</string>
```

(Remove the stray closing tag above; append the entries inside the existing
`<resources>` element of each file.)

- [ ] **Step 2: Write the failing view-model test**

Create `ExceptionsViewModelTest.kt`, following the harness idiom of
`feature/inventory/InventoryListViewModelTest.kt`:

```kotlin
package app.markiro.handheld.feature.exceptions

import androidx.lifecycle.SavedStateHandle
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.MainDispatcherRule
import app.markiro.handheld.R
import app.markiro.handheld.core.auth.OperatorRecord
import app.markiro.handheld.core.exceptions.ExceptionEngine
import app.markiro.handheld.core.storage.BoxEntity
import app.markiro.handheld.core.storage.CodeEntity
import app.markiro.handheld.core.storage.DeviceConfigEntity
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.feature.signin.SessionHolder
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ExceptionsViewModelTest {
    @get:Rule
    val main = MainDispatcherRule()

    private lateinit var db: HandheldDatabase
    private val session = SessionHolder().apply {
        signIn(OperatorRecord("op-1", "Иванова Анна", "4127", "operator", "x", null, true))
    }
    private val a = "a".repeat(64)
    private val b = "b".repeat(64)

    @Before
    fun setUp() = runTest {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries().build()
        db.deviceConfigDao().upsert(
            DeviceConfigEntity(
                deviceId = "dev-1", deviceName = "ТСД 1", tenantId = "t", organizationName = "ООО",
                lineId = "l1", lineName = "Линия 2", kind = "handheld", serverUrl = "http://x", pairedAt = 1L,
            ),
        )
    }

    @After
    fun tearDown() = db.close()

    private suspend fun openBox() = db.boxDao().insert(
        BoxEntity(
            boxId = "box-1", shiftId = "s1", sscc = null, openedAt = "2026-09-11T07:00:00.000Z",
            closedAt = null, operatorId = "op-1", printState = "pending", printReason = null, ackedAt = null,
        ),
    )

    private suspend fun scan(hash: String, at: String) =
        db.codeDao().insert(CodeEntity(hash, "s1", "04600000000015", hash.take(6), at, "box-1"))

    private fun vm() = main.track(
        ExceptionsViewModel(db, ExceptionEngine(db), session, SavedStateHandle(mapOf("shiftId" to "s1"))),
    )

    /** The list names the undo target, because that is what the operator confirms against. */
    @Test
    fun theListNamesTheLastScan() = runTest {
        openBox()
        scan(a, "2026-09-11T07:59:00.000Z")
        val ui = vm().state.first { it.undoTarget != null }
        assertEquals(a.takeLast(6).uppercase(), ui.undoTarget!!.codeTail)
        assertTrue(ui.canUndo)
    }

    /** Validation mode has no box, so there is nothing to undo or clear. */
    @Test
    fun withNoOpenBoxNothingIsUndoableOrClearable() = runTest {
        val ui = vm().state.first { it.openBoxId == null }
        assertFalse(ui.canUndo)
        assertEquals(0, ui.openBoxCount)
        assertNull(ui.undoTarget)
    }

    /** An open box with no scans yet: the row is there, the action is not. */
    @Test
    fun anEmptyBoxHasNothingToUndo() = runTest {
        openBox()
        val ui = vm().state.first { it.openBoxId != null }
        assertFalse(ui.canUndo)
        assertNull(ui.undoTarget)
    }

    @Test
    fun confirmingUndoReleasesTheCodeAndReportsIt() = runTest {
        openBox()
        scan(a, "2026-09-11T07:59:00.000Z")
        val vm = vm()
        vm.state.first { it.undoTarget != null }
        vm.startUndo()
        vm.state.first { it.step is ExceptionsStep.ConfirmUndo }
        vm.confirm()
        assertEquals(
            R.string.exceptions_undone,
            (vm.state.first { it.step is ExceptionsStep.Done }.step as ExceptionsStep.Done).message,
        )
        assertNull(db.codeDao().get(a))
        assertEquals(1, db.boxExceptionDao().unackedCount())
    }

    /** A scan landing while the confirmation is open must not silently retarget it. */
    @Test
    fun aScanDuringTheConfirmationRefusesTheUndo() = runTest {
        openBox()
        scan(a, "2026-09-11T07:59:00.000Z")
        val vm = vm()
        vm.state.first { it.undoTarget != null }
        vm.startUndo()
        vm.state.first { it.step is ExceptionsStep.ConfirmUndo }
        scan(b, "2026-09-11T07:59:30.000Z")
        vm.confirm()
        assertEquals(
            R.string.exceptions_undo_stale,
            (vm.state.first { it.step is ExceptionsStep.Refused }.step as ExceptionsStep.Refused).message,
        )
        assertNotNull(db.codeDao().get(a))
        assertNotNull(db.codeDao().get(b))
        assertEquals(0, db.boxExceptionDao().unackedCount())
    }

    @Test
    fun confirmingClearEmptiesTheBox() = runTest {
        openBox()
        scan(a, "2026-09-11T07:59:00.000Z")
        scan(b, "2026-09-11T07:59:30.000Z")
        val vm = vm()
        vm.state.first { it.openBoxCount == 2 }
        vm.startClear()
        vm.state.first { it.step is ExceptionsStep.ConfirmClear }
        vm.confirm()
        assertEquals(
            R.string.exceptions_cleared,
            (vm.state.first { it.step is ExceptionsStep.Done }.step as ExceptionsStep.Done).message,
        )
        assertEquals(0, db.boxDao().itemCount("box-1"))
        assertEquals(1, db.boxExceptionDao().unackedCount())
    }

    /** Backing out of a confirmation applies nothing. */
    @Test
    fun dismissingAConfirmationChangesNothing() = runTest {
        openBox()
        scan(a, "2026-09-11T07:59:00.000Z")
        val vm = vm()
        vm.state.first { it.undoTarget != null }
        vm.startUndo()
        vm.state.first { it.step is ExceptionsStep.ConfirmUndo }
        vm.dismiss()
        vm.state.first { it.step is ExceptionsStep.List }
        assertNotNull(db.codeDao().get(a))
        assertEquals(0, db.boxExceptionDao().unackedCount())
    }

    /** The reprint row needs something to reprint. */
    @Test
    fun withNoClosedBoxesTheReprintCountIsZero() = runTest {
        openBox()
        assertEquals(0, vm().state.first { it.openBoxId != null }.reprintableCount)
    }
}
```

- [ ] **Step 3: Run it to confirm it fails**

```bash
./gradlew :app:testDebugUnitTest --tests '*ExceptionsViewModelTest'
```

Expected: `Unresolved reference: ExceptionsViewModel`.

- [ ] **Step 4: Write the view model**

Create `feature/exceptions/ExceptionsViewModel.kt`. It is a `@HiltViewModel`
taking `HandheldDatabase`, `ExceptionEngine`, `SessionHolder` and
`SavedStateHandle` (for `shiftId`). It:

- observes the open box (`db.boxDao().observeOpen(shiftId)`) and its item count
  (`db.boxDao().observeItemCount(boxId)`);
- reads the undo target with `engine.lastScanIn(boxId)` whenever the item count
  changes, exposing `UndoTarget(codeTail = codeHash.takeLast(6).uppercase(),
scannedAt = <HH:mm:ss of Iso.parse>, codeHash = codeHash)`;
- reads the device line and id from `DeviceConfigDao` **inside the coroutine
  that needs it** rather than caching it in a field — see
  `InventoryListViewModel.ownLineId()` for why a field filled by an observer is
  a race;
- exposes `startUndo()`, `startClear()`, `confirm()`, `dismiss()`;
- on `confirm()` in `ConfirmUndo`, calls
  `engine.undoLastScan(shiftId, boxId, target.codeHash, operatorId, deviceId)`
  and maps `UndoResult.Undone` to `Done(R.string.exceptions_undone)`,
  `Stale` to `Refused(R.string.exceptions_undo_stale)`, `Empty` to
  `Refused(R.string.exceptions_no_last_scan)`;
- on `confirm()` in `ConfirmClear`, calls `engine.clearBox(...)` and maps a
  positive count to `Done(R.string.exceptions_cleared)` and zero to
  `Refused(R.string.exceptions_no_last_scan)`.

Do **not** inject `SyncEngine` to nudge the drain. The heartbeat is 15 s
(`SyncEngine.HEARTBEAT_MS`) and a correction is never the last thing that
happens on a shift; injecting the engine here would drag a whole sync harness
into every view-model test for no guarantee the heartbeat does not already give.

- [ ] **Step 5: Run the test**

```bash
./gradlew :app:testDebugUnitTest --tests '*ExceptionsViewModelTest'
```

Expected: BUILD SUCCESSFUL.

- [ ] **Step 6: Write the screens**

Create `feature/exceptions/ExceptionsScreens.kt` with:

```kotlin
data class ExceptionsCallbacks(
    val onBack: () -> Unit = {},
    val onDisassemble: () -> Unit = {},
    val onClear: () -> Unit = {},
    val onReprint: () -> Unit = {},
    val onUndo: () -> Unit = {},
    val onConfirm: () -> Unit = {},
    val onDismiss: () -> Unit = {},
)

@Composable
fun ExceptionsScreen(state: ExceptionsUi, cb: ExceptionsCallbacks)
```

Follow the row idiom of `feature/work/LabelQueueScreen.kt` for the four 64 dp
rows and `feature/work/DuplicateScreens.kt` for the full-screen confirmation
states. Requirements that the tests below pin:

- Four rows in this order: disassemble, clear, reprint, undo.
- A row whose action is unavailable is **disabled and carries its reason in
  words** underneath — never greyed out silently. Use
  `exceptions_no_open_box`, `exceptions_no_closed_boxes`,
  `exceptions_no_last_scan`, `exceptions_validation_only`.
- Below the rows, the undo target line from `exceptions_last_scan` when there is
  one.
- `ConfirmUndo` and `ConfirmClear` render full screen with the title and body
  strings above, a «Подтвердить» button and «Отмена».
- `Done` and `Refused` render the message and a single dismissing action.

- [ ] **Step 7: Write the failing screen test**

Create `ExceptionsScreenTest.kt` in the idiom of
`feature/inventory/InventoryListScreenTest.kt` — `createComposeRule()`,
`MarkiroTheme` from `app.markiro.handheld.core.design`, one `setContent` per test:

```kotlin
package app.markiro.handheld.feature.exceptions

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.design.MarkiroTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ExceptionsScreenTest {
    @get:Rule
    val compose = createComposeRule()

    private val target = UndoTarget(codeTail = "7XQ4K2", scannedAt = "10:42:17", codeHash = "a".repeat(64))

    private fun ui(
        canUndo: Boolean = false,
        undoTarget: UndoTarget? = null,
        openBoxId: String? = null,
        openBoxOrdinal: Int = 27,
        openBoxCount: Int = 0,
        reprintableCount: Int = 0,
        step: ExceptionsStep = ExceptionsStep.List,
    ) = ExceptionsUi(canUndo, undoTarget, openBoxId, openBoxOrdinal, openBoxCount, reprintableCount, step)

    private fun render(state: ExceptionsUi, cb: ExceptionsCallbacks = ExceptionsCallbacks()) {
        compose.setContent { MarkiroTheme { ExceptionsScreen(state, cb) } }
    }

    /** A greyed-out row with no explanation is the failure mode this pins. */
    @Test
    fun anUnavailableActionSaysWhyInsteadOfGoingQuiet() {
        render(ui())
        compose.onNodeWithText("Короб не открыт").assertIsDisplayed()
        compose.onNodeWithText("В этой смене нет закрытых коробов").assertIsDisplayed()
        compose.onNode(hasText("Очистить короб")).assertIsNotEnabled()
        compose.onNode(hasText("Расформировать короб")).assertIsNotEnabled()
    }

    @Test
    fun anOpenBoxWithoutScansExplainsWhyUndoIsOff() {
        render(ui(openBoxId = "box-1", openBoxCount = 0))
        compose.onNodeWithText("Отменять нечего: в коробе нет сканов").assertIsDisplayed()
        compose.onNode(hasText("Отменить последний скан")).assertIsNotEnabled()
    }

    @Test
    fun theListNamesTheUndoTargetAndOffersTheFourActions() {
        var undo = false
        render(
            ui(canUndo = true, undoTarget = target, openBoxId = "box-1", openBoxCount = 12, reprintableCount = 3),
            ExceptionsCallbacks(onUndo = { undo = true }),
        )
        compose.onNodeWithText("Последний скан: 7XQ4K2 в 10:42:17").assertIsDisplayed()
        compose.onNodeWithText("Расформировать короб").assertIsDisplayed()
        compose.onNodeWithText("Очистить короб").assertIsDisplayed()
        compose.onNodeWithText("Перепечатать этикетку").assertIsDisplayed()
        compose.onNodeWithText("Отменить последний скан").performClick()
        assertEquals(true, undo)
    }

    @Test
    fun theUndoConfirmationNamesTheUnitAndItsTime() {
        render(ui(canUndo = true, undoTarget = target, openBoxId = "box-1", openBoxCount = 12, step = ExceptionsStep.ConfirmUndo))
        compose.onNodeWithText("Отменить последний скан?").assertIsDisplayed()
        compose.onNode(hasText("7XQ4K2", substring = true)).assertIsDisplayed()
        compose.onNode(hasText("10:42:17", substring = true)).assertIsDisplayed()
    }

    @Test
    fun theClearConfirmationNamesTheBoxAndItsCount() {
        render(ui(openBoxId = "box-1", openBoxCount = 12, step = ExceptionsStep.ConfirmClear))
        compose.onNodeWithText("Очистить короб?").assertIsDisplayed()
        compose.onNode(hasText("12", substring = true)).assertIsDisplayed()
    }

    @Test
    fun aRefusalIsShownInWords() {
        render(ui(step = ExceptionsStep.Refused(app.markiro.handheld.R.string.exceptions_undo_stale)))
        compose.onNode(hasText("Появился новый скан", substring = true)).assertIsDisplayed()
    }
}
```

The clear confirmation reads «Короб 27 · 12 единиц» from `openBoxOrdinal` and
`openBoxCount`. Assert on the unit count: that is the number the operator
actually checks before confirming.

- [ ] **Step 8: Wire the route and the menu row**

In `AppNavigation.kt`, add to `Routes`:

```kotlin
    const val EXCEPTIONS = "exceptions/{shiftId}"
    fun exceptions(id: String) = "exceptions/$id"
```

and a `composable(Routes.EXCEPTIONS)` block following the shape of
`Routes.LABEL_QUEUE`, passing `onBack = { nav.popBackStack() }` and navigating
to the disassemble and reprint routes added in Task 6.

In `feature/work/WorkScreen.kt`, add `val onExceptions: () -> Unit = {}` to
`WorkCallbacks` and a `DropdownMenuItem` above «Выйти из смены»:

```kotlin
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.work_exceptions)) },
                        onClick = {
                            menu = false
                            cb.onExceptions()
                        },
                    )
```

The drawn design shows this as a bottom sheet (`04-work/more-sheet`); the
shipped screen uses an overflow menu with the same rows. Add the row to what
exists — converting the menu into a sheet is a separate cosmetic change and not
part of this slice.

In the `composable(Routes.WORK)` block, pass
`onExceptions = { nav.navigate(Routes.exceptions(shiftId)) }`.

- [ ] **Step 9: Run the feature suite**

```bash
./gradlew :app:testDebugUnitTest --tests '*feature.exceptions*' --tests '*feature.work*'
```

Expected: BUILD SUCCESSFUL.

- [ ] **Step 10: Commit**

```bash
git add apps/handheld/app/src/main/kotlin/app/markiro/handheld/feature/exceptions apps/handheld/app/src/main/kotlin/app/markiro/handheld/AppNavigation.kt apps/handheld/app/src/main/kotlin/app/markiro/handheld/feature/work/WorkScreen.kt apps/handheld/app/src/main/res apps/handheld/app/src/test/kotlin/app/markiro/handheld/feature/exceptions
git commit -m "feat(handheld): экран исключений, отмена скана и очистка короба"
```

---

### Task 6: The disassemble stepper and reprint

**Files:**

- Create: `feature/exceptions/DisassembleViewModel.kt`,
  `feature/exceptions/DisassembleScreens.kt`,
  `feature/exceptions/ReprintViewModel.kt`, `feature/exceptions/ReprintScreens.kt`
- Modify: `core/box/Sscc.kt` (a parser — the app can only build SSCCs today),
  `AppNavigation.kt`, `res/values/strings.xml`, `res/values-en/strings.xml`
- Test: `core/box/SsccTest.kt` (extend), `.../DisassembleViewModelTest.kt`,
  `.../ReprintViewModelTest.kt`

**Interfaces:**

- Consumes: `ExceptionEngine.disassemble/reprint`, `DisassembleReason`,
  `ReprintReason`, `DisassembleResult` (Tasks 1 and 3);
  `BoxDao.reprintable/boxIdBySscc/markDisassembled` (Task 2);
  `BoxPrinter.print(boxId)`.
- Produces, besides the routes below: `Sscc.parse(raw: String): String?`.
- Produces: `Routes.DISASSEMBLE = "exceptions/{shiftId}/disassemble"`,
  `Routes.REPRINT = "exceptions/{shiftId}/reprint"` with their builders;
  `sealed interface DisassembleStep { data object ScanBox; data class Reason(val boxId: String, val ordinal: Int, val units: Int, val sscc: String); data class Confirm(val boxId: String, val ordinal: Int, val units: Int, val sscc: String); data object Retired; data class Refused(val message: Int) }`;
  `data class ReprintUi(val last: ReprintTarget?, val selected: ReprintTarget?, val done: Boolean, val error: Int?)`
  and `data class ReprintTarget(val boxId: String, val ordinal: Int, val sscc: String)`,
  with `chooseLast()`, `chooseBox(boxId: String)`, `chooseReason(ReprintReason)`.

- [ ] **Step 1: Add the strings**

In `res/values/strings.xml` (and the English counterparts in `values-en`):

```xml
    <string name="disassemble_step">ШАГ %1$d ИЗ 3</string>
    <string name="disassemble_scan_title">Отсканируйте этикетку короба</string>
    <string name="disassemble_scan_body">Нажмите триггер и наведите на SSCC-этикетку короба, который нужно расформировать.</string>
    <string name="disassemble_reason_title">Почему расформировываем?</string>
    <string name="disassemble_confirm_title">Расформировать короб %1$d?</string>
    <string name="disassemble_confirm_body">%1$d единиц выйдут из короба, номер %2$s выводится из оборота навсегда и больше не будет присвоен.</string>
    <string name="disassemble_done">Короб расформирован</string>
    <string name="disassemble_not_closed">Этот короб ещё открыт — его можно очистить, а не расформировать</string>
    <string name="disassemble_already">Короб уже расформирован</string>
    <string name="disassemble_unknown_sscc">Этот SSCC не принадлежит коробу этой смены</string>
    <string name="reason_wrong_product">Неверный товар</string>
    <string name="reason_wrong_quantity">Неверное количество</string>
    <string name="reason_damaged_package">Упаковка повреждена</string>
    <string name="reason_quality_rejected">Отклонено контролем качества</string>
    <string name="reason_damaged_label">Этикетка повреждена</string>
    <string name="reason_unreadable_label">Этикетка не читается</string>
    <string name="reason_printer_jam">Замятие принтера / нет печати</string>
    <string name="reason_quality_request">Запрос контроля качества</string>
    <string name="reprint_title">Перепечатать этикетку</string>
    <string name="reprint_last">Последняя · короб %1$d</string>
    <string name="reprint_scan">Сканировать SSCC короба</string>
    <string name="reprint_audit_note">Перепечатка записывается в аудит с именем оператора и причиной.</string>
    <string name="reprint_reason_title">Почему печатаем заново?</string>
```

The reason labels above are the localized UI text. The value sent to the server
stays `DisassembleReason.audit` / `ReprintReason.audit` from Task 1 — do not
substitute the localized string.

- [ ] **Step 2: Teach the app to read a scanned SSCC label**

Nothing in the handheld reads an SSCC off a label today — `core/box/Sscc.kt`
only builds them. Both flows in this task need it. Add to `object Sscc`:

```kotlin
    /**
     * The 18 digits of a scanned SSCC label, or null.
     *
     * A box label carries GS1 element string `(00)` + 18 digits. Some scanners
     * keep the parentheses, some emit the bare AI, and a keyboard wedge can add
     * whitespace. A bare 18-digit string is taken as-is rather than having a
     * leading `00` stripped: an SSCC legitimately starts with its extension
     * digit, so stripping would corrupt every box number beginning `00`.
     *
     * Deliberately no check-digit validation: the only consumer looks the value
     * up among boxes this device closed, and a mis-decoded scan finds nothing
     * and is reported as an unknown label either way.
     */
    fun parse(raw: String): String? {
        val trimmed = raw.trim()
        val body = when {
            trimmed.startsWith("(00)") -> trimmed.removePrefix("(00)")
            trimmed.length == 20 && trimmed.startsWith("00") -> trimmed.drop(2)
            else -> trimmed
        }
        return body.takeIf { it.length == 18 && it.all(Char::isDigit) }
    }
```

Add to the existing `core/box/SsccTest.kt` (or create it if absent):

```kotlin
    @Test
    fun aScannedLabelIsReadInEveryShapeAScannerEmits() {
        assertEquals("046800899000000018", Sscc.parse("046800899000000018"))
        assertEquals("046800899000000018", Sscc.parse("(00)046800899000000018"))
        assertEquals("046800899000000018", Sscc.parse("00046800899000000018"))
        assertEquals("046800899000000018", Sscc.parse("  046800899000000018\r\n"))
    }

    /** A number starting 00 is a real SSCC, not an element string with the AI. */
    @Test
    fun anSsccBeginningWithZerosSurvives() {
        assertEquals("004680089900000001", Sscc.parse("004680089900000001"))
    }

    @Test
    fun anythingThatIsNotAnSsccIsNotGuessedAt() {
        assertNull(Sscc.parse(""))
        assertNull(Sscc.parse("0104600682000013215Y7HG9"))
        assertNull(Sscc.parse("04680089900000001"))
        assertNull(Sscc.parse("04680089900000001X"))
    }
```

- [ ] **Step 3: Write the failing disassemble test**

Create `DisassembleViewModelTest.kt`, driving scans through the same
`MutableSharedFlow<ScanEvent>` + `ScanRouterAdapter` harness the work and
inventory view-model tests use:

```kotlin
package app.markiro.handheld.feature.exceptions

import androidx.lifecycle.SavedStateHandle
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.MainDispatcherRule
import app.markiro.handheld.R
import app.markiro.handheld.core.auth.OperatorRecord
import app.markiro.handheld.core.exceptions.DisassembleReason
import app.markiro.handheld.core.exceptions.ExceptionEngine
import app.markiro.handheld.core.scan.ScanEvent
import app.markiro.handheld.core.scan.ScanRouterAdapter
import app.markiro.handheld.core.storage.BoxEntity
import app.markiro.handheld.core.storage.CodeEntity
import app.markiro.handheld.core.storage.DeviceConfigEntity
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.feature.signin.SessionHolder
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class DisassembleViewModelTest {
    @get:Rule
    val main = MainDispatcherRule()

    private lateinit var db: HandheldDatabase
    private val scans = MutableSharedFlow<ScanEvent>(extraBufferCapacity = 4)
    private val session = SessionHolder().apply {
        signIn(OperatorRecord("op-1", "Иванова Анна", "4127", "operator", "x", null, true))
    }

    @Before
    fun setUp() = runTest {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries().build()
        db.deviceConfigDao().upsert(
            DeviceConfigEntity(
                deviceId = "dev-1", deviceName = "ТСД 1", tenantId = "t", organizationName = "ООО",
                lineId = "l1", lineName = "Линия 2", kind = "handheld", serverUrl = "http://x", pairedAt = 1L,
            ),
        )
    }

    @After
    fun tearDown() = db.close()

    private val sscc = "046800899000000018"

    private suspend fun closedBox(id: String = "box-1", number: String = sscc, units: Int = 2, shiftId: String = "s1") {
        db.boxDao().insert(
            BoxEntity(
                boxId = id, shiftId = shiftId, sscc = number, openedAt = "2026-09-11T07:00:00.000Z",
                closedAt = "2026-09-11T07:30:00.000Z", operatorId = "op-1", printState = "printed",
                printReason = null, ackedAt = null,
            ),
        )
        repeat(units) { n ->
            val hash = "$id-$n".padEnd(64, 'f')
            db.codeDao().insert(CodeEntity(hash, shiftId, "04600000000015", "$n", "2026-09-11T07:0$n:00.000Z", id))
        }
    }

    private fun vm() = main.track(
        DisassembleViewModel(
            db, ExceptionEngine(db), session, ScanRouterAdapter(scans),
            SavedStateHandle(mapOf("shiftId" to "s1")),
        ),
    )

    private suspend fun scan(raw: String) {
        scans.emit(ScanEvent(raw, null, "debug", 0))
    }

    @Test
    fun scanningAClosedBoxLabelAdvancesToTheReason() = runTest {
        closedBox(units = 12)
        val vm = vm()
        vm.step.first { it is DisassembleStep.ScanBox }
        scan("(00)$sscc")
        val step = vm.step.first { it is DisassembleStep.Reason } as DisassembleStep.Reason
        assertEquals("box-1", step.boxId)
        assertEquals(12, step.units)
        assertEquals(sscc, step.sscc)
    }

    @Test
    fun scanningAnUnknownSsccRefuses() = runTest {
        closedBox()
        val vm = vm()
        vm.step.first { it is DisassembleStep.ScanBox }
        scan("046800899000000025")
        assertEquals(
            R.string.disassemble_unknown_sscc,
            (vm.step.first { it is DisassembleStep.Refused } as DisassembleStep.Refused).message,
        )
        assertEquals(0, db.boxExceptionDao().unackedCount())
    }

    /** A unit's own code is not a box label and must not be read as one. */
    @Test
    fun scanningAUnitCodeRefuses() = runTest {
        closedBox()
        val vm = vm()
        vm.step.first { it is DisassembleStep.ScanBox }
        scan("0104600682000013215Y7HG9")
        assertEquals(
            R.string.disassemble_unknown_sscc,
            (vm.step.first { it is DisassembleStep.Refused } as DisassembleStep.Refused).message,
        )
    }

    /** A box of another shift is out of reach: this is the current shift's screen. */
    @Test
    fun aBoxOfAnotherShiftIsNotFound() = runTest {
        closedBox(shiftId = "s2")
        val vm = vm()
        vm.step.first { it is DisassembleStep.ScanBox }
        scan(sscc)
        assertEquals(
            R.string.disassemble_unknown_sscc,
            (vm.step.first { it is DisassembleStep.Refused } as DisassembleStep.Refused).message,
        )
    }

    @Test
    fun confirmingRetiresTheBoxReleasesUnitsAndQueuesTheFact() = runTest {
        closedBox(units = 2)
        val vm = vm()
        vm.step.first { it is DisassembleStep.ScanBox }
        scan(sscc)
        vm.step.first { it is DisassembleStep.Reason }
        vm.chooseReason(DisassembleReason.WRONG_PRODUCT)
        vm.step.first { it is DisassembleStep.Confirm }
        vm.confirm()
        vm.step.first { it is DisassembleStep.Retired }
        assertNotNull(db.boxDao().get("box-1")?.disassembledAt)
        assertEquals(0, db.boxDao().itemCount("box-1"))
        val queued = db.boxExceptionDao().sendable(Long.MAX_VALUE, 10).single()
        assertEquals("disassemble", queued.kind)
        assertEquals("Неверный товар", queued.reason)
        assertEquals("box-1", queued.boxId)
    }

    @Test
    fun aRetiredBoxCannotBeRetiredTwice() = runTest {
        closedBox()
        db.boxDao().markDisassembled("box-1", "2026-09-11T08:00:00.000Z")
        val vm = vm()
        vm.step.first { it is DisassembleStep.ScanBox }
        scan(sscc)
        // A retired box is no longer findable by its number at all.
        assertEquals(
            R.string.disassemble_unknown_sscc,
            (vm.step.first { it is DisassembleStep.Refused } as DisassembleStep.Refused).message,
        )
        assertEquals(0, db.boxExceptionDao().unackedCount())
    }

    /** Nothing is applied until the third step. */
    @Test
    fun leavingAtTheReasonStepQueuesNothing() = runTest {
        closedBox()
        val vm = vm()
        vm.step.first { it is DisassembleStep.ScanBox }
        scan(sscc)
        vm.step.first { it is DisassembleStep.Reason }
        vm.cancel()
        assertEquals(0, db.boxExceptionDao().unackedCount())
        assertNull(db.boxDao().get("box-1")?.disassembledAt)
    }

    /** A second scan while a box is already identified must not re-target the flow. */
    @Test
    fun aScanArrivingAfterTheFirstStepIsIgnored() = runTest {
        closedBox()
        closedBox(id = "box-2", number = "046800899000000025")
        val vm = vm()
        vm.step.first { it is DisassembleStep.ScanBox }
        scan(sscc)
        vm.step.first { it is DisassembleStep.Reason }
        scan("046800899000000025")
        vm.chooseReason(DisassembleReason.WRONG_PRODUCT)
        assertEquals("box-1", (vm.step.first { it is DisassembleStep.Confirm } as DisassembleStep.Confirm).boxId)
    }
}
```

`DisassembleStep.Confirm` carries the same four fields as `Reason` — declare it
as `data class Confirm(val boxId: String, val ordinal: Int, val units: Int, val sscc: String)`.

- [ ] **Step 4: Run it to confirm it fails, then write the view model and screens**

```bash
./gradlew :app:testDebugUnitTest --tests '*DisassembleViewModelTest'
```

`DisassembleViewModel` collects `scans.events`, and **only while the step is
`ScanBox`** resolves the raw value with `Sscc.parse(raw)` then
`db.boxDao().boxIdBySscc(sscc)` — which already excludes retired boxes — and
checks the row's `shiftId` against the handle's. It exposes
`step: StateFlow<DisassembleStep>`, `chooseReason(DisassembleReason)`,
`confirm()`, `cancel()`, and maps `DisassembleResult` to `Retired` /
`Refused(R.string.disassemble_already)` / `Refused(R.string.disassemble_not_closed)`.
Like the list view model, it does not inject `SyncEngine`.

`DisassembleScreens.kt` renders the three steps in the drawn shape: the step
header `disassemble_step`, a large instruction, the explanation, a context card
of what is already identified, and a text «Отмена». Follow
`feature/work/DuplicateScreens.kt` for full-screen step styling.

- [ ] **Step 5: Write the failing reprint test**

Create `ReprintViewModelTest.kt` with the same harness as above, plus the
`BoxPrinter` construction `LabelQueueViewModelTest` already uses:

```kotlin
    @Test
    fun theLastClosedBoxIsOfferedFirst() = runTest {
        closedBox(id = "box-1", number = sscc)
        closedBox(id = "box-2", number = "046800899000000025", closedAt = "2026-09-11T08:30:00.000Z")
        assertEquals("box-2", vm().state.first { it.last != null }.last!!.boxId)
    }

    @Test
    fun aRetiredBoxIsNotOffered() = runTest {
        closedBox(id = "box-1", number = sscc)
        closedBox(id = "box-2", number = "046800899000000025", closedAt = "2026-09-11T08:30:00.000Z")
        db.boxDao().markDisassembled("box-2", "2026-09-11T09:00:00.000Z")
        assertEquals("box-1", vm().state.first { it.last != null }.last!!.boxId)
    }

    @Test
    fun choosingAReasonQueuesTheFactAndPrints() = runTest {
        closedBox(id = "box-1", number = sscc)
        val vm = vm()
        vm.state.first { it.last != null }
        vm.chooseLast()
        vm.chooseReason(ReprintReason.DAMAGED_LABEL)
        vm.state.first { it.done }
        val queued = db.boxExceptionDao().sendable(Long.MAX_VALUE, 10).single()
        assertEquals("reprint", queued.kind)
        assertEquals("Этикетка повреждена", queued.reason)
        assertEquals(listOf("box-1"), transport.printedBoxIds())
    }

    /** Reprint is an audit fact and a print job: no box or item state moves. */
    @Test
    fun reprintChangesNoBoxOrItemState() = runTest {
        closedBox(id = "box-1", number = sscc, units = 3)
        val vm = vm()
        vm.state.first { it.last != null }
        vm.chooseLast()
        vm.chooseReason(ReprintReason.DAMAGED_LABEL)
        vm.state.first { it.done }
        assertNull(db.boxDao().get("box-1")?.disassembledAt)
        assertEquals(3, db.boxDao().itemCount("box-1"))
    }

    @Test
    fun scanningAnSsccSelectsThatBox() = runTest {
        closedBox(id = "box-1", number = sscc)
        closedBox(id = "box-2", number = "046800899000000025", closedAt = "2026-09-11T08:30:00.000Z")
        val vm = vm()
        vm.state.first { it.last != null }
        scan("(00)$sscc")
        assertEquals("box-1", vm.state.first { it.selected != null }.selected!!.boxId)
    }

    /** The ledger records the request even when the printer then refuses. */
    @Test
    fun theFactIsQueuedEvenWhenPrintingFails() = runTest {
        closedBox(id = "box-1", number = sscc)
        transport.failNext()
        val vm = vm()
        vm.state.first { it.last != null }
        vm.chooseLast()
        vm.chooseReason(ReprintReason.PRINTER_JAM)
        vm.state.first { it.done || it.error != null }
        assertEquals(1, db.boxExceptionDao().unackedCount())
    }
```

`transport` is the fake printer transport `LabelQueueViewModelTest` builds;
reuse it rather than writing another, adding `printedBoxIds()` and `failNext()`
to it if it does not already expose them.

`ReprintViewModel` calls `engine.reprint(...)` **before** `printer.print(boxId)`,
so the audit fact exists even if printing then fails — the fact records the
operator's request, not the printer's outcome.

- [ ] **Step 6: Wire the routes**

In `AppNavigation.kt`:

```kotlin
    const val DISASSEMBLE = "exceptions/{shiftId}/disassemble"
    const val REPRINT = "exceptions/{shiftId}/reprint"
    fun disassemble(id: String) = "exceptions/$id/disassemble"
    fun reprint(id: String) = "exceptions/$id/reprint"
```

with `composable` blocks in the shape of the existing ones, and navigate to them
from the exceptions list callbacks added in Task 5.

- [ ] **Step 7: Run the feature and box suites**

```bash
./gradlew :app:testDebugUnitTest --tests '*feature.exceptions*' --tests '*core.box*'
```

Expected: BUILD SUCCESSFUL.

- [ ] **Step 8: Commit**

```bash
git add apps/handheld/app/src/main/kotlin/app/markiro/handheld/feature/exceptions apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/box/Sscc.kt apps/handheld/app/src/main/kotlin/app/markiro/handheld/AppNavigation.kt apps/handheld/app/src/main/res apps/handheld/app/src/test/kotlin/app/markiro/handheld/feature/exceptions apps/handheld/app/src/test/kotlin/app/markiro/handheld/core/box
git commit -m "feat(handheld): расформирование коробов и перепечатка этикетки"
```

---

### Task 7: Print recovery writes its reprint

**Files:**

- Modify: `feature/work/LabelQueueViewModel.kt`, `feature/work/WorkViewModel.kt`,
  `AppNavigation.kt` (the two view models gain constructor arguments Hilt
  supplies; no call-site change is expected, but build to confirm)
- Test: `apps/handheld/app/src/test/kotlin/app/markiro/handheld/feature/work/LabelQueueViewModelTest.kt`
  (extend), `.../WorkViewModelTest.kt` (extend)

**Interfaces:**

- Consumes: `ExceptionEngine.reprint`, `ReprintReason.PRINT_OUTCOME_UNKNOWN`
  (Tasks 1 and 3).

Brief §8 already promises that «Напечатать ещё раз» from an unknown print
outcome is "an explicit same-SSCC reprint, audited as such". The channel to
record it exists only as of this slice.

- [ ] **Step 1: Write the failing test**

`LabelQueueViewModelTest.kt` already has the harness: an in-memory database, a
`box(id, sscc, state)` helper and a `model()` factory building a real
`BoxPrinter` over a fake transport. Add these cases to that file rather than
creating a second harness — the constructor gains one argument, so every test in
it has to be touched anyway.

```kotlin
    /**
     * Brief §8: resolving an unknown outcome by printing again is "an explicit
     * same-SSCC reprint, audited as such". This is where that is kept.
     */
    @Test
    fun printingAgainFromAnUnknownOutcomeWritesAReprint() = runTest {
        box("b1", "046800899000000018", BoxPrint.UNKNOWN)
        val vm = model()
        vm.state.first { it.items.size == 1 }
        vm.printOne("b1")
        advanceUntilIdle()
        val queued = db.boxExceptionDao().sendable(Long.MAX_VALUE, 10).single()
        assertEquals("reprint", queued.kind)
        assertEquals("b1", queued.boxId)
        assertEquals("Результат печати неизвестен", queued.reason)
    }

    /** «Этикетка напечаталась» says the label is already there. Nothing was reprinted. */
    @Test
    fun confirmingTheLabelPrintedWritesNoReprint() = runTest {
        box("b1", "046800899000000018", BoxPrint.UNKNOWN)
        val vm = model()
        vm.state.first { it.items.size == 1 }
        vm.resolveUnknown("b1")
        advanceUntilIdle()
        assertEquals(0, db.boxExceptionDao().unackedCount())
    }

    /**
     * A failed attempt never put paper through the printer, so printing it is an
     * ordinary retry and not a second label to account for.
     */
    @Test
    fun retryingAFailedPrintWritesNoReprint() = runTest {
        box("b1", "046800899000000018", BoxPrint.FAILED)
        val vm = model()
        vm.state.first { it.items.size == 1 }
        vm.printOne("b1")
        advanceUntilIdle()
        assertEquals(0, db.boxExceptionDao().unackedCount())
    }

    /** A deferred label was never sent either. */
    @Test
    fun printingADeferredLabelWritesNoReprint() = runTest {
        box("b1", "046800899000000018", BoxPrint.DEFERRED)
        val vm = model()
        vm.state.first { it.items.size == 1 }
        vm.printOne("b1")
        advanceUntilIdle()
        assertEquals(0, db.boxExceptionDao().unackedCount())
    }
```

Use the real `BoxPrint.UNKNOWN` / `FAILED` / `DEFERRED` constants that file
already imports, and add `ExceptionEngine(db)` plus the device config row the
engine needs to `model()`.

- [ ] **Step 2: Run it to confirm it fails**

```bash
./gradlew :app:testDebugUnitTest --tests '*LabelQueueViewModelTest'
```

Expected: the reprint assertion fails — nothing is queued.

- [ ] **Step 3: Implement**

The decision is not a new code path but a condition on the existing one: printing
a box **whose current `printState` is `unknown`** is the audited reprint. In
`LabelQueueViewModel`, inject `ExceptionEngine`, `SessionHolder` and
`DeviceConfigDao`, and add:

```kotlin
    /**
     * Printing again a box whose last attempt ended `unknown` is an explicit
     * same-SSCC reprint (brief §8) and is recorded as one, with a fixed reason
     * rather than a prompt: the operator is standing at the printer deciding
     * whether paper moved, not filling in a ledger.
     *
     * `failed` and `deferred` never put paper through, so they are ordinary
     * retries and write nothing.
     */
    private suspend fun auditIfOutcomeUnknown(boxId: String) {
        val box = boxes.get(boxId) ?: return
        if (box.printState != BoxPrint.UNKNOWN) return
        engine.reprint(
            shiftId = box.shiftId,
            boxId = boxId,
            reason = ReprintReason.PRINT_OUTCOME_UNKNOWN,
            operatorId = session.state.value.operator?.operatorId,
            terminalId = config.get()?.deviceId,
        )
    }
```

and call it first inside `printOne`:

```kotlin
    fun printOne(boxId: String) = runPrint {
        auditIfOutcomeUnknown(boxId)
        printer.print(boxId)
    }
```

`printAll` needs no change: it already skips every `unknown` item by design.

Apply the same one-line audit to `WorkViewModel::retryPrint`, which is the
«Напечатать ещё раз» action of the box-close screen's unknown state. Use
`BoxRepository.get(boxId)` if it exists; if it does not, add
`@Query("SELECT * FROM boxes WHERE boxId = :boxId") suspend fun get(boxId: String): BoxEntity?`
usage through the repository rather than reaching into the DAO from a view model.

- [ ] **Step 4: Run the suite**

```bash
./gradlew :app:testDebugUnitTest --tests '*feature.work*'
```

Expected: BUILD SUCCESSFUL.

- [ ] **Step 5: Run every gate**

```bash
./gradlew :app:testDebugUnitTest :app:lintDebug :app:assembleDebug
```

Expected: BUILD SUCCESSFUL with no warnings.

- [ ] **Step 6: Commit**

```bash
git add apps/handheld/app/src/main/kotlin/app/markiro/handheld/feature/work apps/handheld/app/src/test/kotlin/app/markiro/handheld/feature/work
git commit -m "feat(handheld): повторная печать из неизвестного результата пишется в аудит"
```

---

## The manual walk-through is not optional

Run the app on an emulator against a real API before opening the PR. The
duplicate slice's walk-through found four defects that every unit test had
passed, including a wedged queue of exactly the kind this plan's wire-shape
section is written against. Build a logging proxy between the emulator and the
API and read the actual request bodies.

Walk these, confirming after each that the server answered 2xx and that
`box_exceptions` drained to zero:

1. Aggregation shift, scan three units, undo the last one. Rescan the same code —
   it must be accepted, not reported as a duplicate.
2. Undo, then look at the request body: `codeHash` and `targetScannedAt` present,
   `reason` present and `null`.
3. Clear a box holding units. The fill grid empties, the box stays open.
4. Clear an empty box — the action is unavailable and says why.
5. Close a box, disassemble it with a reason. It leaves the reprint list and the
   deferred-label queue; its SSCC is never issued again.
6. Disassemble the same box twice (navigate back and repeat) — one queued fact.
7. Reprint a closed box's label. The label prints and one `reprint` fact goes out.
8. Turn off networking, do an undo and a clear, queue twenty more scans, turn
   networking back on. Every fact arrives, and the undo's effect is visible
   server-side — not merely recorded.
9. Force an unknown print outcome (kill the printer connection mid-job), then
   choose «Напечатать ещё раз». A `reprint` fact with the fixed reason goes out.
10. Kill the app between confirming a correction and the drain. On restart the
    fact is still queued and still leaves.

Point 8 is the one this plan's ordering section exists for. If the undo's target
unit is still in the box server-side after that walk, the watermark is wrong.

## What this plan cannot prove

- **A real handheld.** The emulator has no vendor scanner service. Scanning an
  SSCC label through DataWedge, and the trigger behaviour of the stepper's scan
  steps, need a physical device.
- **A real printer.** The reprint path hands bytes to `BoxPrinter`; whether
  paper moves is a Bluetooth/Wi-Fi fact this suite never touches.
- **The station's equivalent ordering gap.** The spec records it; nothing here
  fixes or tests it.
- **Cross-device behaviour.** A code released here while another terminal holds
  it is the server's business, covered by the server's own tests, not reachable
  from one handheld.
