package app.markiro.handheld.core.scan

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.km.KmCodec
import app.markiro.handheld.core.km.Verdict
import app.markiro.handheld.core.storage.CodeEntity
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.ShiftEntity
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
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
class ScanRecorderTest {
    private lateinit var db: HandheldDatabase
    private var clock = 1_757_500_000_000L
    private val gs = "\u001d"
    private val shift = ShiftEntity(
        id = "s1", number = "SEP26-001", status = "active", mode = "validation", productId = "p1",
        productName = "Вода", productPrintName = null, productGtin14 = "04600682000013", lineId = "l1", lineName = "Линия 2",
        counterpartyName = null, plannedQty = 100, plannedDate = "2026-09-10", productionDate = null,
        boxCapacity = null, palletCapacity = null, palletsEnabled = false, validationPrintMode = "none",
        closePolicyKind = null, closeOwnerDeviceId = null, openedAt = null, listFetchedAt = 1L, bundleFetchedAt = 1L,
    )

    @Before
    fun open() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries()
            .build()
    }

    @After
    fun close() = db.close()

    private fun recorder() = ScanRecorder(db) { clock }

    @Test
    fun acceptsThenFlagsTheSameCodeAsDuplicateWithFirstSeen() = runTest {
        val r = recorder()
        val first = r.record(shift, "010460068200001321abc${gs}93AAAA", "op-1")
        assertEquals(Verdict.OK, first.verdict)
        assertEquals("abc", first.km?.serial)
        clock += 60_000
        val second = r.record(shift, "010460068200001321abc${gs}93BBBB", "op-1")
        assertEquals(Verdict.DUPLICATE, second.verdict)
        assertEquals(first.scannedAt, second.firstSeenAt)
        val outbox = db.outboxDao().head(10)
        assertEquals(listOf("ok", "duplicate"), outbox.map { it.verdict })
        assertNotNull(outbox[0].codeHash)
        assertNull(outbox[1].codeHash)
        assertEquals(1, db.codeDao().countForShift("s1"))
        assertEquals(2, db.scanEventDao().observeRecent("s1", 10).first().size)
    }

    @Test
    fun wrongGtinAndGarbageAreJournaledWithoutCodes() = runTest {
        val r = recorder()
        assertEquals(Verdict.WRONG_GTIN, r.record(shift, "010460000000001521x", null).verdict)
        assertEquals(Verdict.INVALID, r.record(shift, "hello", null).verdict)
        assertEquals(0, db.codeDao().countForShift("s1"))
        assertEquals(listOf("wrong_gtin", "invalid"), db.outboxDao().head(10).map { it.verdict })
        assertEquals(1, db.scanEventDao().count("s1", "invalid"))
    }

    @Test
    fun aCodeAlreadyInTheMirrorFromAnotherShiftIsADuplicate() = runTest {
        val r = recorder()
        val km = KmCodec.canonicalize("010460068200001321zzz")
        db.codeDao().insert(CodeEntity(KmCodec.hash(km), "other", km.gtin14, km.serial, "2026-09-01T00:00:00.000Z"))
        val outcome = r.record(shift, "010460068200001321zzz", null)
        assertEquals(Verdict.DUPLICATE, outcome.verdict)
        assertEquals("2026-09-01T00:00:00.000Z", outcome.firstSeenAt)
    }

    @Test
    fun concurrentScansOfOneCodeAcceptExactlyOnce() = runTest {
        val r = recorder()
        val outcomes = (1..20).map { async { r.record(shift, "010460068200001321race", null) } }.awaitAll()
        assertEquals(1, outcomes.count { it.verdict == Verdict.OK })
        assertEquals(19, outcomes.count { it.verdict == Verdict.DUPLICATE })
        assertEquals(1, db.codeDao().countForShift("s1"))
        assertEquals(20, db.outboxDao().countNow())
    }
}
