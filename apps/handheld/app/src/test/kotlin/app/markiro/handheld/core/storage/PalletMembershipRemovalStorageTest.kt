package app.markiro.handheld.core.storage

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class PalletMembershipRemovalStorageTest {
    private lateinit var db: HandheldDatabase

    @Before
    fun open() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries()
            .build()
    }

    @After
    fun close() = db.close()

    private fun row(palletId: String = "w1", sscc: String = "034600682000000018", status: String = RemovalStatus.PENDING) =
        PalletMembershipRemovalEntity(
            palletId = palletId,
            sscc = sscc,
            removedAt = "2026-09-18T08:00:00.000Z",
            operatorId = "op-1",
            status = status,
        )

    @Test
    fun pendingForFindsTheOnePendingRowForAKeyEvenWithAnOlderSentRowPresent() = runTest {
        val dao = db.palletMembershipRemovalDao()
        dao.insert(row(status = RemovalStatus.SENT))
        val pendingId = dao.insert(row())

        val found = dao.pendingFor("w1", "034600682000000018")
        assertEquals(pendingId, found?.id)
    }

    @Test
    fun markSentThenPendingForReturnsNullWhileQueuedForCountsBothRows() = runTest {
        val dao = db.palletMembershipRemovalDao()
        dao.insert(row(status = RemovalStatus.SENT))
        val pendingId = dao.insert(row())

        dao.markSent(pendingId)

        assertNull(dao.pendingFor("w1", "034600682000000018"))
        assertEquals(2, dao.queuedFor("034600682000000018"))
    }

    @Test
    fun revertSentBringsARowBackToPending() = runTest {
        val dao = db.palletMembershipRemovalDao()
        val id = dao.insert(row())
        dao.markSent(id)
        assertEquals(0, dao.pending(10).size)

        dao.revertSent()

        assertEquals(1, dao.pending(10).size)
        assertEquals(RemovalStatus.PENDING, dao.pending(10).first().status)
    }

    @Test
    fun deleteRemovesTheRowById() = runTest {
        val dao = db.palletMembershipRemovalDao()
        val id = dao.insert(row())

        dao.delete(id)

        assertEquals(0, dao.all().size)
    }

    @Test
    fun observePendingCountCountsPendingAndSentButNotDeleted() = runTest {
        val dao = db.palletMembershipRemovalDao()
        val pendingId = dao.insert(row())
        val sentId = dao.insert(row(sscc = "034600682000000019"))
        dao.markSent(sentId)

        assertEquals(2, dao.observePendingCount().first())

        dao.delete(pendingId)

        assertEquals(1, dao.observePendingCount().first())
    }

    @Test
    fun clearWipesEveryRow() = runTest {
        val dao = db.palletMembershipRemovalDao()
        dao.insert(row())
        dao.insert(row(sscc = "034600682000000019"))

        dao.clear()

        assertEquals(0, dao.all().size)
    }

    @Test
    fun clearPalletFreesTheRegistryMirrorRow() = runTest {
        val registry = db.boxRegistryDao()
        registry.upsert(
            BoxRegistryEntity(
                sscc = "034600682000000018",
                boxId = "b1",
                productId = "prod-1",
                bottleCount = 12,
                contentKeysJson = "[]",
                updatedAt = "2026-09-18T08:00:00.000Z",
                palletId = "w1",
                palletSscc = "134600682000000017",
                palletActive = true,
            ),
        )

        registry.clearPallet("034600682000000018")

        val after = registry.bySscc("034600682000000018")!!
        assertNull(after.palletId)
        assertNull(after.palletSscc)
        assertEquals(false, after.palletActive)
    }

    private fun pallet(id: String, closedAt: String? = null) = PalletEntity(
        palletId = id,
        shiftId = null,
        terminalId = "dev-1",
        sscc = null,
        openedAt = "2026-09-18T08:00:00.000Z",
        closedAt = closedAt,
        operatorId = null,
        printState = PalletPrint.PENDING,
        printReason = null,
        ackedAt = null,
        kind = PalletKind.WAREHOUSE,
        productId = "prod-1",
        deviceId = "dev-1",
    )

    @Test
    fun deleteRemovesAnOpenPallet() = runTest {
        val dao = db.palletDao()
        dao.insert(pallet("w1"))

        val deleted = dao.delete("w1")

        assertEquals(1, deleted)
        assertNull(dao.get("w1"))
    }

    @Test
    fun deleteLeavesAClosedPalletAlone() = runTest {
        val dao = db.palletDao()
        dao.insert(pallet("w1", closedAt = "2026-09-18T09:00:00.000Z"))

        val deleted = dao.delete("w1")

        assertEquals(0, deleted)
        assertEquals("w1", dao.get("w1")?.palletId)
    }
}
