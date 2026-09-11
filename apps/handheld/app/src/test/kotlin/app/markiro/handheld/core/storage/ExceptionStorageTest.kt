package app.markiro.handheld.core.storage

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.flow.first
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
        db.boxExceptionDao().markAcked(
            db.boxExceptionDao().sendable(Long.MAX_VALUE, 10).map { it.id },
            "2026-09-11T09:00:00.000Z",
        )
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

    /** A retired box stops asking for its label too. */
    @Test
    fun aDisassembledBoxLeavesTheDeferredLabelQueue() = runTest {
        db.boxDao().insert(box("box-1", acked = true).copy(printState = "deferred"))
        assertEquals(1, db.boxDao().observeUnprintedCount().first())
        db.boxDao().markDisassembled("box-1", "2026-09-11T08:10:00.000Z")
        assertEquals(0, db.boxDao().observeUnprintedCount().first())
    }

    @Test
    fun aWipeLeavesNoException() = runTest {
        db.boxExceptionDao().insert(fact("undo"))
        db.boxExceptionDao().clear()
        assertEquals(0, db.boxExceptionDao().unackedCount())
        assertNull(db.boxDao().get("box-1"))
    }

    /** Only a settled fact is dropped; one still owed survives the purge. */
    @Test
    fun purgingKeepsWhatIsStillOwed() = runTest {
        db.boxExceptionDao().insert(fact("undo"))
        db.boxExceptionDao().insert(fact("clear"))
        db.boxExceptionDao().markAcked(listOf(1L), "2026-09-11T09:00:00.000Z")
        db.boxExceptionDao().purgeAcked()
        assertEquals(listOf("clear"), db.boxExceptionDao().sendable(Long.MAX_VALUE, 10).map { it.kind })
    }
}
