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

    private val at = "2026-09-10T10:00:00.000Z"

    private suspend fun accept(hash: String, shiftId: String) =
        db.codeDao().insert(CodeEntity(hash, shiftId, "04600682000013", hash, at))

    /** The scan of [hash] as the host sync freezes it: an `outbox` row and its `host_outbox` record in [state] (`queued` or `quarantined`). */
    private suspend fun frozenScan(hash: String, shiftId: String, state: String) {
        val id = db.outboxDao().insert(
            OutboxEntity(shiftId = shiftId, raw = hash, verdict = "ok", scannedAt = at, operatorId = null, codeHash = hash, gtin14 = "04600682000013", serial = hash),
        )
        db.hostOutboxDao().insert(
            HostOutboxEntity(
                recordId = "rec-$hash", target = "facts", kind = "scan", sourceKind = "scan", sourceKey = id.toString(), body = "{}",
                state = state, reason = if (state == "quarantined") "validation_failed" else null, createdAt = at,
            ),
        )
    }

    @Test
    fun theCodesTheHostGaveToAnotherTerminalAreCountedAsLostOfTheirOwnShiftOnly() = runTest {
        val codes = db.codeDao()
        listOf("h1", "h2", "h3").forEach { accept(it, "s1") }
        accept("h4", "s2")
        // h1 is lost in s1; h4 in s2; h9 is a conflict this device holds no code for.
        db.conflictDao().insertIgnore(listOf("h1", "h4", "h9").map { ConflictEntity(it, null, "2026-09-10T09:00:00.000Z", "2026-09-10T10:00:00.000Z") })
        assertEquals(3, codes.countForShift("s1"))
        assertEquals(1, codes.lostForShift("s1"))
        assertEquals(1, codes.lostForShift("s2"))
        assertEquals(0, codes.lostForShift("s3"))
    }

    @Test
    fun aCodeTheHostRefusedAndHoldsQuarantinedIsLostOfItsOwnShift() = runTest {
        accept("r1", "s1")
        accept("r2", "s1")
        accept("r3", "s1")
        accept("r4", "s2")
        // r1: rejected (quarantined); r2: still queued (the host has not answered); r4: rejected, but in another shift.
        frozenScan("r1", "s1", "quarantined")
        frozenScan("r2", "s1", "queued")
        frozenScan("r4", "s2", "quarantined")
        assertEquals(1, db.codeDao().lostForShift("s1"))
        assertEquals(1, db.codeDao().lostForShift("s2"))
        // The conflict kind and the rejected kind add up; one code in both is counted once.
        db.conflictDao().insertIgnore(listOf(ConflictEntity("r3", null, at, at), ConflictEntity("r1", null, at, at)))
        assertEquals(2, db.codeDao().lostForShift("s1"))
    }

    @Test
    fun aHashAcceptedInAnotherShiftIsNeverLostHere() = runTest {
        // The code belongs to s2 (its scan conflicted there); s1 only holds a reprocessed occurrence of the same hash, which is no scan of s1's own.
        accept("x1", "s2")
        db.conflictDao().insertIgnore(listOf(ConflictEntity("x1", null, at, at)))
        db.validationDao().insert(ValidationOccurrenceEntity("s1", "x1", at, "raw", "04600682000013", "x1", "op", "d1", "s2", "OLD-001", "reprocessed"))
        assertEquals(1, db.codeDao().countForShift("s1"))
        assertEquals(0, db.codeDao().lostForShift("s1"))
        assertEquals(1, db.codeDao().lostForShift("s2"))
        // The same for a rejected scan of another shift.
        accept("x2", "s2")
        frozenScan("x2", "s2", "quarantined")
        db.validationDao().insert(ValidationOccurrenceEntity("s1", "x2", at, "raw", "04600682000013", "x2", "op", "d1", "s2", "OLD-001", "reprocessed"))
        assertEquals(0, db.codeDao().lostForShift("s1"))
        assertEquals(2, db.codeDao().lostForShift("s2"))
    }
}
