package app.markiro.handheld.feature.shift

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.storage.CodeEntity
import app.markiro.handheld.core.storage.DeviceConfigEntity
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.ScanEventEntity
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ShiftCloserTest {
    private lateinit var db: HandheldDatabase

    @Before
    fun setUp() = runTest {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries()
            .build()
        db.deviceConfigDao().upsert(
            DeviceConfigEntity(
                deviceId = "dev-1", deviceName = "ТСД", tenantId = "t", organizationName = "ООО", lineId = "l1", lineName = "Линия 2",
                kind = "handheld", serverUrl = "http://x", pairedAt = 1L, activeShiftId = "s1",
            ),
        )
        db.shiftDao().upsert(ShiftEntityFixtures.bundled("s1").copy(plannedQty = 3))
        db.codeDao().insert(CodeEntity("h1", "s1", "04600682000013", "a", "2026-09-10T10:00:00.000Z"))
        db.codeDao().insert(CodeEntity("h2", "s1", "04600682000013", "b", "2026-09-10T10:01:00.000Z"))
        db.scanEventDao().insert(ScanEventEntity(shiftId = "s1", raw = "x", verdict = "invalid", scannedAt = "t", operatorId = null, codeHash = null))
    }

    @After
    fun tearDown() = db.close()

    @Test
    fun previewCountsAndRequiresAReasonWhenThePlanIsMissed() = runTest {
        val p = ShiftCloser(db).preview("s1")!!
        assertEquals(2, p.accepted)
        assertEquals(1, p.errors)
        assertEquals(3, p.plan)
        assertTrue(p.reasonRequired)
        db.shiftDao().upsert(ShiftEntityFixtures.bundled("s1").copy(plannedQty = null))
        assertFalse(ShiftCloser(db).preview("s1")!!.reasonRequired)
    }

    @Test
    fun closeWritesOnePendingRowClosesLocallyAndClearsTheActiveShift() = runTest {
        val closer = ShiftCloser(db) { 1_757_500_000_000L }
        val row = closer.close("s1", "op-1", "material_shortage")
        assertEquals("pending", row.state)
        assertEquals(3, row.plannedQtySnapshot)
        assertEquals(2, row.actualQty)
        assertEquals("material_shortage", row.reasonCode)
        assertEquals("closed", db.shiftDao().get("s1")?.status)
        assertNull(db.deviceConfigDao().get()?.activeShiftId)
        val again = closer.close("s1", "op-1", "equipment_stop")
        assertEquals(row.eventId, again.eventId)
    }

    @Test
    fun closeRefusesAMissingReasonWhenRequired() = runTest {
        val result = runCatching { ShiftCloser(db).close("s1", null, null) }
        assertTrue(result.exceptionOrNull() is IllegalArgumentException)
        assertNull(db.shiftCloseDao().forShift("s1"))
        assertEquals("active", db.shiftDao().get("s1")?.status)
    }
}
