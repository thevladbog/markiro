package app.markiro.handheld.core.storage

import android.database.sqlite.SQLiteConstraintException
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ShiftStorageTest {
    private lateinit var db: HandheldDatabase

    @Before
    fun open() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries()
            .build()
    }

    @After
    fun close() = db.close()

    private fun outboxRow(raw: String, verdict: String = "ok") = OutboxEntity(
        shiftId = "s1",
        raw = raw,
        verdict = verdict,
        scannedAt = "2026-09-10T10:00:00.000Z",
        operatorId = null,
        codeHash = if (verdict == "ok") "a".repeat(64) else null,
        gtin14 = if (verdict == "ok") "04600682000013" else null,
        serial = if (verdict == "ok") raw else null,
    )

    @Test
    fun outboxIdsAreStrictlyIncreasingEvenAfterDeletes() = runTest {
        val outbox = db.outboxDao()
        outbox.insert(outboxRow("a"))
        outbox.insert(outboxRow("b"))
        outbox.deleteThrough(2)
        outbox.insert(outboxRow("c"))
        val rows = outbox.head(10)
        assertEquals(listOf("c"), rows.map { it.raw })
        assertTrue(rows.single().id > 2)
    }

    @Test
    fun headThroughReturnsOnlyRowsUpToTheCeiling() = runTest {
        val outbox = db.outboxDao()
        repeat(5) { outbox.insert(outboxRow("r$it")) }
        val ceiling = outbox.head(3).last().id
        outbox.insert(outboxRow("late"))
        assertEquals(listOf("r0", "r1", "r2"), outbox.headThrough(ceiling, 100).map { it.raw })
        assertEquals(6, outbox.count().first())
    }

    @Test
    fun codeHashIsAPrimaryKeyAcrossShifts() = runTest {
        val codes = db.codeDao()
        codes.insert(CodeEntity("h1", "s1", "04600682000013", "x", "2026-09-10T10:00:00.000Z"))
        val again = runCatching { codes.insert(CodeEntity("h1", "s2", "04600682000013", "x", "2026-09-10T11:00:00.000Z")) }
        assertTrue(again.exceptionOrNull() is SQLiteConstraintException)
        assertEquals("2026-09-10T10:00:00.000Z", codes.get("h1")?.scannedAt)
        assertEquals(1, codes.countForShift("s1"))
        assertEquals(0, codes.countForShift("s2"))
    }

    @Test
    fun shiftCloseIsUniquePerShift() = runTest {
        val closes = db.shiftCloseDao()
        closes.insert(ShiftCloseEntity("e1", "s1", null, 10, 8, 0, "material_shortage", "2026-09-10T12:00:00.000Z", "pending", null, null))
        val second = runCatching {
            closes.insert(ShiftCloseEntity("e2", "s1", null, 10, 9, 0, null, "2026-09-10T12:01:00.000Z", "pending", null, null))
        }
        assertTrue(second.exceptionOrNull() is SQLiteConstraintException)
        assertEquals("e1", closes.forShift("s1")?.eventId)
        closes.markConflict("e1", "multiple_devices", "2026-09-10T12:02:00.000Z")
        assertEquals("conflict", closes.forShift("s1")?.state)
        assertTrue(closes.pending().isEmpty())
    }

    @Test
    fun metaStoreCreatesOneInstallIdAndKeepsIt() = runTest {
        db.initializeRecoveryForTest()
        val meta = MetaStore(db)
        val first = meta.installId()
        assertEquals(first, meta.installId())
        assertEquals(36, first.length)
        meta.put("k", "v")
        assertEquals("v", meta.get("k"))
        meta.remove("k")
        assertNull(meta.get("k"))
        assertNotEquals("", first)
    }

    @Test
    fun rejectionPreservesEveryTable() = runTest {
        db.shiftDao().upsert(sampleShift())
        db.codeDao().insert(CodeEntity("h1", "s1", "04600682000013", "x", "2026-09-10T10:00:00.000Z"))
        db.outboxDao().insert(outboxRow("a"))
        db.conflictDao().insertIgnore(listOf(ConflictEntity("h9", null, "2026-09-10T09:00:00.000Z", "2026-09-10T10:00:00.000Z")))
        db.metaDao().put(MetaEntity("install_id", "id"))
        DeviceRecovery(db, InMemoryCredentialStore()).initialize()
        assertEquals(listOf(sampleShift()), db.shiftDao().all())
        assertEquals("h1", db.codeDao().get("h1")?.codeHash)
        assertEquals(1, db.outboxDao().count().first())
        assertEquals(1, db.conflictDao().count().first())
        assertEquals("id", db.metaDao().get("install_id"))
    }

    private fun sampleShift() = ShiftEntity(
        id = "s1", number = "SEP26-001", status = "planned", mode = "validation", productId = "p1",
        productName = "Вода", productPrintName = null, productGtin14 = null, lineId = "l1", lineName = "Линия 2",
        counterpartyName = null, plannedQty = 100, plannedDate = "2026-09-10", productionDate = null,
        boxCapacity = null, palletBoxCapacity = null, palletsEnabled = false, validationPrintMode = "none",
        closePolicyKind = null, closeOwnerDeviceId = null, openedAt = null, listFetchedAt = 1L,
    )
}
