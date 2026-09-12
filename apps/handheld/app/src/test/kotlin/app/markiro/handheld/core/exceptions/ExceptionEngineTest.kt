package app.markiro.handheld.core.exceptions

import app.markiro.handheld.core.storage.initializeRecoveryForTest
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.storage.BoxEntity
import app.markiro.handheld.core.storage.CodeEntity
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.OutboxEntity
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
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
    private val now = 1_757_577_600_000L
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
        db.initializeRecoveryForTest()
    }

    @After
    fun tearDown() = db.close()

    /** Closed and acknowledged: a reprint or a disassembly only ever names such a box. */
    private suspend fun closeAndAck(boxId: String = "box-1") {
        db.boxDao().close(boxId, "000000000000000017", "2026-09-11T08:00:00.000Z", "op-1")
        db.boxDao().markAcked(listOf(boxId), "2026-09-11T08:00:05.000Z")
    }

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
        assertEquals(b, Json.parseToJsonElement(queued.payloadJson).jsonObject["codeHash"]!!.jsonPrimitive.content)
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
        assertEquals(
            db.outboxDao().maxId(),
            db.boxExceptionDao().sendable(Long.MAX_VALUE, 10).single().afterOutboxId,
        )
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
        closeAndAck()
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
        closeAndAck()
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
        closeAndAck()
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
        closeAndAck()
        engine.reprint("s1", "box-1", ReprintReason.PRINTER_JAM, "op-1", "dev-1")
        for (row in db.boxExceptionDao().sendable(Long.MAX_VALUE, 10)) {
            assertTrue(row.kind, Json.parseToJsonElement(row.payloadJson).jsonObject.keys.size == 9)
        }
    }
}
